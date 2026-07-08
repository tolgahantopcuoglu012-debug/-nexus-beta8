"""
RunPod Serverless handler — Trellis 2 (microsoft/TRELLIS.2-4B) image → GLB.

Input (event["input"]):
    image       : str  — base64 (raw veya "data:image/...;base64,..." data URI) VEYA http(s) URL
    resolution  : int  — 1024 veya 1536 (GLB doku/mesh çözünürlüğü). Varsayılan 1024.
    seed        : int  — (opsiyonel) tekrarlanabilirlik için. Varsayılan 42.

Output:
    {
      "glb"        : str,   # base64 kodlu GLB dosyası
      "resolution" : int,
      "format"     : "glb",
      "seed"       : int
    }

Not: Model TRELLIS'in TrellisImageTo3DPipeline API'sini takip eder. TRELLIS 2
paket/isim ayrıntıları resmi sürümle değişebilir; MODEL_ID ve boru hattı
çağrıları gerekirse buradan güncellenir.
"""

import base64
import io
import os
import tempfile

import requests
from PIL import Image

import runpod

MODEL_ID = os.environ.get("TRELLIS_MODEL_ID", "microsoft/TRELLIS.2-4B")
ALLOWED_RESOLUTIONS = (1024, 1536)

# ── Model tek sefer yüklenir (cold start), sonraki isteklerde yeniden kullanılır ──
_pipeline = None


def _load_pipeline():
    """Trellis 2 boru hattını GPU'ya yükler (lazy, ilk istekte)."""
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    # spconv / attention backend seçimi — TRELLIS bunları ortamdan okur.
    os.environ.setdefault("ATTN_BACKEND", "flash-attn")
    os.environ.setdefault("SPCONV_ALGO", "native")

    from trellis.pipelines import TrellisImageTo3DPipeline

    pipe = TrellisImageTo3DPipeline.from_pretrained(MODEL_ID)
    pipe.cuda()
    _pipeline = pipe
    return _pipeline


def _load_image(image_ref: str) -> Image.Image:
    """base64 (data URI dahil) veya URL'den PIL Image üretir."""
    if not image_ref or not isinstance(image_ref, str):
        raise ValueError("image gerekli (base64 veya URL)")

    if image_ref.startswith("http://") or image_ref.startswith("https://"):
        resp = requests.get(image_ref, timeout=60)
        resp.raise_for_status()
        raw = resp.content
    else:
        # "data:image/png;base64,...." önekini ayıkla
        if image_ref.startswith("data:"):
            image_ref = image_ref.split(",", 1)[-1]
        raw = base64.b64decode(image_ref)

    return Image.open(io.BytesIO(raw)).convert("RGB")


def _to_glb_bytes(outputs, resolution: int) -> bytes:
    """Boru hattı çıktısından GLB dosyası üretip ham byte döner."""
    from trellis.utils import postprocessing_utils

    glb = postprocessing_utils.to_glb(
        outputs["gaussian"][0],
        outputs["mesh"][0],
        simplify=0.95,          # mesh sadeleştirme oranı
        texture_size=resolution,
    )

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=True) as tmp:
        glb.export(tmp.name)
        tmp.seek(0)
        return tmp.read()


def handler(event):
    job_input = event.get("input") or {}

    try:
        image_ref = job_input.get("image")
        resolution = int(job_input.get("resolution", 1024))
        seed = int(job_input.get("seed", 42))

        if resolution not in ALLOWED_RESOLUTIONS:
            return {"error": f"resolution 1024 veya 1536 olmalı (gelen: {resolution})"}

        image = _load_image(image_ref)
        pipeline = _load_pipeline()

        outputs = pipeline.run(image, seed=seed)
        glb_bytes = _to_glb_bytes(outputs, resolution)

        return {
            "glb": base64.b64encode(glb_bytes).decode("utf-8"),
            "resolution": resolution,
            "format": "glb",
            "seed": seed,
        }

    except Exception as exc:  # noqa: BLE001 — hata istemciye anlamlı dönsün
        return {"error": str(exc)}


runpod.serverless.start({"handler": handler})
