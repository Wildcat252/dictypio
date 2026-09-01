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

`POST /api/ai/translate` tries a self-hosted **LibreTranslate** first and falls back
to Google's free web endpoint if it is unreachable, so Translate keeps working with
nothing installed.

Run LibreTranslate locally (first start downloads the language models):

```bash
docker run -ti --rm -p 5000:5000 libretranslate/libretranslate --load-only en,vi,ja,ko,es,fr,de,ru,th,id
```

Configured by `LIBRETRANSLATE_URL` (default `http://localhost:5000`),
`LIBRETRANSLATE_API_KEY` (unset for a local container) and `LIBRETRANSLATE_TIMEOUT`
(default 15s, paid on every miss before the fallback runs). See `.env.example`.

Note that `npm run electron:dev` does not read `.env` — it passes the shell's own
environment to the backend, so export these before starting it.

Port 5000 is a popular default and may already be taken. Publish the container
somewhere else and point the app at it rather than fighting for the port:

```bash
docker run -ti --rm -p 5001:5000 libretranslate/libretranslate
export LIBRETRANSLATE_URL=http://localhost:5001
```

An unrelated service answering on the configured port looks like a LibreTranslate
outage: the request 404s and translation quietly falls back to Google.

When the fallback runs, the backend logs a `WARNING` naming LibreTranslate; use that
to tell a real LibreTranslate translation apart from a silent Google one.
