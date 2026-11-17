from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, HttpUrl, field_validator
from sqlalchemy.orm import Session
from typing import List, Optional
from database import get_db, Video, Sentence, User, PlaylistVideo, LearningProgress
from auth import get_current_user
from services.audio_files import ensure_seekable_audio, remove_unreferenced_audio
from services.youtube_processor import YouTubeProcessor
from services.qdrant_client import delete_sentence_vectors_for_video, ingest_sentences_for_video
import re
import os

router = APIRouter()

# Lazy init: importing this module must not mkdir under backend/ (read-only in AppImage / deb).
_processor: Optional[YouTubeProcessor] = None


def _get_youtube_processor() -> YouTubeProcessor:
    global _processor
    if _processor is None:
        _processor = YouTubeProcessor()
    return _processor


class YouTubeUrlRequest(BaseModel):
    url: str

    @field_validator('url')
    @classmethod
    def validate_url(cls, v):
        """Validate and normalize YouTube URL (strip whitespace and trailing punctuation)."""
        v = v.strip().rstrip(',;')
        youtube_pattern = re.compile(
            r'(https?://)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)/'
            r'(watch\?v=|embed/|v/|.+\?v=)?([^&=%\?]{11})'
        )
        if not youtube_pattern.match(v):
            raise ValueError("Invalid YouTube URL")
        return v


class VideoResponse(BaseModel):
    id: int
    youtube_url: str
    title: Optional[str]
    duration: Optional[float]
    audio_file_path: Optional[str]
    created_at: str
    sentence_count: int

    class Config:
        from_attributes = True


class SentenceResponse(BaseModel):
    id: int
    sentence_text: str
    start_time: float
    end_time: float
    sentence_index: int

    class Config:
        from_attributes = True


class ProcessVideoResponse(BaseModel):
    video_id: int
    title: str
    duration: float
    sentence_count: int
    message: str


@router.post("/youtube/process", response_model=ProcessVideoResponse)
async def process_youtube_video(
    request: YouTubeUrlRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Process a YouTube video: extract subtitles and segment into sentences"""
    try:
        result = _get_youtube_processor().process_youtube_video(
            request.url, db, user_id=current_user.id
        )

        # Kick off background ingestion of sentences into Qdrant.
        video_id = result.get("video_id")
        if isinstance(video_id, int):
            background_tasks.add_task(
                ingest_sentences_for_video,
                video_id=video_id,
                user_id=current_user.id,
            )

        return ProcessVideoResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        if is_youtube_block_error(str(e)):
            raise HTTPException(status_code=503, detail=YOUTUBE_BLOCKED_MESSAGE)
        raise HTTPException(status_code=500, detail=f"Failed to process video: {str(e)}")


# What yt-dlp says when YouTube refuses a request outright, as it does for the
# datacenter IPs that web hosts use. It says nothing about the video itself.
_YOUTUBE_BLOCK_MARKERS = (
    "failed to extract any player response",
    "sign in to confirm you",
    "confirm you're not a bot",
    "http error 429",
)

YOUTUBE_BLOCKED_MESSAGE = (
    "YouTube is blocking this server, so videos can't be imported here. "
    "Use Custom Text (TTS) instead, or import the video in the desktop app."
)


def is_youtube_block_error(message: str) -> bool:
    lowered = message.lower().replace("’", "'")
    return any(marker in lowered for marker in _YOUTUBE_BLOCK_MARKERS)


@router.get("/youtube/videos", response_model=List[VideoResponse])
async def get_videos(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get all processed videos for the current user (excludes soft-deleted)"""
    videos = db.query(Video).filter(
        Video.user_id == current_user.id,
        Video.deleted_at.is_(None),
    ).offset(skip).limit(limit).all()
    result = []
    for video in videos:
        sentence_count = db.query(Sentence).filter(Sentence.video_id == video.id).count()
        result.append({
            **video.__dict__,
            'sentence_count': sentence_count,
            'created_at': video.created_at.isoformat() if video.created_at else None
        })
    return result


@router.get("/youtube/videos/{video_id}", response_model=VideoResponse)
async def get_video(
    video_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific video"""
    video = db.query(Video).filter(
        Video.id == video_id,
        Video.user_id == current_user.id,
        Video.deleted_at.is_(None),
    ).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    sentence_count = db.query(Sentence).filter(Sentence.video_id == video.id).count()
    return {
        **video.__dict__,
        'sentence_count': sentence_count,
        'created_at': video.created_at.isoformat() if video.created_at else None
    }


@router.get("/youtube/videos/{video_id}/sentences", response_model=List[SentenceResponse])
async def get_video_sentences(
    video_id: int,
    skip: int = 0,
    limit: int = 1000,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get sentences for a specific video"""
    video = db.query(Video).filter(
        Video.id == video_id,
        Video.user_id == current_user.id,
        Video.deleted_at.is_(None),
    ).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    sentences = db.query(Sentence).filter(
        Sentence.video_id == video_id
    ).order_by(Sentence.sentence_index).offset(skip).limit(limit).all()

    return sentences


def _audio_media_type_for_path(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".mp3":
        return "audio/mpeg"
    if ext in (".m4a", ".mp4"):
        return "audio/mp4"
    if ext == ".webm":
        return "audio/webm"
    if ext in (".ogg", ".opus"):
        return "audio/ogg"
    return "application/octet-stream"


def _serve_audio_with_range(path: str, request: Request, media_type: str, filename: str):
    """Serve file with Range support so the browser can seek (currentTime)."""
    size = os.path.getsize(path)
    range_header = request.headers.get("range")
    if not range_header or not range_header.strip().lower().startswith("bytes="):
        return FileResponse(
            path,
            media_type=media_type,
            filename=filename,
            headers={"Accept-Ranges": "bytes"},
        )
    try:
        parts = range_header.strip()[6:].split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if len(parts) > 1 and parts[1] else size - 1
        if start >= size:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        end = min(end, size - 1)
        length = end - start + 1
        with open(path, "rb") as f:
            f.seek(start)
            body = f.read(length)
        return Response(
            status_code=206,
            content=body,
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(length),
            },
        )
    except (ValueError, IndexError):
        return FileResponse(path, media_type=media_type, filename=filename, headers={"Accept-Ranges": "bytes"})


@router.get("/youtube/videos/{video_id}/audio")
async def get_video_audio(
    video_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the audio file for a specific video. Supports Range requests for seeking."""
    video = db.query(Video).filter(
        Video.id == video_id,
        Video.user_id == current_user.id,
        Video.deleted_at.is_(None),
    ).first()

    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if not video.audio_file_path or not os.path.exists(video.audio_file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    # Lessons from before the M4A switch get their MP3 converted the first time
    # they are opened; FFmpeg takes a few seconds, so keep it off the event loop.
    audio_path = await run_in_threadpool(ensure_seekable_audio, db, video.audio_file_path)

    return _serve_audio_with_range(
        audio_path,
        request,
        media_type=_audio_media_type_for_path(audio_path),
        filename=os.path.basename(audio_path),
    )


@router.delete("/youtube/videos/{video_id}")
async def delete_video(
    video_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete a video: remove from playlists, delete subtitle rows and audio file,
    clear vector index for this lesson. Video row and learning/session history stay for analysis."""
    video = db.query(Video).filter(
        Video.id == video_id,
        Video.user_id == current_user.id,
        Video.deleted_at.is_(None),
    ).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Remove from all playlists (lesson no longer visible)
    db.query(PlaylistVideo).filter(PlaylistVideo.video_id == video_id).delete()

    db.query(LearningProgress).filter(LearningProgress.video_id == video_id).update(
        {LearningProgress.sentence_id: None},
        synchronize_session=False,
    )

    db.query(Sentence).filter(Sentence.video_id == video_id).delete(
        synchronize_session=False
    )

    old_audio = video.audio_file_path
    video.audio_file_path = None

    from datetime import datetime

    video.deleted_at = datetime.utcnow()
    db.commit()
    # Another account's copy of this lesson may still play the same file.
    remove_unreferenced_audio(db, [old_audio])

    delete_sentence_vectors_for_video(video_id)

    return {"message": "Lesson removed. Learning data preserved for analysis."}


class CustomTextRequest(BaseModel):
    title: str
    text: str


MAX_CUSTOM_TITLE_CHARS = 200
MAX_CUSTOM_TEXT_CHARS = 20_000
# A sentence is typed from memory and sent to Text-to-Speech in one request
# (which takes 1500 characters at most), so anything longer is cut further.
MAX_CUSTOM_SENTENCE_CHARS = 300


def _split_long_chunk(words: List[str]) -> List[List[str]]:
    """Cut a sentence longer than MAX_CUSTOM_SENTENCE_CHARS, at a comma where there is one."""
    limit = MAX_CUSTOM_SENTENCE_CHARS
    pieces: List[str] = []
    for word in words:
        # A single "word" past the limit (a URL, a line with no spaces).
        pieces.extend(word[i:i + limit] for i in range(0, len(word), limit))

    chunks: List[List[str]] = []
    current: List[str] = []
    length = 0
    after_comma = 0  # where to cut `current` so it ends at its last comma
    for word in pieces:
        if current and length + 1 + len(word) > limit:
            cut = after_comma or len(current)
            chunks.append(current[:cut])
            current = current[cut:]
            length = len(" ".join(current))
            after_comma = 0
            if current and length + 1 + len(word) > limit:
                chunks.append(current)
                current, length = [], 0
        current.append(word)
        length += len(word) + (1 if len(current) > 1 else 0)
        if word.endswith(","):
            after_comma = len(current)
    if current:
        chunks.append(current)
    return chunks


def split_custom_text(raw_text: str) -> List[str]:
    """Pasted text as sentences to dictate.

    A sentence ends at a line break, at ``;`` or ``:``, and at ``.`` ``!`` ``?``
    unless the dot belongs to an abbreviation ("Mr. Smith", "e.g. this").
    Commas do not split: they stay inside the sentence so word-by-word dictation
    can speak them and require typing them.
    """
    # Only class-level tables are read, so no processor (and no audio folder) is needed.
    is_sentence_end = YouTubeProcessor._is_sentence_end
    sentences: List[str] = []
    for line in raw_text.splitlines():
        words = line.split()
        chunk: List[str] = []
        for i, word in enumerate(words):
            chunk.append(word)
            next_word = words[i + 1] if i + 1 < len(words) else None
            if word[-1] in ";:" or is_sentence_end(YouTubeProcessor, word, next_word):
                sentences.extend(" ".join(c) for c in _split_long_chunk(chunk))
                chunk = []
        if chunk:
            sentences.extend(" ".join(c) for c in _split_long_chunk(chunk))
    return sentences


class ProcessTextResponse(BaseModel):
    video_id: int
    title: str
    duration: float
    sentence_count: int
    message: str


@router.post("/youtube/process_text", response_model=ProcessTextResponse)
async def process_custom_text(
    request: CustomTextRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Process a custom text paragraph: segment into sentences and store as a text lesson."""
    import uuid
    import re
    from datetime import datetime

    try:
        raw_text = request.text.strip()
        if not raw_text:
            raise ValueError("Text content cannot be empty")

        if len(raw_text) > MAX_CUSTOM_TEXT_CHARS:
            raise ValueError(f"Text is longer than {MAX_CUSTOM_TEXT_CHARS} characters")
        if len(request.title.strip()) > MAX_CUSTOM_TITLE_CHARS:
            raise ValueError(f"Title is longer than {MAX_CUSTOM_TITLE_CHARS} characters")

        sentence_texts = split_custom_text(raw_text)

        if not sentence_texts:
            raise ValueError("Could not segment the text into any sentences")

        custom_uuid = str(uuid.uuid4())
        title_str = request.title.strip() or f"Text: {raw_text[:20]}..."

        # Create a special "Video" entry
        video = Video(
            user_id=current_user.id,
            youtube_url=f"text://custom-{custom_uuid}",
            title=title_str,
            duration=0.0,
            audio_file_path=None
        )
        db.add(video)
        db.flush()

        # Add sentences
        for idx, sentence_text in enumerate(sentence_texts):
            sentence = Sentence(
                video_id=video.id,
                sentence_text=sentence_text,
                start_time=float(idx),
                end_time=float(idx + 1),
                sentence_index=idx
            )
            db.add(sentence)

        db.commit()

        # Kick off background ingestion into Qdrant for semantic search & AI coach
        background_tasks.add_task(
            ingest_sentences_for_video,
            video_id=video.id,
            user_id=current_user.id,
        )

        return ProcessTextResponse(
            video_id=video.id,
            title=video.title,
            duration=video.duration,
            sentence_count=len(sentence_texts),
            message="Custom text processed successfully"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process custom text: {str(e)}")
