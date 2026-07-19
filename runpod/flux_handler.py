"""
RunPod Serverless handler — FLUX.1-schnell (diffusers, ComfyUI YOK).

Minimal diffusers inference: GGUF Q4 (4-bit) transformer + fp8 T5, image'a baked.
Tüm ağırlıklar /models altında gömülü → runtime indirme YOK.

Input (event["input"]):
    prompt      : str  — zorunlu
    num_images  : int  — 1-4 varyant (farklı seed). Varsayılan 3.
    steps       : int  — schnell için 4 (varsayılan). denoise adımı.
    width/height: int  — varsayılan 1024.
    seed        : int  — (ops.) verilirse seed, seed+1, ... deterministik.

Output (worker.js /flux ile uyumlu):
    { "images": [ { "type":"base64", "data":<b64 PNG>, "filename":..., "seed":int }, ... ],
      "prompt": <tam prompt>, "steps": int }
    veya hata: { "error": "...", "trace": "..." }
"""
print("flux handler starting", flush=True)

import base64
import io
import os
import time
import traceback

import torch
import runpod

MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
GGUF_PATH = os.path.join(MODEL_DIR, "transformer", "flux1-schnell-Q4_K_S.gguf")

# Trellis-hazır şablon: tek obje, ortalı, düz arka plan (image→3D pipeline'ına uygun)
SUFFIX = ("single object, centered, full object in frame, clean plain light-grey "
          "background, 3d product render, even studio lighting, no other objects, high detail")

_pipe = None


def _load():
    global _pipe
    if _pipe is not None:
        return _pipe
    from diffusers import FluxPipeline, FluxTransformer2DModel, GGUFQuantizationConfig
    from transformers import T5EncoderModel

    t0 = time.time()
    print("[load] GGUF transformer...", flush=True)
    transformer = FluxTransformer2DModel.from_single_file(
        GGUF_PATH,
        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        config=os.path.join(MODEL_DIR, "transformer"),
        torch_dtype=torch.bfloat16,
    )
    print("[load] T5 (fp8 baked -> bf16)...", flush=True)
    te2 = T5EncoderModel.from_pretrained(
        os.path.join(MODEL_DIR, "text_encoder_2"), torch_dtype=torch.bfloat16
    )
    pipe = FluxPipeline.from_pretrained(
        MODEL_DIR,
        transformer=transformer,
        text_encoder_2=te2,
        torch_dtype=torch.bfloat16,
    )
    # 24GB VRAM'a sığması için katman-katman CPU offload.
    pipe.enable_model_cpu_offload()
    _pipe = pipe
    print(f"[load] pipe hazir {time.time() - t0:.1f}s", flush=True)
    return _pipe


def handler(event):
    try:
        inp = (event or {}).get("input", {}) or {}
        prompt = inp.get("prompt")
        if not prompt:
            return {"error": "prompt gerekli"}

        full = f"{prompt}, {SUFFIX}"
        n = max(1, min(4, int(inp.get("num_images", 3))))
        steps = int(inp.get("steps", 4))
        width = int(inp.get("width", 1024))
        height = int(inp.get("height", 1024))
        base_seed = inp.get("seed", None)

        pipe = _load()
        images = []
        for i in range(n):
            if base_seed is not None:
                seed = int(base_seed) + i
            else:
                seed = int(torch.randint(1, 2_147_483_647, (1,)).item())
            gen = torch.Generator(device="cpu").manual_seed(seed)
            # schnell guidance-distilled → guidance_scale=0.0
            img = pipe(
                full,
                num_inference_steps=steps,
                guidance_scale=0.0,
                width=width,
                height=height,
                generator=gen,
            ).images[0]
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            images.append({
                "type": "base64",
                "data": base64.b64encode(buf.getvalue()).decode(),
                "filename": f"variant_{i + 1}.png",
                "seed": seed,
            })
            print(f"[gen] variant {i + 1}/{n} seed={seed} ok", flush=True)

        return {"images": images, "prompt": full, "steps": steps}
    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc()}


runpod.serverless.start({"handler": handler})
