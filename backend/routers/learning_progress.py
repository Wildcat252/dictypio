"""Learning progress per user (scores, completed state, etc.)."""
import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import LearningProgress, PracticeWordState, Sentence, User, Video, get_db
from services.learning_stats import UserStats, compute_user_stats
from services.qdrant_client import ingest_learning_progress_event

router = APIRouter()


class ProgressEntry(BaseModel):
    video_id: int
    sentence_id: int | None = None
    data: dict[str, Any]  # e.g. {"score": 1, "completed": true, "attempts": 2}


class ProgressResponse(BaseModel):
    video_id: int
    sentence_id: int | None
    data: dict


@router.get("/user/progress", response_model=list)
async def get_progress(
    video_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get learning progress for the current user. Optionally filter by video_id."""
    q = db.query(LearningProgress).filter(LearningProgress.user_id == current_user.id)
    if video_id is not None:
        q = q.filter(LearningProgress.video_id == video_id)
    rows = q.all()
    result = []
    for r in rows:
        data = json.loads(r.data) if r.data else {}
        result.append({"video_id": r.video_id, "sentence_id": r.sentence_id, "data": data})
    return result


@router.post("/user/progress")
async def upsert_progress(
    body: ProgressEntry,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or update learning progress for a sentence/video."""
    # Ensure video belongs to user
    video = db.query(Video).filter(
        Video.id == body.video_id,
        Video.user_id == current_user.id,
        Video.deleted_at.is_(None),
    ).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if body.sentence_id is not None:
        sentence = db.query(Sentence).filter(
            Sentence.id == body.sentence_id,
            Sentence.video_id == body.video_id,
        ).first()
        if not sentence:
            raise HTTPException(status_code=404, detail="Sentence not found")

    existing = (
        db.query(LearningProgress)
        .filter(
            LearningProgress.user_id == current_user.id,
            LearningProgress.video_id == body.video_id,
            LearningProgress.sentence_id == body.sentence_id,
        )
        .first()
    )

    data_json = json.dumps(body.data)
    target: LearningProgress
    if existing:
        existing.data = data_json
        target = existing
    else:
        target = LearningProgress(
            user_id=current_user.id,
            video_id=body.video_id,
            sentence_id=body.sentence_id,
            data=data_json,
        )
        db.add(target)
    db.commit()
    db.refresh(target)

    # Ingest this learning event into Qdrant in the background so that
    # the AI coach can later retrieve rich, contextual practice history.
    background_tasks.add_task(
        ingest_learning_progress_event,
        learning_progress_id=target.id,
    )

    return {"message": "Progress saved"}


@router.get("/user/stats", response_model=UserStats)
async def get_user_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregate statistics for the current user over all learning progress."""
    rows = (
        db.query(LearningProgress)
        .filter(LearningProgress.user_id == current_user.id)
        .order_by(LearningProgress.updated_at.asc())
        .all()
    )
    return compute_user_stats(rows)


class WordRef(BaseModel):
    word: str


class PracticeWordStates(BaseModel):
    binned: List[str]
    deleted: List[str]
    custom: List[str]


class AddWordsRequest(BaseModel):
    words: List[str]


def _clear_word_from_progress(db: Session, user_id: int, word: str) -> int:
    """Strip a word from the user's progress blobs so it stops being 'tricky'.

    Stats are recomputed per request from LearningProgress JSON; `error_chars`
    is what drives latest_spell_retry_times.
    """
    rows = (
        db.query(LearningProgress)
        .filter(LearningProgress.user_id == user_id)
        .all()
    )
    changed = 0
    for row in rows:
        try:
            blob = json.loads(row.data or "{}")
        except (ValueError, TypeError):
            continue
        if not isinstance(blob, dict):
            continue
        touched = False
        for key in ("error_chars", "hint_words", "hinted_words", "incorrect_words"):
            val = blob.get(key)
            if isinstance(val, dict) and word in val:
                val.pop(word, None)
                touched = True
            elif isinstance(val, list) and word in val:
                blob[key] = [w for w in val if w != word]
                touched = True
        if touched:
            row.data = json.dumps(blob)
            changed += 1
    return changed


def _get_row(db: Session, user_id: int, word: str) -> Optional[PracticeWordState]:
    return (
        db.query(PracticeWordState)
        .filter(
            PracticeWordState.user_id == user_id,
            PracticeWordState.word == word,
        )
        .first()
    )


def _set_word_status(db: Session, user_id: int, word: str, status: str) -> None:
    row = _get_row(db, user_id, word)
    if row is None:
        db.add(PracticeWordState(user_id=user_id, word=word, status=status))
    else:
        row.status = status


class TrickySentence(BaseModel):
    word: str
    sentence: str
    sentence_id: int
    video_id: int


@router.get("/user/tricky-sentences", response_model=List[TrickySentence])
async def get_tricky_sentences(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> List[TrickySentence]:
    """The most recent sentence in which each tricky word was hinted twice."""
    rows = (
        db.query(LearningProgress, Sentence.sentence_text)
        .join(Sentence, Sentence.id == LearningProgress.sentence_id)
        .filter(LearningProgress.user_id == current_user.id)
        .order_by(LearningProgress.updated_at.desc())
        .all()
    )
    deleted = {
        r.word
        for r in db.query(PracticeWordState)
        .filter(
            PracticeWordState.user_id == current_user.id,
            PracticeWordState.status == "deleted",
        )
        .all()
    }
    found: Dict[str, TrickySentence] = {}
    for progress, text in rows:
        try:
            blob = json.loads(progress.data or "{}")
        except (ValueError, TypeError):
            continue
        if not isinstance(blob, dict) or not text:
            continue
        words = blob.get("repeat_hint_words") or []
        if isinstance(words, str):
            words = [words]
        if not isinstance(words, list):
            continue
        for w in words:
            w = str(w)
            if w and w not in deleted and w not in found:
                found[w] = TrickySentence(
                    word=w,
                    sentence=text,
                    sentence_id=progress.sentence_id,
                    video_id=progress.video_id,
                )
    return list(found.values())


@router.get("/user/practice/words", response_model=PracticeWordStates)
async def get_practice_word_states(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PracticeWordStates:
    """Words the user has binned (recoverable) or deleted (permanent)."""
    rows = (
        db.query(PracticeWordState)
        .filter(PracticeWordState.user_id == current_user.id)
        .all()
    )
    return PracticeWordStates(
        binned=[r.word for r in rows if r.status == "binned"],
        deleted=[r.word for r in rows if r.status == "deleted"],
        custom=[r.word for r in rows if r.is_custom and r.status != "deleted"],
    )


@router.post("/user/practice/words/bin")
async def bin_practice_word(
    body: WordRef,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Move a word to the bin: hidden from the tricky list, still recoverable."""
    _set_word_status(db, current_user.id, body.word, "binned")
    db.commit()
    return {"message": "binned", "word": body.word}


@router.post("/user/practice/words/recover")
async def recover_practice_word(
    body: WordRef,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Take a word back out of the bin so it returns to the practice list.

    Custom words keep their row (they only exist because of it); auto-derived
    tricky words simply lose their row and reappear from the stats.
    """
    row = _get_row(db, current_user.id, body.word)
    if row is not None:
        if row.is_custom:
            row.status = "active"
        else:
            db.delete(row)
    db.commit()
    return {"message": "recovered", "word": body.word}


@router.post("/user/practice/words/add", response_model=PracticeWordStates)
async def add_practice_words(
    body: AddWordsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PracticeWordStates:
    """Add words by hand so they show up in the practice list."""
    for raw in body.words:
        word = (raw or "").strip()
        if not word:
            continue
        row = _get_row(db, current_user.id, word)
        if row is None:
            db.add(
                PracticeWordState(
                    user_id=current_user.id,
                    word=word,
                    status="active",
                    is_custom=True,
                )
            )
        else:
            row.is_custom = True
            row.status = "active"
    db.commit()
    return await get_practice_word_states(db=db, current_user=current_user)


@router.delete("/user/practice/words/{word}")
async def delete_practice_word(
    word: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently remove a word: clears its history and never shows it again."""
    rows_updated = _clear_word_from_progress(db, current_user.id, word)
    _set_word_status(db, current_user.id, word, "deleted")
    db.commit()
    return {"message": "deleted", "word": word, "rows_updated": rows_updated}
