"""
RunPod Serverless handler — FLUX.1-schnell (diffusers, ComfyUI YOK).

Bulletproof + self-diagnosing: worker HER durumda başlar (tepede yalnız runpod+stdlib
import edilir). Ağır importlar/model yükleme handler İÇİNDE try/except'e alınır →
herhangi bir hata opak worker-crash yerine görünür JOB ÇIKTISI (error+trace) olur.

Input (event["input"]):
    diag        : bool — True ise model YÜKLEMEDEN ortam/bellek/dosya raporu döner.
    prompt      : str  — üretim için zorunlu.
    num_images  : int  — 1-4 varyant (varsayılan 3).
    steps/width/height/seed : opsiyonel.

Output: { "images":[{type,data,filename,seed}], ... } | { "error","trace","stage",... }
"""
import base64
import io
import os
import sys
import time
import traceback

import runpod  # hafif, saf-python; tepede güvenli

MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
GGUF_PATH = os.path.join(MODEL_DIR, "transformer", "flux1-schnell-Q4_K_S.gguf")
SUFFIX = ("single object, centered, full object in frame, three-quarter view, "
          "slightly elevated camera angle, clean plain light-grey background, "
          "3d product render, even studio lighting, no other objects, high detail")

_pipe = None


def _diag():
    """Model yüklemeden ortam raporu — crash nedenini pinpoint için."""
    rep = {"stage": "diag", "python": sys.version.split()[0], "model_dir_exists": os.path.isdir(MODEL_DIR)}
    # /models içeriği
    try:
        listing = {}
        for sub in ["", "transformer", "vae", "text_encoder", "text_encoder_2", "scheduler", "tokenizer", "tokenizer_2"]:
            p = os.path.join(MODEL_DIR, sub)
            listing[sub or "."] = sorted(os.listdir(p)) if os.path.isdir(p) else "YOK"
        rep["models"] = listing
        rep["gguf_exists"] = os.path.isfile(GGUF_PATH)
        if os.path.isfile(GGUF_PATH):
            rep["gguf_gb"] = round(os.path.getsize(GGUF_PATH) / 1e9, 2)
    except Exception as e:
        rep["models_error"] = repr(e)
    # CPU RAM
    try:
        import psutil
        vm = psutil.virtual_memory()
        rep["cpu_ram_gb"] = {"total": round(vm.total / 1e9, 1), "available": round(vm.available / 1e9, 1)}
    except Exception as e:
        rep["psutil_error"] = repr(e)
    # torch + CUDA
    try:
        import torch
        rep["torch"] = torch.__version__
        rep["cuda_available"] = torch.cuda.is_available()
        rep["torch_cuda"] = torch.version.cuda
        if torch.cuda.is_available():
            rep["gpu"] = torch.cuda.get_device_name(0)
            free, total = torch.cuda.mem_get_info()
            rep["vram_gb"] = {"free": round(free / 1e9, 1), "total": round(total / 1e9, 1)}
    except Exception as e:
        rep["torch_error"] = repr(e)
        rep["torch_trace"] = traceback.format_exc()
    # kütüphane sürümleri
    for mod in ["diffusers", "transformers", "gguf", "accelerate"]:
        try:
            rep[mod] = __import__(mod).__version__
        except Exception as e:
            rep[mod] = f"IMPORT-FAIL: {e!r}"
    return rep


def _load():
    global _pipe
    if _pipe is not None:
        return _pipe
    import shutil
    import torch
    from diffusers import FluxPipeline, FluxTransformer2DModel, GGUFQuantizationConfig
    from transformers import T5EncoderModel

    # Niansuh aynasi scheduler'i 'config.json' olarak tutuyor; diffusers scheduler
    # yukleyicisi 'scheduler_config.json' bekliyor → runtime'da kopyala.
    sch = os.path.join(MODEL_DIR, "scheduler")
    src, dst = os.path.join(sch, "config.json"), os.path.join(sch, "scheduler_config.json")
    if os.path.isfile(src) and not os.path.isfile(dst):
        shutil.copy(src, dst)

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
        os.path.join(MODEL_DIR, "text_encoder_2"),
        torch_dtype=torch.bfloat16, low_cpu_mem_usage=True,
    )
    # KRITIK: fp8 baked agirliklar from_pretrained(torch_dtype=bf16) ile upcast OLMUYOR;
    # T5 fp8'de kalip "ufunc_add not implemented for Float8_e4m3fn" veriyor. Acikca cast.
    te2 = te2.to(torch.bfloat16)
    print("[load] FluxPipeline birleştir...", flush=True)
    pipe = FluxPipeline.from_pretrained(
        MODEL_DIR, transformer=transformer, text_encoder_2=te2,
        torch_dtype=torch.bfloat16, low_cpu_mem_usage=True,
    )
    pipe.enable_model_cpu_offload()   # 24GB'a sığması için
    _pipe = pipe
    print(f"[load] pipe hazir {time.time() - t0:.1f}s", flush=True)
    return _pipe


def handler(event):
    stage = "start"
    try:
        inp = (event or {}).get("input", {}) or {}
        if inp.get("diag"):
            return _diag()

        prompt = inp.get("prompt")
        if not prompt:
            return {"error": "prompt gerekli (veya diag:true)"}

        import torch
        full = f"{prompt}, {SUFFIX}"
        n = max(1, min(4, int(inp.get("num_images", 3))))
        steps = int(inp.get("steps", 4))
        width = int(inp.get("width", 1024))
        height = int(inp.get("height", 1024))
        base_seed = inp.get("seed", None)

        stage = "load"
        pipe = _load()

        stage = "generate"
        images = []
        for i in range(n):
            seed = int(base_seed) + i if base_seed is not None else int(torch.randint(1, 2_147_483_647, (1,)).item())
            gen = torch.Generator(device="cpu").manual_seed(seed)
            img = pipe(full, num_inference_steps=steps, guidance_scale=0.0,
                       width=width, height=height, generator=gen).images[0]
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            images.append({"type": "base64", "data": base64.b64encode(buf.getvalue()).decode(),
                           "filename": f"variant_{i + 1}.png", "seed": seed})
            print(f"[gen] variant {i + 1}/{n} seed={seed} ok", flush=True)
        return {"images": images, "prompt": full, "steps": steps}
    except Exception as e:
        return {"error": str(e), "stage": stage, "trace": traceback.format_exc()}


print("flux handler ready, starting serverless...", flush=True)
runpod.serverless.start({"handler": handler})
