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

### Running LibreTranslate

It is a plain Python package — no Docker, no admin rights. Install it in its own
virtualenv, kept away from this backend's so their Flask/pydantic pins cannot clash:

```bash
python -m venv libretranslate-venv
libretranslate-venv/Scripts/python -m pip install libretranslate
```

Start it on port 5001, loading only the languages the app offers (the first run
downloads ~2.4GB of Argos models into `~/.local/share/argos-translate`):

```bash
libretranslate-venv/Scripts/python -c "import sys; from libretranslate.main import main; sys.argv=['libretranslate','--host','127.0.0.1','--port','5001','--load-only','en,vi,ja,ko,es,fr,de,ru,th,id,zh-Hans']; main()"
```

Two Windows gotchas, both of which look like unrelated failures:

- **Set `PYTHONIOENCODING=utf-8` first.** LibreTranslate prints `en -> vi` while
  updating models; on a cp1252 console that raises `UnicodeEncodeError`, model
  download aborts, and startup then dies with `IndexError: list index out of range`
  because no language ever loaded.
- If `Scripts/libretranslate.exe` is blocked (`Access is denied`), call the entry
  point through `python -c` as above instead of the console-script shim.

Docker is the upstream-recommended route if you would rather have it:
`docker run -ti --rm -p 5001:5000 libretranslate/libretranslate`.

### Configuration

`LIBRETRANSLATE_URL` (default `http://localhost:5001`), `LIBRETRANSLATE_API_KEY`
(unset for a local instance) and `LIBRETRANSLATE_TIMEOUT` (default 15s, paid on
every miss before the fallback runs). See `.env.example`.

The default is 5001 rather than LibreTranslate's own 5000, which local dev servers
tend to hold already. An unrelated service answering on the configured port looks
exactly like a LibreTranslate outage: the request 404s and translation quietly falls
back to Google.

`npm run electron:dev` does not read `.env` — it hands the backend the shell's own
environment, so export these before starting it.

When the fallback runs, the backend logs a `WARNING` naming LibreTranslate; use that
to tell a real LibreTranslate translation apart from a silent Google one.

### Language codes

LibreTranslate has no `zh` or `zh-CN`; it splits Chinese by script. The app keeps
sending `zh-CN`, and `_LIBRETRANSLATE_LANG_OVERRIDES` in `routers/ai_coach.py` maps
it to `zh-Hans` for LibreTranslate only — Google still receives `zh-CN`.
