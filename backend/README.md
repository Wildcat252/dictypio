# Ear2Finger Backend

FastAPI backend for the Ear2Finger application.

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

## Translation

`POST /api/ai/translate` (requires login) picks its source by configuration:

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
