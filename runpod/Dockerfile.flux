# syntax=docker/dockerfile:1
# FLUX.1-schnell — minimal diffusers RunPod Serverless worker (ComfyUI YOK)
#
# NF4'ün build-edilebilir eşdeğeri: GGUF Q4 (4-bit) transformer + fp8 T5, image'a baked.
# Runtime indirme YOK. Hedef ~18-20GB. GPU havuzu: Ampere+Ada 24GB (fp8 gerekmez, GGUF
# dequant runtime'da bf16'ya açılır → her iki mimaride çalışır).
#
# Build: RunPod Serverless → Template → "Build from GitHub"
#   repo   : tolgahantopcuoglu012-debug/-nexus-beta8   (branch: main)
#   context: .
#   Dockerfile path: runpod/Dockerfile.flux
# Sonra endpoint ytp43akq7q07ts template'ini bu yeni template'e geçir.
#
# NOT: T5 fp8 cast build-zamanı ~15GB RAM ister (bf16 T5 yükle + fp8 kopya). RunPod
# builder RAM'i yetmezse bake_flux.py'de T5'i düşük RAM'li parça-parça cast'e çevir.

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    MODEL_DIR=/models \
    HF_HOME=/tmp/hf \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip git wget ca-certificates libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

# ── PyTorch 2.4.1 / CUDA 12.4 ──
RUN pip install --no-cache-dir \
        torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cu124

# ── diffusers + GGUF + transformers yığını ──
# diffusers>=0.32: FluxTransformer2DModel.from_single_file + GGUFQuantizationConfig.
RUN pip install --no-cache-dir \
        "diffusers>=0.32.0" "transformers>=4.44,<5" accelerate safetensors \
        gguf sentencepiece protobuf Pillow runpod requests "huggingface_hub[hf_transfer]"

# ── Ağırlıkları image'a bake et (runtime indirme YOK) ──
# HF_TOKEN build-secret olarak mount edilir → gated FLUX.1-schnell erişimi.
# Secret mount katmanda kalmaz (image'a token SIZMAZ).
COPY runpod/bake_flux.py /tmp/bake_flux.py
RUN --mount=type=secret,id=hf_token \
    HF_TOKEN="$(cat /run/secrets/hf_token)" python /tmp/bake_flux.py \
    && rm -f /tmp/bake_flux.py

COPY runpod/flux_handler.py /flux_handler.py
CMD ["python", "-u", "/flux_handler.py"]
