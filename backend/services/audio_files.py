"""Downloaded lesson audio on disk.

The file name comes from the YouTube id and title, so two accounts that import
the same video point at one file. It may only be removed once no lesson uses it.
"""
import os
import shutil
import subprocess
import tempfile
import threading
from typing import Dict, Iterable, Optional

from sqlalchemy.orm import Session

from database import Video

# Audio sits on a persistent disk that costs money, so each account may keep
# only this many lessons with audio. Override with the env var of the same name.
MAX_AUDIO_LESSONS_PER_USER = int(os.getenv("MAX_AUDIO_LESSONS_PER_USER", "10"))


def count_audio_lessons(db: Session, user_id: int) -> int:
    """Lessons of this user that currently hold an audio file (deleted ones don't)."""
    return (
        db.query(Video.id)
        .filter(
            Video.user_id == user_id,
            Video.deleted_at.is_(None),
            Video.audio_file_path.isnot(None),
        )
        .count()
    )

def audio_file_exists(path: Optional[str]) -> bool:
    return bool(path) and os.path.isfile(path)


def forget_missing_audio(db: Session, path: str, audio_dir: str) -> bool:
    """Clear ``path`` from every lesson when its file is really gone; True if it did.

    A file under the current audio dir is gone only if that dir is there (a
    bucket mount that failed must not wipe every lesson's audio). A file
    anywhere else was left behind by an old setting, such as Cloud Run's /tmp.
    """
    if os.path.isfile(path):
        return False
    audio_root = os.path.realpath(audio_dir)
    in_audio_dir = os.path.realpath(path).startswith(audio_root + os.sep)
    if in_audio_dir and not os.path.isdir(audio_root):
        return False
    db.query(Video).filter(Video.audio_file_path == path).update(
        {Video.audio_file_path: None}, synchronize_session=False
    )
    db.commit()
    return True


_convert_locks: Dict[str, threading.Lock] = {}
_convert_locks_guard = threading.Lock()


def ensure_seekable_audio(db: Session, path: Optional[str]) -> Optional[str]:
    """Return the audio to serve for ``path``, converting an old MP3 to M4A once.

    Lessons imported before the switch to M4A have a VBR MP3, in which browsers
    only estimate where a given second is, so a sentence starts off the mark and
    differently in each browser. The M4A replaces the MP3 for every lesson that
    shares the file. Without FFmpeg, or if it fails, the MP3 is served as before.
    """
    if not path or not path.lower().endswith(".mp3"):
        return path
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return path

    target = path[:-4] + ".m4a"
    with _convert_locks_guard:
        lock = _convert_locks.setdefault(path, threading.Lock())
    with lock:
        if not os.path.isfile(path):
            # Another request converted it while this one waited.
            return target if os.path.isfile(target) else path
        # Convert on local disk; the audio dir may be a mounted bucket, which is
        # slow for partial writes. Only the finished file is moved there.
        fd, partial = tempfile.mkstemp(prefix="converting-", suffix=".m4a")
        os.close(fd)
        try:
            result = subprocess.run(
                [ffmpeg, "-y", "-v", "error", "-i", path, "-vn",
                 "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", partial],
                capture_output=True,
                text=True,
                timeout=600,
            )
            if result.returncode != 0 or not os.path.getsize(partial):
                raise RuntimeError(result.stderr[-400:])
            shutil.move(partial, target)
        except Exception as e:
            print(f"Warning: could not convert {os.path.basename(path)} to M4A: {e}")
            if os.path.isfile(partial):
                try:
                    os.remove(partial)
                except OSError:
                    pass
            return path

        db.query(Video).filter(Video.audio_file_path == path).update(
            {Video.audio_file_path: target}, synchronize_session=False
        )
        db.commit()
        try:
            os.remove(path)
        except OSError:
            pass
    return target


def remove_unreferenced_audio(db: Session, paths: Iterable[Optional[str]]) -> None:
    """Delete each file that no Video row points at any more.

    Call it after the rows that used the paths were cleared or deleted (and at
    least flushed), so they no longer count as references.
    """
    for path in {p for p in paths if p}:
        still_used = db.query(Video.id).filter(Video.audio_file_path == path).first()
        if still_used or not os.path.isfile(path):
            continue
        try:
            os.remove(path)
        except OSError:
            pass
