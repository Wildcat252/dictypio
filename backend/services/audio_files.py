"""Downloaded lesson audio on disk.

The file name comes from the YouTube id and title, so two accounts that import
the same video point at one file. It may only be removed once no lesson uses it.
"""
import os
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from database import Video


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
