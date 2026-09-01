# CUDA runtime base: Wan2.1 needs an NVIDIA GPU for real generation.
# For MOCK_MODE only, a plain python:3.11-slim base works too.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv python3-pip \
        ffmpeg git libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

WORKDIR /app

# Install PyTorch against the CUDA wheels first so the generic requirements
# cannot pull a CPU-only build over the top of it.
RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

COPY requirements.txt ./
RUN python3 -m pip install -r requirements.txt

# The official Wan2.1 implementation. Weights are NOT baked in: they are 82 GB
# and are mounted at runtime through the models/ volume.
ARG WAN_REF=main
RUN git clone --depth 1 --branch ${WAN_REF} https://github.com/Wan-Video/Wan2.1 /opt/Wan2.1 && \
    python3 -m pip install -r /opt/Wan2.1/requirements.txt || \
    echo "Wan requirements partially installed; flash_attn needs a CUDA toolchain and is optional."
ENV WAN_REPO_PATH=/opt/Wan2.1

COPY . .

ENV SERVER_NAME=0.0.0.0 \
    SERVER_PORT=7860 \
    WAN_MODEL_PATH=/app/models/Wan2.1-FLF2V-14B-720P

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/', timeout=4)" || exit 1

CMD ["python3", "app.py"]
