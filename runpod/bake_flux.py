"""
Build-time ağırlık bake scripti — FLUX.1-schnell minimal diffusers worker.

Amaç: runtime'da HİÇ indirme olmasın; tüm ağırlıklar image'a gömülü gelsin.
Strateji (Ampere+Ada 24GB, hedef ~18-20GB image):
  1) transformer  : GGUF Q4_K_S (city96) — 4-bit, önceden quantize → ~6.8GB.
                    GPU'suz bake edilebilir (sadece indirme).
  2) text_encoder_2 (T5-XXL): bf16 indir → fp8_e4m3fn cast (CPU) → kaydet (~4.9GB).
  3) diğer bileşenler: vae, text_encoder(CLIP), tokenizer/2, scheduler, model_index,
     transformer/config.json — orijinal ~23.8GB transformer safetensors HARİÇ.

FLUX.1-schnell Apache-2.0 / ungated → HF token gerekmez.
"""
import os
import shutil
import torch
from huggingface_hub import hf_hub_download, snapshot_download
from transformers import T5EncoderModel

REPO = "black-forest-labs/FLUX.1-schnell"
GGUF_REPO = "city96/FLUX.1-schnell-gguf"
GGUF_FILE = "flux1-schnell-Q4_K_S.gguf"
MODEL_DIR = os.environ.get("MODEL_DIR", "/models")

os.makedirs(os.path.join(MODEL_DIR, "transformer"), exist_ok=True)

# 1) GGUF Q4 transformer (4-bit, ~6.8GB)
print("[bake] GGUF transformer indiriliyor...", flush=True)
gguf_path = hf_hub_download(
    GGUF_REPO, GGUF_FILE, local_dir=os.path.join(MODEL_DIR, "transformer")
)
print(f"[bake] gguf -> {gguf_path} ({os.path.getsize(gguf_path)/1e9:.1f}GB)", flush=True)

# 2) schnell repo — büyük transformer/T5 safetensors HARİÇ her şey
print("[bake] pipeline bileşenleri (vae/clip/tokenizer/scheduler/config)...", flush=True)
snapshot_download(
    REPO,
    local_dir=MODEL_DIR,
    allow_patterns=[
        "model_index.json",
        "scheduler/*",
        "vae/*",
        "text_encoder/*",       # CLIP (~246MB)
        "tokenizer/*",
        "tokenizer_2/*",
        "transformer/config.json",
    ],
)

# 3) T5-XXL -> fp8_e4m3fn cast (CPU) -> kaydet (~4.9GB)
print("[bake] T5-XXL bf16 indiriliyor + fp8 cast...", flush=True)
te2 = T5EncoderModel.from_pretrained(REPO, subfolder="text_encoder_2", torch_dtype=torch.bfloat16)
te2 = te2.to(torch.float8_e4m3fn)
te2.save_pretrained(os.path.join(MODEL_DIR, "text_encoder_2"))
print("[bake] T5 fp8 kaydedildi", flush=True)

# HF cache'ini temizle (image'i sismesin)
shutil.rmtree(os.environ.get("HF_HOME", "/tmp/hf"), ignore_errors=True)

# Özet
total = 0
for root, _, files in os.walk(MODEL_DIR):
    for f in files:
        total += os.path.getsize(os.path.join(root, f))
print(f"[bake] /models toplam: {total/1e9:.1f}GB", flush=True)
