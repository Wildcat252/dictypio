from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, HttpUrl, field_validator
from sqlalchemy.orm import Session
from typing import Iterator, List, Optional, Tuple
from database import get_db, Video, Sentence, User, PlaylistVideo, LearningProgress
from auth import get_current_user
from services.audio_files import ensure_seekable_audio, forget_missing_audio, remove_unreferenced_audio
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
        # yt-dlp runs for minutes; on the event loop it would stall every other
        # request this instance serves (health, audio, sentences) meanwhile.
        result = await run_in_threadpool(
            _get_youtube_processor().process_youtube_video,
            request.url,
            db,
            user_id=current_user.id,
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


AUDIO_MISSING_MESSAGE = (
    "The audio of this lesson is no longer on the server. "
    "Import the same YouTube link again to restore it; your progress is kept."
)


def is_youtube_block_error(message: str) -> bool:
    lowered = message.lower().replace("’", "'")
    return any(marker in lowered for marker in _YOUTUBE_BLOCK_MARKERS)


@router.get("/youtube/videos", response_model=List[VideoResponse])
def get_videos(
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
def get_video(
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
def get_video_sentences(
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


# The most one partial response carries. Cloud Run cuts plain HTTP/1 responses
# above 32 MiB, so a long lesson is fetched as several ranges of this size; a
# server may answer a range with less than was asked for (RFC 9110 14.1.2).
AUDIO_RANGE_CHUNK = 8 * 1024 * 1024
_READ_BLOCK = 256 * 1024
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeNotSatisfiable(Exception):
    pass


def parse_range(header: Optional[str], size: int) -> Optional[Tuple[int, int]]:
    """The (start, end) byte range asked for, end inclusive and capped to
    AUDIO_RANGE_CHUNK; None for the whole file. Raises RangeNotSatisfiable."""
    if not header:
        return None
    match = _RANGE_RE.match(header.strip().lower())
    if not match:
        # Several ranges or another unit: allowed to answer with the whole file.
        return None
    first, last = match.groups()
    if not first and not last:
        raise RangeNotSatisfiable()
    if not first:
        # bytes=-N: the last N bytes
        suffix = int(last)
        if suffix == 0 or size == 0:
            raise RangeNotSatisfiable()
        start, end = max(0, size - suffix), size - 1
    else:
        start = int(first)
        end = int(last) if last else size - 1
        if start >= size or end < start:
            raise RangeNotSatisfiable()
        end = min(end, size - 1)
    end = min(end, start + AUDIO_RANGE_CHUNK - 1)
    return start, end


def _iter_file(path: str, start: int, length: int) -> Iterator[bytes]:
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            data = f.read(min(_READ_BLOCK, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _serve_audio_with_range(path: str, request: Request, media_type: str, filename: str):
    """Serve file with Range support so the browser can seek (currentTime)."""
    size = os.path.getsize(path)
    try:
        byte_range = parse_range(request.headers.get("range"), size)
    except RangeNotSatisfiable:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    if byte_range is None:
        return FileResponse(
            path,
            media_type=media_type,
            filename=filename,
            headers={"Accept-Ranges": "bytes"},
        )
    start, end = byte_range
    length = end - start + 1
    return StreamingResponse(
        _iter_file(path, start, length),
        status_code=206,
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        },
    )


@router.get("/youtube/videos/{video_id}/audio")
def get_video_audio(
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
        if video.audio_file_path:
            # The file is gone (it lived on a disk that was wiped). Stop counting
            # the lesson as one with audio; importing its link again restores it.
            forget_missing_audio(db, video.audio_file_path, _get_youtube_processor().audio_dir)
        raise HTTPException(status_code=404, detail=AUDIO_MISSING_MESSAGE)

    # Lessons from before the M4A switch get their MP3 converted the first time
    # they are opened (this endpoint is sync, so FastAPI runs it off the event loop).
    audio_path = ensure_seekable_audio(db, video.audio_file_path)

    return _serve_audio_with_range(
        audio_path,
        request,
        media_type=_audio_media_type_for_path(audio_path),
        filename=os.path.basename(audio_path),
    )


@router.delete("/youtube/videos/{video_id}")
def delete_video(
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
