# Trellis 2 (microsoft/TRELLIS.2-4B) — RunPod Serverless worker
# CUDA tabanlı; Trellis'in derlenen bağımlılıklarını (flash-attn, nvdiffrast,
# kaolin, diffoctreerast, spconv) içerir.
#
# Build:  docker build -t <registry>/nexus-trellis2:latest runpod/
# Push:   docker push <registry>/nexus-trellis2:latest

FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0" \
    ATTN_BACKEND=flash-attn \
    SPCONV_ALGO=native \
    HF_HOME=/runpod-volume/hf-cache

# ── Sistem bağımlılıkları ──
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3-pip python3.10-dev \
        git build-essential ninja-build \
        libgl1 libglib2.0-0 libgomp1 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# ── PyTorch (CUDA 12.1) ──
RUN pip install --upgrade pip && \
    pip install torch==2.4.0 torchvision==0.19.0 --index-url https://download.pytorch.org/whl/cu121

# ── Trellis çalışma zamanı bağımlılıkları ──
# Not: flash-attn / kaolin / nvdiffrast / diffoctreerast derlenir; bu adım uzun sürer.
RUN pip install \
        runpod \
        pillow \
        requests \
        numpy \
        transformers \
        safetensors \
        huggingface_hub \
        trimesh \
        rembg \
        onnxruntime \
        opencv-python-headless \
        imageio \
        xatlas \
        spconv-cu120

RUN pip install flash-attn==2.6.3 --no-build-isolation

RUN pip install \
        kaolin -f https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.4.0_cu121.html || true
RUN pip install git+https://github.com/NVlabs/nvdiffrast.git
RUN pip install git+https://github.com/JeffreyXiang/diffoctreerast.git

# ── Trellis kaynak kodu ──
# TRELLIS 2 resmi deposu; `trellis` paketini import edilebilir kılar.
RUN git clone --recursive https://github.com/microsoft/TRELLIS.git /opt/TRELLIS
ENV PYTHONPATH=/opt/TRELLIS:$PYTHONPATH

WORKDIR /app
COPY handler.py /app/handler.py

CMD ["python", "-u", "handler.py"]
