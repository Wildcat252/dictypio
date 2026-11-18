import yt_dlp
import subprocess
import sys
import tempfile
import shutil
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Optional, Tuple
from sqlalchemy import or_
from sqlalchemy.orm import Session
from database import Video, Sentence, LearningProgress
from services.audio_files import (
    MAX_AUDIO_LESSONS_PER_USER,
    audio_file_exists,
    count_audio_lessons,
    remove_unreferenced_audio,
)
from services.youtube_segmentation import SentenceSegmenterMixin
from services.youtube_subtitles import SubtitleParserMixin
import os

# YouTube now needs a JavaScript runtime to decode its player; without one
# yt-dlp warns and some formats go missing. yt-dlp only tries deno by default,
# which the servers here lack, so also allow Node (present on Render and on any
# machine that builds the frontend). The first one found is used.
YT_DLP_JS_RUNTIMES = {'deno': {}, 'node': {}}
YT_DLP_JS_RUNTIME_ARGS = [arg for name in YT_DLP_JS_RUNTIMES for arg in ('--js-runtimes', name)]

# YouTube refuses requests from datacenter IPs (Render, cloud hosts) unless they
# carry a signed-in browser's cookies. Point YOUTUBE_COOKIES_FILE at a
# Netscape-format cookies.txt; on Render, a Secret File named
# youtube_cookies.txt is picked up without setting anything.
_COOKIE_SOURCES = (
    os.getenv('YOUTUBE_COOKIES_FILE', '').strip(),
    '/etc/secrets/youtube_cookies.txt',
)
_cookie_copy: Optional[str] = None


def _youtube_cookie_file() -> Optional[str]:
    """A writable copy of the cookies file, or None when there is none.

    yt-dlp saves refreshed cookies back into the file it was given, and
    Render's secret files are read-only, so it works on a private copy.
    """
    global _cookie_copy
    if _cookie_copy and os.path.isfile(_cookie_copy):
        return _cookie_copy
    source = next((p for p in _COOKIE_SOURCES if p and os.path.isfile(p)), None)
    if not source:
        return None
    fd, copy = tempfile.mkstemp(prefix='yt-cookies-', suffix='.txt')
    os.close(fd)
    shutil.copyfile(source, copy)
    _cookie_copy = copy
    return copy


def _private_cookie_copy() -> Optional[str]:
    """A second copy of the cookies for a yt-dlp run that overlaps another one.

    yt-dlp rewrites its cookie file when it exits, so two runs at the same time
    must not share one. The caller removes the copy when its run is over.
    """
    shared = _youtube_cookie_file()
    if not shared:
        return None
    fd, copy = tempfile.mkstemp(prefix='yt-cookies-', suffix='.txt')
    os.close(fd)
    shutil.copyfile(shared, copy)
    return copy


def yt_dlp_common_options(cookie_file: Optional[str] = None) -> Dict:
    """Options every in-process yt-dlp call shares."""
    options: Dict = {'js_runtimes': YT_DLP_JS_RUNTIMES}
    cookie_file = cookie_file or _youtube_cookie_file()
    if cookie_file:
        options['cookiefile'] = cookie_file
    return options


def yt_dlp_common_args(cookie_file: Optional[str] = None) -> List[str]:
    """The same settings for the yt-dlp command line."""
    args = list(YT_DLP_JS_RUNTIME_ARGS)
    cookie_file = cookie_file or _youtube_cookie_file()
    if cookie_file:
        args += ['--cookies', cookie_file]
    return args


class AudioDownloadError(Exception):
    """Every way of downloading a video's audio failed."""


class YouTubeProcessor(SubtitleParserMixin, SentenceSegmenterMixin):
    # YouTube exposes several subtitle payloads per language. json3 comes first:
    # for automatic captions it is the one that times every word, which is what
    # lets a sentence be cut exactly at its full stop.
    _SUBTITLE_EXT_RANK = (
        'json3',
        'vtt',
        'srv1',
        'srt',
        'ttml',
        'ttml+xml',
        'ass',
        'ssa',
        'srv3',
        'srv2',
        'json',
    )

    # Audio is kept as M4A (AAC). Its index maps every position to a byte
    # offset, so every browser seeks to the same spot; in a VBR MP3 they each
    # guess, and a sentence starts a little off in a different way per browser.
    _AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio/best'
    _AUDIO_EXTENSIONS = ('.m4a', '.mp3', '.webm', '.opus', '.ogg')

    def __init__(self, download_dir: str = None, audio_dir: str = None):
        # Use absolute paths relative to backend directory (or overridden via env)
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.download_dir = (
            download_dir
            or os.getenv("EAR2FINGER_DOWNLOAD_DIR")
            or os.path.join(backend_dir, "downloads")
        )
        self.audio_dir = (
            audio_dir
            or os.getenv("EAR2FINGER_AUDIO_DIR")
            or os.path.join(backend_dir, "audio")
        )
        os.makedirs(self.download_dir, exist_ok=True)
        os.makedirs(self.audio_dir, exist_ok=True)

    @staticmethod
    def _yt_dlp_cli(cookie_file: Optional[str] = None):
        """Same interpreter + yt-dlp as `import yt_dlp` (Windows often has an older `yt-dlp` earlier on PATH)."""
        return [sys.executable, '-m', 'yt_dlp', *yt_dlp_common_args(cookie_file)]

    @classmethod
    def _subtitle_ext_rank(cls, ext: Optional[str]) -> int:
        e = (ext or '').lower()
        try:
            return cls._SUBTITLE_EXT_RANK.index(e)
        except ValueError:
            return len(cls._SUBTITLE_EXT_RANK)

    def _fetch_first_parseable_subtitle(self, ydl, subtitle_list: List[Dict]) -> Optional[str]:
        """Try subtitle URLs in format order until `parse_subtitles` yields segments."""
        if not subtitle_list:
            return None
        ranked = sorted(subtitle_list, key=lambda x: self._subtitle_ext_rank(x.get('ext')))
        for fmt in ranked:
            url = fmt.get('url')
            if not url:
                continue
            try:
                raw = ydl.urlopen(url).read()
                text = raw.decode('utf-8')
            except Exception:
                continue
            if self.parse_subtitles(text):
                return text
        return None

    def _cleanup_temp_audio(self, video_id: str) -> None:
        prefix = f'{video_id}_temp'
        if not os.path.isdir(self.download_dir):
            return
        for name in os.listdir(self.download_dir):
            if name.startswith(prefix):
                try:
                    os.remove(os.path.join(self.download_dir, name))
                except OSError:
                    pass

    @staticmethod
    def _has_ffmpeg() -> bool:
        """Whether yt-dlp can repackage audio. Without FFmpeg the file is kept as YouTube sends it."""
        try:
            from yt_dlp.postprocessor.ffmpeg import FFmpegPostProcessor

            return bool(FFmpegPostProcessor(None).available)
        except Exception:
            return shutil.which('ffmpeg') is not None

    def _download_audio_via_python_ydl(
        self,
        youtube_url: str,
        video_id: str,
        safe_title: str,
        cookie_file: Optional[str] = None,
        errors: Optional[List[str]] = None,
    ) -> Optional[str]:
        """
        Download audio using in-process yt_dlp (required when PyInstaller breaks ``-m yt_dlp``).
        Tries an FFmpeg M4A extract first, then the native file if FFmpeg is unavailable.
        """
        temp_prefix = f'{video_id}_temp'
        base_slug = f'{video_id}_{safe_title}'
        # yt-dlp works in the local download dir; only the finished file goes to
        # audio_dir, which may be a mounted bucket that is slow for partial writes.
        temp_pattern = os.path.join(self.download_dir, f'{temp_prefix}.%(ext)s')

        def pick_temp_file(*suffixes: str) -> Optional[str]:
            for name in os.listdir(self.download_dir):
                if not name.startswith(temp_prefix):
                    continue
                lower = name.lower()
                for suf in suffixes:
                    if lower.endswith(suf):
                        return os.path.join(self.download_dir, name)
            return None

        def finalize(ext: str, src_path: str) -> str:
            dest = os.path.join(self.audio_dir, f'{base_slug}{ext}')
            if os.path.exists(dest):
                os.remove(dest)
            shutil.move(src_path, dest)
            return dest

        self._cleanup_temp_audio(video_id)

        if not self._has_ffmpeg():
            return self._download_native_audio(
                youtube_url, video_id, cookie_file, pick_temp_file, finalize, errors
            )

        opts_m4a = {
            'quiet': True,
            'no_warnings': True,
            'noplaylist': True,
            **yt_dlp_common_options(cookie_file),
            'format': self._AUDIO_FORMAT,
            'outtmpl': temp_pattern,
            'postprocessors': [
                {
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'm4a',
                }
            ],
        }
        try:
            with yt_dlp.YoutubeDL(opts_m4a) as ydl_dl:
                ydl_dl.download([youtube_url])
        except Exception as e:
            print(f"Warning: in-process yt-dlp M4A extract failed: {e}")
            if errors is not None:
                errors.append(str(e))
        else:
            p = pick_temp_file('.m4a')
            if p:
                return finalize('.m4a', p)

        return self._download_native_audio(
            youtube_url, video_id, cookie_file, pick_temp_file, finalize, errors
        )

    def _download_native_audio(
        self, youtube_url, video_id, cookie_file, pick_temp_file, finalize, errors=None
    ) -> Optional[str]:
        """In-process download of the audio exactly as YouTube has it, with no FFmpeg step."""
        temp_pattern = os.path.join(self.download_dir, f'{video_id}_temp.%(ext)s')
        self._cleanup_temp_audio(video_id)
        opts_native = {
            'quiet': True,
            'no_warnings': True,
            'noplaylist': True,
            **yt_dlp_common_options(cookie_file),
            'format': 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/ba/b',
            'outtmpl': temp_pattern,
        }
        try:
            with yt_dlp.YoutubeDL(opts_native) as ydl_dl:
                ydl_dl.download([youtube_url])
        except Exception as e:
            print(f"Warning: in-process yt-dlp native audio download failed: {e}")
            if errors is not None:
                errors.append(str(e))
            return None

        for suf in self._AUDIO_EXTENSIONS:
            p = pick_temp_file(suf)
            if p:
                return finalize(suf, p)
        return None

    @staticmethod
    def _pick_caption_track(info: Dict) -> Optional[Tuple[str, bool]]:
        """The English caption track to fetch, as (language code, is automatic).

        Captions somebody wrote win over automatic ones. yt-dlp already listed
        both while reading the video, so no request is spent on finding out.
        """
        def english(tracks, preferred):
            codes = [c for c in (tracks or {}) if c == 'en' or c.startswith(('en-', 'en_'))]
            for code in preferred:
                if code in codes:
                    return code
            return sorted(codes)[0] if codes else None

        manual = english(info.get('subtitles'), ('en', 'en-US', 'en-GB'))
        if manual:
            return manual, False
        automatic = english(info.get('automatic_captions'), ('en', 'en-orig'))
        if automatic:
            return automatic, True
        return None

    def _read_subtitle_file(self, directory: str) -> Optional[str]:
        """The best subtitle file yt-dlp wrote into ``directory`` that parses."""
        names = sorted(
            os.listdir(directory),
            key=lambda name: self._subtitle_ext_rank(name.rsplit('.', 1)[-1]),
        )
        for name in names:
            try:
                with open(os.path.join(directory, name), 'r', encoding='utf-8') as f:
                    text = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            if self.parse_subtitles(text):
                return text
        return None

    def _download_subtitles(self, youtube_url: str, ydl, info: Dict) -> Optional[str]:
        """Fetch the English captions, in the format that keeps the most timing."""
        subtitles_data = None
        track = self._pick_caption_track(info)
        # Normally one request for the track picked above. If the listing had no
        # English track, still ask for one, written captions first.
        attempts = [track] if track else [('en', False), ('en', True)]
        try:
            for lang, is_auto in attempts:
                with tempfile.TemporaryDirectory() as tmpdir:
                    cmd = self._yt_dlp_cli() + [
                        '--no-playlist',
                        '--write-auto-subs' if is_auto else '--write-subs',
                        '--sub-langs', lang,
                        # No --convert-subs: converting to SRT throws the word timings away.
                        '--sub-format', 'json3/vtt/srt/best',
                        '--skip-download',
                        '--output', os.path.join(tmpdir, '%(id)s.%(ext)s'),
                        '--quiet',
                        youtube_url,
                    ]
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                    subtitles_data = self._read_subtitle_file(tmpdir)
                    if subtitles_data:
                        break
                    print(
                        f"Warning: no {'automatic' if is_auto else 'manual'} subtitle file "
                        f"written for '{lang}'; yt-dlp said: {result.stderr[-800:]}"
                    )
        except subprocess.TimeoutExpired:
            print("Warning: Subtitle download timed out")
        except Exception as e:
            print(f"Warning: Failed to download subtitles via command-line: {str(e)}")

        # Fall back to the yt-dlp API when the command-line path produced nothing.
        if not subtitles_data:
            try:
                subtitles_data = self._extract_subtitles_via_api(ydl, info)
            except Exception as e:
                print(f"Warning: Failed to download subtitles via the API: {str(e)}")
        return subtitles_data

    def _download_audio(self, youtube_url: str, video_id: str, safe_title: str) -> str:
        """Download the lesson audio and return its path.

        Raises AudioDownloadError when every attempt failed: a lesson without
        audio cannot be practised, so it must not be saved as if it worked.
        """
        errors: List[str] = []
        path = self._try_download_audio(youtube_url, video_id, safe_title, errors)
        if path:
            return path
        # A failed attempt leaves partial files in the download dir, which on
        # Cloud Run is memory.
        self._cleanup_temp_audio(video_id)
        detail = errors[-1] if errors else "no audio file was produced"
        raise AudioDownloadError(f"Could not download the audio: {detail[-400:]}")

    def _try_download_audio(
        self, youtube_url: str, video_id: str, safe_title: str, errors: List[str]
    ) -> Optional[str]:
        """One pass over the download methods; the path, or None with ``errors`` filled in."""
        base_path = os.path.join(self.audio_dir, f"{video_id}_{safe_title}")
        for ext in self._AUDIO_EXTENSIONS:
            if os.path.exists(base_path + ext):
                return base_path + ext

        # Runs next to the subtitle download, so it gets cookies of its own.
        cookie_file = _private_cookie_copy()
        try:
            # CLI works in dev (real Python). Packaged PyInstaller needs in-process yt-dlp.
            try:
                temp_output = os.path.join(self.download_dir, f'{video_id}_temp.%(ext)s')
                # YouTube's M4A is already AAC, so FFmpeg only repackages it instead of
                # re-encoding: much faster than the MP3 conversion this replaces.
                # Without FFmpeg the file is kept as downloaded, in one attempt.
                repackage = [
                    '-x',
                    '--audio-format', 'm4a',
                    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
                ] if self._has_ffmpeg() else []
                cmd = self._yt_dlp_cli(cookie_file) + [
                    '--no-playlist',
                    '-f', self._AUDIO_FORMAT,
                    *repackage,
                    '--output', temp_output,
                    '--quiet',
                    youtube_url,
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                if result.returncode == 0:
                    wanted = ('.m4a',) if repackage else self._AUDIO_EXTENSIONS
                    for ext in wanted:
                        for file in os.listdir(self.download_dir):
                            if file.startswith(f'{video_id}_temp') and file.endswith(ext):
                                shutil.move(os.path.join(self.download_dir, file), base_path + ext)
                                return base_path + ext
                elif result.stderr:
                    print(f"Warning: Audio CLI failed: {result.stderr[:800]}")
                    errors.append(result.stderr.strip()[-800:])
            except subprocess.TimeoutExpired:
                print("Warning: Audio download timed out")
                errors.append("the audio download timed out")
            except FileNotFoundError:
                print("Warning: yt-dlp CLI not available for audio.")
            except Exception as e:
                print(f"Warning: Audio CLI error: {e}")
                errors.append(str(e))

            return self._download_audio_via_python_ydl(
                youtube_url, video_id, safe_title, cookie_file, errors
            )
        finally:
            if cookie_file:
                try:
                    os.remove(cookie_file)
                except OSError:
                    pass

    @staticmethod
    def _safe_title(video_title: str) -> str:
        """The title as it goes into the audio file name."""
        safe_title = "".join(c for c in video_title if c.isalnum() or c in (' ', '-', '_')).rstrip()
        return safe_title[:100]

    def download_lesson_audio(self, youtube_url: str) -> str:
        """Fetch only the audio of a video, for a lesson whose file was lost.

        Raises like ``_download_audio``; the lesson's sentences are kept as they are.
        """
        opts = {
            'quiet': True,
            'no_warnings': True,
            'noplaylist': True,
            **yt_dlp_common_options(),
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(youtube_url, download=False)
        video_id = info.get('id', 'unknown')
        return self._download_audio(
            youtube_url, video_id, self._safe_title(info.get('title', 'Unknown'))
        )

    def extract_video_info(self, youtube_url: str, video_id: str = None) -> Dict:
        """Extract video information, subtitles, and download the audio using yt-dlp"""
        # First, get video info without downloading
        ydl_opts_info = {
            'quiet': True,
            'no_warnings': True,
            'noplaylist': True,
            **yt_dlp_common_options(),
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
                info = ydl.extract_info(youtube_url, download=False)
                video_id = video_id or info.get('id', 'unknown')
                video_title = info.get('title', 'Unknown')

                safe_title = self._safe_title(video_title)

                # Subtitles and audio are separate downloads; neither waits for the other.
                with ThreadPoolExecutor(max_workers=2) as pool:
                    subtitles_job = pool.submit(self._download_subtitles, youtube_url, ydl, info)
                    audio_job = pool.submit(self._download_audio, youtube_url, video_id, safe_title)
                    subtitles_data = subtitles_job.result()
                    audio_file_path = audio_job.result()

                return {
                    'title': video_title,
                    'duration': info.get('duration', 0),
                    'subtitles': subtitles_data,
                    'video_id': video_id,
                    'audio_file_path': audio_file_path,
                }
        except Exception as e:
            raise Exception(f"Failed to extract video info: {str(e)}")

    def _extract_subtitles_via_api(self, ydl, info) -> Optional[str]:
        """Fetch subtitles via yt-dlp URLs; prefers VTT/SRT/XML over raw json3."""
        if 'subtitles' in info and info['subtitles']:
            for lang_code, subtitle_list in info['subtitles'].items():
                if lang_code.startswith('en') or lang_code == 'en':
                    subtitles_data = self._fetch_first_parseable_subtitle(ydl, subtitle_list)
                    if subtitles_data:
                        return subtitles_data

        if 'automatic_captions' in info and info['automatic_captions']:
            for lang_code, caption_list in info['automatic_captions'].items():
                if lang_code.startswith('en') or lang_code == 'en':
                    subtitles_data = self._fetch_first_parseable_subtitle(ydl, caption_list)
                    if subtitles_data:
                        return subtitles_data

        return None

    def process_youtube_video(self, youtube_url: str, db: Session, user_id: int) -> Dict:
        """Process a YouTube video: extract, segment, and store in database"""
        youtube_url = youtube_url.strip().rstrip(',;')
        # Each account keeps its own copy of a lesson, so another account's row
        # for the same URL is not a match. Rows from before accounts existed have
        # no owner and go to whoever imports the URL next.
        existing_video = (
            db.query(Video)
            .filter(
                Video.youtube_url == youtube_url,
                or_(Video.user_id == user_id, Video.user_id.is_(None)),
            )
            .order_by(Video.user_id.is_(None), Video.id)
            .first()
        )
        was_deleted = (
            existing_video is not None and getattr(existing_video, "deleted_at", None) is not None
        )
        if existing_video is None or was_deleted:
            # About to download new audio (an already imported lesson skips this).
            if count_audio_lessons(db, user_id) >= MAX_AUDIO_LESSONS_PER_USER:
                raise ValueError(
                    f"You can keep up to {MAX_AUDIO_LESSONS_PER_USER} lessons with audio. "
                    "Delete one to import another."
                )
        if existing_video:
            if was_deleted:
                existing_video.deleted_at = None

            if existing_video.user_id != user_id:
                existing_video.user_id = user_id

            if not was_deleted:
                message = 'Video already processed'
                if not audio_file_exists(existing_video.audio_file_path):
                    # Its audio was lost (it lived on a disk that no longer has
                    # it): fetch the audio again and keep sentences and progress.
                    existing_video.audio_file_path = None
                    db.flush()
                    if count_audio_lessons(db, user_id) >= MAX_AUDIO_LESSONS_PER_USER:
                        raise ValueError(
                            f"You can keep up to {MAX_AUDIO_LESSONS_PER_USER} lessons with audio. "
                            "Delete one to restore the audio of this one."
                        )
                    existing_video.audio_file_path = self.download_lesson_audio(youtube_url)
                    message = 'Audio restored'
                db.commit()
                sentences = (
                    db.query(Sentence)
                    .filter(Sentence.video_id == existing_video.id)
                    .order_by(Sentence.sentence_index)
                    .all()
                )
                return {
                    'video_id': existing_video.id,
                    'title': existing_video.title,
                    'duration': existing_video.duration,
                    'sentence_count': len(sentences),
                    'message': message,
                }

            # Soft-deleted lesson restored: re-fetch from YouTube and replace sentences/audio.
            db.query(LearningProgress).filter(
                LearningProgress.video_id == existing_video.id
            ).update({LearningProgress.sentence_id: None}, synchronize_session=False)

            old_audio = existing_video.audio_file_path
            existing_video.audio_file_path = None

            db.query(Sentence).filter(Sentence.video_id == existing_video.id).delete(
                synchronize_session=False
            )
            db.flush()

            video_info = self.extract_video_info(youtube_url)

            if not video_info.get('subtitles'):
                raise Exception("No subtitles available for this video")

            segments = self.parse_subtitles(video_info['subtitles'])

            if not segments:
                raise Exception("Could not parse subtitles from video")

            sentences = self.segment_into_sentences(segments)

            if not sentences:
                raise Exception("Could not segment subtitles into sentences")

            existing_video.title = video_info['title']
            existing_video.duration = video_info['duration']
            existing_video.audio_file_path = video_info.get('audio_file_path')

            for sentence_data in sentences:
                db.add(
                    Sentence(
                        video_id=existing_video.id,
                        sentence_text=sentence_data['sentence_text'],
                        start_time=sentence_data['start_time'],
                        end_time=sentence_data['end_time'],
                        sentence_index=sentence_data['sentence_index'],
                    )
                )

            db.commit()
            # Only now: had the download failed, the rollback would have kept a
            # lesson pointing at a file already deleted. Another account's copy
            # of this lesson, or the new download itself, may still use it.
            remove_unreferenced_audio(db, [old_audio])

            from services.qdrant_client import delete_sentence_vectors_for_video

            delete_sentence_vectors_for_video(existing_video.id)

            return {
                'video_id': existing_video.id,
                'title': existing_video.title,
                'duration': existing_video.duration,
                'sentence_count': len(sentences),
                'message': 'Video processed successfully',
            }

        # Extract video info and subtitles
        video_info = self.extract_video_info(youtube_url)

        if not video_info.get('subtitles'):
            raise Exception("No subtitles available for this video")

        segments = self.parse_subtitles(video_info['subtitles'])

        if not segments:
            raise Exception("Could not parse subtitles from video")
        # Segment into sentences
        sentences = self.segment_into_sentences(segments)

        if not sentences:
            raise Exception("Could not segment subtitles into sentences")

        # Store in database
        video = Video(
            user_id=user_id,
            youtube_url=youtube_url,
            title=video_info['title'],
            duration=video_info['duration'],
            audio_file_path=video_info.get('audio_file_path')
        )
        db.add(video)
        db.flush()  # Get video ID

        # Store sentences
        for sentence_data in sentences:
            sentence = Sentence(
                video_id=video.id,
                sentence_text=sentence_data['sentence_text'],
                start_time=sentence_data['start_time'],
                end_time=sentence_data['end_time'],
                sentence_index=sentence_data['sentence_index']
            )
            db.add(sentence)

        db.commit()

        return {
            'video_id': video.id,
            'title': video.title,
            'duration': video.duration,
            'sentence_count': len(sentences),
            'message': 'Video processed successfully'
        }
