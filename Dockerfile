# Shared image for the API and worker services (Railway: two services, same
# image, different start commands — see railway.api.json / railway.worker.json).
FROM python:3.13-slim

# libgl1/libglib2.0-0: opencv-python (pulled in transitively via aiortc, used
# by pipecat's WebRTC transport) needs libGL.so.1 at import time even though
# this app never renders video. ffmpeg codec libs ship inside the `av` wheel,
# so no system ffmpeg is needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY run.py ./
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

RUN pip install --no-cache-dir -e .

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# Default (API service). The worker service overrides this via
# railway.worker.json's deploy.startCommand.
CMD ["python", "run.py"]
