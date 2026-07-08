# Trellis 2 (microsoft/TRELLIS.2-4B) — RunPod Serverless worker
#
# Bağımlılıklar, resmi microsoft/TRELLIS.2 kurulumunu (setup.sh) izler:
#   conda env "trellis2" (Python 3.10) + PyTorch 2.6.0 / CUDA 12.4
#   flash-attn, nvdiffrast, nvdiffrec, cumesh, o-voxel, flexgemm derlenir.
#
# Build:  docker build -t <registry>/nexus-trellis2:latest runpod/
# Push:   docker push <registry>/nexus-trellis2:latest

FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0" \
    CUDA_HOME=/usr/local/cuda \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    CONDA_DIR=/opt/conda
ENV PATH=$CONDA_DIR/bin:$PATH

# ── Sistem bağımlılıkları + Miniconda ──
RUN apt-get update && apt-get install -y --no-install-recommends \
        git wget ca-certificates build-essential ninja-build \
        libjpeg-dev libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && wget -qO /tmp/miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh \
    && bash /tmp/miniconda.sh -b -p $CONDA_DIR \
    && rm /tmp/miniconda.sh

# ── TRELLIS.2 kaynağı (submodule'lar dahil) ──
RUN git clone -b main --recursive https://github.com/microsoft/TRELLIS.2.git /opt/TRELLIS.2

WORKDIR /opt/TRELLIS.2

# ── Resmi setup.sh: env "trellis2" + tüm derlenen eklentiler ──
# (--basic --flash-attn --nvdiffrast --nvdiffrec --cumesh --o-voxel --flexgemm)
RUN . ./setup.sh --new-env --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh --o-voxel --flexgemm

# ── RunPod SDK + handler bağımlılıkları (trellis2 env'ine) ──
RUN conda run -n trellis2 pip install --no-cache-dir runpod requests

ENV PYTHONPATH=/opt/TRELLIS.2:$PYTHONPATH
COPY handler.py /opt/TRELLIS.2/handler.py

# trellis2 conda env'i içinde handler'ı başlat
CMD ["conda", "run", "--no-capture-output", "-n", "trellis2", "python", "-u", "handler.py"]
