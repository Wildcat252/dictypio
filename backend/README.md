# Dictypio Backend

FastAPI backend for the Dictypio application.

## Quick Start

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run the server:
   ```bash
   uvicorn main:app --reload
   ```

3. Visit `http://localhost:8000/docs` for API documentation

## Project Structure

- `main.py` - FastAPI application and middleware configuration
- `routers/` - API route handlers
  - `health.py` - Health check endpoints
  - `dictation.py` - Dictation exercise endpoints
- `models/` - Data models (for future use)

## Environment Variables

Copy `.env.example` to `.env` and configure as needed.

## Accounts

Off by default: every request runs as one local `default` user, which is what the
desktop app wants. Set `AUTH_ENABLED=1` (with a private `SECRET_KEY`) to require
sign-in with email and password. The frontend reads `GET /api/auth/config` and
shows the sign-in pages only then.

- The first account to sign up takes over the `default` user, so data collected
  before accounts were enabled belongs to it. That account is the superuser.
- Password reset mails a link valid for 30 minutes, built from `APP_BASE_URL` and
  sent through the `SMTP_*` settings in `.env.example`. Without `SMTP_HOST` the
  link is printed to the backend log instead.
- Resetting a password signs out every existing session of that account.
- Settings → ACCOUNT (the `/api/account` routes) lets a signed-in user set a
  display name, change the password, change the email and delete the account.
  - A new email takes effect only after the link mailed to it is confirmed; the
    old address gets a notice.
  - Changing the password signs out every other session.
  - Deleting the account is immediate and permanent: its lessons, playlists,
    audio files, practice history, saved API keys and Qdrant vectors all go.
- Each account imports its own copy of a YouTube lesson. Copies of the same video
  share one audio file, which is removed when the last copy is deleted.

Tests: `python -m unittest discover tests` from `backend/`.

## Translation

`POST /api/ai/translate` picks its source by configuration:

- **`GOOGLE_TRANSLATE_API_KEY` set** — calls the Google Cloud Translation API v2
  (`https://translation.googleapis.com/language/translate/v2`). Create the key in
  Google Cloud Console, in a project with the Cloud Translation API enabled.
  `GOOGLE_TRANSLATE_TIMEOUT` (seconds, default 15) is optional.
- **Not set** — translates with Gemini (`GEMINI_MODEL`) using the user's active API
  key from Settings → AI API-KEY. With no Gemini key either, it answers `400`
  asking the user to add one.

A failure from either source comes back as `502` carrying the provider's message.

The backend does not read `.env` by itself: export variables in the shell, or start
uvicorn with `--env-file .env`. Restart the backend after changing them.

### Language codes

The app sends the target code it stores (`vi`, `zh-CN`, `ja`, ...), which Google
accepts as-is. A bare `zh` is mapped to `zh-CN` by `_GOOGLE_LANG_OVERRIDES` in
`routers/ai_coach.py`.

## Text-to-Speech

Text lessons and Practice can read aloud with Google Cloud Text-to-Speech voices
(Chirp 3 HD and Neural2), so every browser and phone hears the same voices.

- **`GOOGLE_TTS_ENABLED=1`** turns it on. Auth is Application Default
  Credentials: on Cloud Run the service's own service account (enable the
  Text-to-Speech API in the project, no key needed); locally
  `gcloud auth application-default login` plus `GOOGLE_CLOUD_PROJECT=<project-id>`.
- **Off** (the default, and always in the desktop app): `/api/tts/status` says
  `enabled: false` and the frontend reads with the browser's voices.

Endpoints: `GET /api/tts/status` (monthly usage per voice family),
`GET /api/tts/voices`, `POST /api/tts {text, voice}` → `audio/mpeg`.

To stay in the free tier, characters sent to Google are counted in the
`tts_usage` table per voice family per month (`GOOGLE_TTS_MONTHLY_CHARS_CHIRP3HD`,
`GOOGLE_TTS_MONTHLY_CHARS_NEURAL2`, default 900000 each) and per user per day
(`GOOGLE_TTS_DAILY_CHARS_PER_USER`, default 30000, 0 = off). Past a limit the
request answers `429` and the frontend falls back to browser voices. The server
caches no audio; the browser keeps each clip in IndexedDB.
