"""Application configuration. Load from environment (e.g. .env)."""
import os

# Qdrant vector store
# Embedded (desktop): set QDRANT_LOCAL_PATH to a writable directory — uses in-process Qdrant (no server binary).
# Server / Docker: QDRANT_URL=http://localhost:6333, QDRANT_API_KEY optional.
QDRANT_LOCAL_PATH = os.getenv("QDRANT_LOCAL_PATH", "").strip() or None
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY") or None
# Must match the embedding size requested from Gemini (Matryoshka truncation) and Qdrant collections.
QDRANT_VECTOR_SIZE = int(os.getenv("QDRANT_VECTOR_SIZE", "768"))


def _env_truthy(name: str) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    return v in ("1", "true", "yes", "on")


# If set, delete and recreate Qdrant collections when vector size != QDRANT_VECTOR_SIZE even if they contain points.
# Use once to migrate (e.g. 384 -> 768); vectors are dropped until SQL-backed data is re-ingested.
QDRANT_RECREATE_ON_VECTOR_MISMATCH = _env_truthy("QDRANT_RECREATE_ON_VECTOR_MISMATCH")

# Gemini Developer API embeddings (same API key as chat).
# Legacy models/embedding-001 is removed from v1beta; use gemini-embedding-001 (see ai_client_factory output_dimensionality).
# https://ai.google.dev/gemini-api/docs/embeddings
GEMINI_EMBEDDING_MODEL = (os.getenv("GEMINI_EMBEDDING_MODEL") or "gemini-embedding-001").strip()

# Gemini model for AI coach (required by ChatGoogleGenerativeAI).
# Default: gemini-3-flash-preview. If you get 404, list models for your key:
#   curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_API_KEY"
# then set GEMINI_MODEL to a model name (e.g. gemini-3-flash-preview, gemini-1.5-flash-8b).
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

# Google Cloud Translation API (v2, Basic) for sentence translation.
# Create an API key in Google Cloud Console with the Cloud Translation API enabled.
# Optional: without it, translation uses Gemini with the user's active API key
# from Settings.
GOOGLE_TRANSLATE_API_KEY = (os.getenv("GOOGLE_TRANSLATE_API_KEY") or "").strip() or None
GOOGLE_TRANSLATE_TIMEOUT = float(os.getenv("GOOGLE_TRANSLATE_TIMEOUT", "15"))


def _env_int(name: str, default: int) -> int:
    try:
        return int((os.getenv(name) or "").strip() or default)
    except ValueError:
        return default


# Google Cloud Text-to-Speech for lesson playback. Off unless GOOGLE_TTS_ENABLED
# is set; the frontend then falls back to the browser's own voices.
# Auth is Application Default Credentials: the service account on Cloud Run, or
# `gcloud auth application-default login` locally (set GOOGLE_CLOUD_PROJECT too,
# so requests are billed to that project).
GOOGLE_TTS_ENABLED = _env_truthy("GOOGLE_TTS_ENABLED")
GOOGLE_TTS_TIMEOUT = float(os.getenv("GOOGLE_TTS_TIMEOUT", "15"))
GOOGLE_TTS_DEFAULT_VOICE = (os.getenv("GOOGLE_TTS_DEFAULT_VOICE") or "en-US-Chirp3-HD-Aoede").strip()
# Locales offered in the voice picker.
GOOGLE_TTS_LANGUAGES = [
    s.strip() for s in (os.getenv("GOOGLE_TTS_LANGUAGES") or "en-US,en-GB,en-AU").split(",") if s.strip()
]
# Characters per calendar month (UTC) the app may send to Google, per voice
# family. Google's free tier is about 1M characters a month for both Chirp 3 HD
# and Neural2 (check https://cloud.google.com/text-to-speech/pricing); the
# defaults stop at 90% of that. Past the limit the API answers 429 and the
# frontend switches to browser voices until the month rolls over.
GOOGLE_TTS_MONTHLY_CHARS_CHIRP3HD = _env_int("GOOGLE_TTS_MONTHLY_CHARS_CHIRP3HD", 900_000)
GOOGLE_TTS_MONTHLY_CHARS_NEURAL2 = _env_int("GOOGLE_TTS_MONTHLY_CHARS_NEURAL2", 900_000)
# Per user per day (UTC), so one account cannot use up the shared month.
# 0 turns the per-user limit off.
GOOGLE_TTS_DAILY_CHARS_PER_USER = _env_int("GOOGLE_TTS_DAILY_CHARS_PER_USER", 30_000)
