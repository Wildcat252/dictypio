"""Google Cloud Text-to-Speech: synthesis, the voice list and free-tier usage counting.

Auth is Application Default Credentials (the Cloud Run service account, or
`gcloud auth application-default login` locally), so no key is stored anywhere.
Audio is not cached here: the browser keeps every clip it fetched in IndexedDB.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from datetime import datetime, timezone

import httpx
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config import (
    GOOGLE_TTS_DAILY_CHARS_PER_USER,
    GOOGLE_TTS_DEFAULT_VOICE,
    GOOGLE_TTS_ENABLED,
    GOOGLE_TTS_LANGUAGES,
    GOOGLE_TTS_MONTHLY_CHARS_CHIRP3HD,
    GOOGLE_TTS_MONTHLY_CHARS_NEURAL2,
    GOOGLE_TTS_TIMEOUT,
)
from database import TtsUsage

logger = logging.getLogger(__name__)

# Read through the module (tts_service.ENABLED) so tests can switch them.
ENABLED = GOOGLE_TTS_ENABLED
DEFAULT_VOICE = GOOGLE_TTS_DEFAULT_VOICE
DAILY_CHARS_PER_USER = GOOGLE_TTS_DAILY_CHARS_PER_USER
MONTHLY_LIMITS = {
    "chirp3hd": GOOGLE_TTS_MONTHLY_CHARS_CHIRP3HD,
    "neural2": GOOGLE_TTS_MONTHLY_CHARS_NEURAL2,
}
TIER_LABELS = {"chirp3hd": "Chirp 3 HD", "neural2": "Neural2"}

_API = "https://texttospeech.googleapis.com/v1"
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
_VOICES_TTL_S = 24 * 3600


class TtsError(RuntimeError):
    """Google refused or failed a request."""


# --- credentials -------------------------------------------------------------

_creds = None
_creds_lock = asyncio.Lock()


def _load_credentials():
    import google.auth
    from google.oauth2 import credentials as user_credentials

    creds, project = google.auth.default(scopes=_SCOPES)
    # Locally, ADC is the developer's own Google account, and Google needs to be
    # told which project to bill. The Cloud Run service account already belongs
    # to one, so it is left alone.
    quota_project = os.getenv("GOOGLE_CLOUD_PROJECT") or project
    if (
        isinstance(creds, user_credentials.Credentials)
        and quota_project
        and not creds.quota_project_id
    ):
        creds = creds.with_quota_project(quota_project)
    return creds


async def _auth_headers() -> dict:
    global _creds
    async with _creds_lock:
        if _creds is None:
            _creds = await run_in_threadpool(_load_credentials)
        if not _creds.valid:
            from google.auth.transport.requests import Request

            await run_in_threadpool(_creds.refresh, Request())
        headers: dict = {}
        _creds.apply(headers)  # Authorization, plus x-goog-user-project when set
        return headers


async def _request(method: str, path: str, **kwargs) -> dict:
    headers = await _auth_headers()
    async with httpx.AsyncClient(timeout=GOOGLE_TTS_TIMEOUT) as client:
        resp = await client.request(method, f"{_API}{path}", headers=headers, **kwargs)
    if resp.status_code != 200:
        message = resp.text
        try:
            message = resp.json()["error"]["message"]
        except Exception:
            pass
        raise TtsError(f"HTTP {resp.status_code}: {message}")
    return resp.json()


# --- voices ------------------------------------------------------------------

def tier_of(voice_name: str) -> str | None:
    if "-Chirp3-HD-" in voice_name:
        return "chirp3hd"
    if "-Neural2-" in voice_name:
        return "neural2"
    return None


def _label(voice_name: str, gender: str) -> str:
    # "en-US-Chirp3-HD-Aoede" -> "Aoede"; "en-US-Neural2-F" -> "Neural2 F (female)"
    tail = voice_name.rsplit("-", 1)[-1]
    if tier_of(voice_name) == "chirp3hd":
        return tail
    g = (gender or "").lower()
    return f"Neural2 {tail}" + (f" ({g})" if g in ("male", "female") else "")


_voices_cache: list[dict] | None = None
_voices_fetched_at = 0.0


async def list_voices() -> list[dict]:
    """Chirp 3 HD and Neural2 voices in the configured locales, cached for a day."""
    global _voices_cache, _voices_fetched_at
    if _voices_cache is not None and time.monotonic() - _voices_fetched_at < _VOICES_TTL_S:
        return _voices_cache

    data = await _request("GET", "/voices")
    voices = []
    for v in data.get("voices") or []:
        name = v.get("name") or ""
        tier = tier_of(name)
        lang = (v.get("languageCodes") or [""])[0]
        if not tier or lang not in GOOGLE_TTS_LANGUAGES:
            continue
        voices.append({
            "name": name,
            "label": _label(name, v.get("ssmlGender") or ""),
            "lang": lang,
            "tier": tier,
        })
    voices.sort(key=lambda v: (v["tier"], v["lang"], v["label"]))
    _voices_cache = voices
    _voices_fetched_at = time.monotonic()
    return voices


async def synthesize(text: str, voice_name: str) -> bytes:
    """MP3 for `text` in `voice_name`. Speed is applied by the player, not here,
    so one clip serves every playback speed."""
    language = "-".join(voice_name.split("-")[:2])
    data = await _request(
        "POST",
        "/text:synthesize",
        json={
            "input": {"text": text},
            "voice": {"languageCode": language, "name": voice_name},
            "audioConfig": {"audioEncoding": "MP3"},
        },
    )
    audio = data.get("audioContent")
    if not audio:
        raise TtsError("Google returned no audio.")
    return base64.b64decode(audio)


# --- usage counting ----------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def month_key() -> str:
    return _now().strftime("%Y-%m")


def day_key() -> str:
    return _now().strftime("%Y-%m-%d")


def _get(db: Session, scope: str, period: str) -> int:
    row = db.query(TtsUsage.chars).filter_by(scope=scope, period=period).first()
    return row[0] if row else 0


def _add(db: Session, scope: str, period: str, chars: int) -> None:
    """Atomic `chars += n`, inserting the row on first use (SQLite and Postgres)."""
    stmt = (
        update(TtsUsage)
        .where(TtsUsage.scope == scope, TtsUsage.period == period)
        .values(chars=TtsUsage.chars + chars)
    )
    if db.execute(stmt).rowcount:
        db.commit()
        return
    try:
        db.add(TtsUsage(scope=scope, period=period, chars=chars))
        db.commit()
    except IntegrityError:
        # Another request inserted it first.
        db.rollback()
        db.execute(stmt)
        db.commit()


def monthly_usage(db: Session) -> dict:
    month = month_key()
    return {
        tier: {"used": _get(db, f"tier:{tier}", month), "limit": limit}
        for tier, limit in MONTHLY_LIMITS.items()
    }


def quota_problem(db: Session, user_id: int, tier: str, chars: int) -> str | None:
    """Why this request would go past a limit ("month" or "day"), or None."""
    if _get(db, f"tier:{tier}", month_key()) + chars > MONTHLY_LIMITS[tier]:
        return "month"
    if DAILY_CHARS_PER_USER and _get(db, f"user:{user_id}", day_key()) + chars > DAILY_CHARS_PER_USER:
        return "day"
    return None


def record_usage(db: Session, user_id: int, tier: str, chars: int) -> None:
    _add(db, f"tier:{tier}", month_key(), chars)
    _add(db, f"user:{user_id}", day_key(), chars)
