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
# ffmpeg: audio extraction.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# JS runtime yt-dlp needs for YouTube's challenges. Debian's nodejs (20) is too
# old for yt-dlp's solver, so take the binary from the official Node 22 image.
COPY --from=frontend /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
# curl_cffi lets yt-dlp impersonate a browser. YouTube asks for that on subtitle
# downloads, and from a datacenter IP they come back empty without it. Server
# only: the desktop app runs from home IPs and doesn't need the extra weight.
RUN pip install --no-cache-dir "yt-dlp[curl-cffi]==$(pip show yt-dlp | sed -n 's/^Version: //p')"
COPY backend/ backend/
COPY --from=frontend /app/frontend/dist /app/frontend/dist

ENV ELECTRON_STATIC_DIR=/app/frontend/dist \
    EAR2FINGER_DOWNLOAD_DIR=/tmp/downloads \
    EAR2FINGER_AUDIO_DIR=/tmp/audio \
    PYTHONUNBUFFERED=1

# Cloud Run sets $PORT (default 8080).
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
