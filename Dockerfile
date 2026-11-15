# Web deployment image (Google Cloud Run): FastAPI backend + built React frontend.

# --- Stage 1: build the frontend ---
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: Python backend ---
FROM python:3.12-slim
# ffmpeg: audio extraction. nodejs: JS runtime yt-dlp needs for YouTube.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg nodejs ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=frontend /app/frontend/dist /app/frontend/dist

ENV ELECTRON_STATIC_DIR=/app/frontend/dist \
    EAR2FINGER_DOWNLOAD_DIR=/tmp/downloads \
    EAR2FINGER_AUDIO_DIR=/tmp/audio \
    PYTHONUNBUFFERED=1

# Cloud Run sets $PORT (default 8080).
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
