# Trellis 2 (microsoft/TRELLIS.2-4B) — RunPod Serverless worker
#
# Bağımlılıklar resmi microsoft/TRELLIS.2 kurulumunu izler; ancak conda env "trellis2"
# ve PyTorch, setup.sh'ın --new-env yoluna bırakılmaz (o yol RunPod non-interactive
# build'inde defaults-kanalı ToS hatasıyla env'i oluşturamıyor ve paketleri base'e
# kuruyordu). Env + torch burada elle, sabit sürümlerle kurulur; setup.sh yalnızca
# derlenen eklentileri (flash-attn, nvdiffrast, nvdiffrec, cumesh, o-voxel, flexgemm)
# ekler.
#
# Build:  docker build -f runpod/Dockerfile -t <registry>/nexus-trellis2:latest .
# Push:   docker push <registry>/nexus-trellis2:latest

FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0" \
    CUDA_HOME=/usr/local/cuda \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    CONDA_DIR=/opt/conda
ENV PATH=$CONDA_DIR/bin:$PATH

# setup.sh içindeki `conda activate` bir bash fonksiyonudur; RUN'lar bash ile çalışmalı.
SHELL ["/bin/bash", "-c"]

# ── Sistem bağımlılıkları + Miniconda ──
# sudo: setup.sh --basic içindeki `sudo apt install libjpeg-dev` çağrısı için gerekli.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git wget ca-certificates build-essential ninja-build sudo \
        libjpeg-dev libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && wget -qO /tmp/miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh \
    && bash /tmp/miniconda.sh -b -p $CONDA_DIR \
    && rm /tmp/miniconda.sh

# ── TRELLIS.2 kaynağı (submodule'lar dahil) ──
RUN git clone -b main --recursive https://github.com/microsoft/TRELLIS.2.git /opt/TRELLIS.2

WORKDIR /opt/TRELLIS.2

# ── conda env "trellis2" (Python 3.10) ──
# conda-forge + --override-channels: defaults kanalının ToS onay kapısına hiç girmeyiz
# (setup.sh --new-env'in başarısız olduğu asıl neden buydu).
RUN conda create -y -n trellis2 -c conda-forge --override-channels python=3.10

# ── PyTorch 2.6.0 / CUDA 12.4 (elle) ──
# torch.version.cuda == 12.4, CUDA_HOME toolkit'i (12.4) ile eşleşir; eklenti
# derlemeleri (o_voxel/cumesh/flex_gemm) torch cpp_extension CUDA sürüm kontrolünü
# ancak böyle geçer. (Önceki hata: base'e kurulan torch cu13.0 vs toolkit 12.4.)
RUN conda run -n trellis2 pip install --no-cache-dir \
        torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124

# ── Resmi setup.sh: --new-env YOK; yalnızca derlenen eklentiler ──
# - conda.sh source + `conda activate trellis2`: pip/python trellis2'ye işaret etsin
#   (setup.sh çıplak `pip install` kullanır).
# - nvidia-smi shim: setup.sh'ın "Get system information" bloğu her çağrıda çalışır ve
#   `command -v nvidia-smi` yoksa "No supported GPU found" ile exit 1 verir; CPU-only
#   build makinesinde geçici shim ile PLATFORM=cuda seçilir, kurulum bitince kaldırılır.
# - Son satır: torch'un doğru env'de ve cuda 12.4 ile olduğunu doğrular.
RUN source "$CONDA_DIR/etc/profile.d/conda.sh" \
    && conda activate trellis2 \
    && printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/nvidia-smi && chmod +x /usr/local/bin/nvidia-smi \
    && . ./setup.sh --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh --o-voxel --flexgemm \
    && rm -f /usr/local/bin/nvidia-smi \
    && python -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda)"

# ── transformers'ı 4.57.x'e sabitle ──
# setup.sh `transformers`ı sürümsüz kurar; bu makinede en güncel sürüm 5.x geliyor.
# transformers 5.x'in tied-weights refaktörü, RMBG-2.0'ın (BiRefNet) remote-code
# modelini bozuyor: "'BiRefNet' object has no attribute 'all_tied_weights_keys'".
# 4.57.6 hem DinoV3'ü destekler (>=4.56.0) hem de bu kırılmayı içermez.
RUN conda run -n trellis2 pip install --no-cache-dir "transformers==4.57.6"

# ── RunPod SDK + handler bağımlılıkları (trellis2 env'ine) ──
RUN conda run -n trellis2 pip install --no-cache-dir runpod requests

ENV PYTHONPATH=/opt/TRELLIS.2
COPY runpod/handler.py /opt/TRELLIS.2/handler.py

# trellis2 conda env'i içinde handler'ı başlat
CMD ["conda", "run", "--no-capture-output", "-n", "trellis2", "python", "-u", "handler.py"]
