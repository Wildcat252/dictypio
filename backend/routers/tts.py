"""Google Cloud Text-to-Speech for lesson playback (see services/tts.py)."""
import logging

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import User, get_db
from services import tts as tts_service

logger = logging.getLogger(__name__)
router = APIRouter()

# Whole-sentence playback sends one sentence at a time; Google accepts up to
# 5000 bytes per request.
MAX_TEXT_CHARS = 1500


class SynthesizeRequest(BaseModel):
    text: str
    voice: str


@router.get("/tts/status")
async def tts_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not tts_service.ENABLED:
        return {"enabled": False}
    return {
        "enabled": True,
        "default_voice": tts_service.DEFAULT_VOICE,
        "usage": tts_service.monthly_usage(db),
    }


async def _voices() -> list[dict]:
    try:
        return await tts_service.list_voices()
    except Exception as exc:
        logger.warning("tts: listing voices failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Google Text-to-Speech failed: {exc}") from exc


@router.get("/tts/voices")
async def tts_voices(current_user: User = Depends(get_current_user)):
    if not tts_service.ENABLED:
        return []
    return await _voices()


@router.post("/tts")
async def tts_synthesize(
    body: SynthesizeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not tts_service.ENABLED:
        raise HTTPException(status_code=503, detail="Google Text-to-Speech is not enabled on this server.")

    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"Text is longer than {MAX_TEXT_CHARS} characters.")

    voice = next((v for v in await _voices() if v["name"] == body.voice), None)
    if voice is None:
        raise HTTPException(status_code=400, detail="Unknown voice.")
    tier = voice["tier"]

    # Check before calling Google, count only after it succeeded.
    problem = tts_service.quota_problem(db, current_user.id, tier, len(text))
    if problem:
        raise HTTPException(status_code=429, detail={"reason": "quota", "tier": tier, "period": problem})

    try:
        audio = await tts_service.synthesize(text, voice["name"])
    except Exception as exc:
        logger.warning("tts: synthesis failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Google Text-to-Speech failed: {exc}") from exc

    tts_service.record_usage(db, current_user.id, tier, len(text))
    # The browser keeps clips in IndexedDB itself; this only stops shared caches.
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=31536000"})
