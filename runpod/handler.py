"""
RunPod Serverless handler — Trellis 2 (microsoft/TRELLIS.2-4B) image → GLB.

API, microsoft/TRELLIS.2 resmi örneğini (example.py) izler:
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    mesh = pipeline.run(image, pipeline_type=...)[0]
    glb  = o_voxel.postprocess.to_glb(...)

Input (event["input"]):
    image        : str  — base64 (raw / "data:image/...;base64,..." data URI) VEYA http(s) URL
    resolution   : int  — 1024 veya 1536. O-Voxel üretim çözünürlüğünü seçer
                          (run() pipeline_type parametresine eşlenir). Varsayılan 1024.
    seed         : int  — (opsiyonel) tekrarlanabilirlik. Varsayılan 42.
    texture_size : int  — (opsiyonel) GLB doku çözünürlüğü. Varsayılan 2048.

Output:
    { "glb": <base64 GLB>, "resolution": int, "format": "glb", "seed": int }
    veya hata: { "error": "..." }
"""

print("handler starting", flush=True)

import base64
import io
import os
import tempfile

import requests
from PIL import Image

import runpod

# TRELLIS.2 pipeline, backbone olarak gated facebook/dinov3-... modelini indiriyor.
# Bu repoya erişim için HF_TOKEN gerekli; endpoint'te tanımlıysa global olarak login ol.
# NOT: login BAŞARISIZ olursa (geçersiz token / ağ hatası) worker'ı KİLİTLEMEMELİ —
# aksi halde modül import anında ölür ve "unhealthy, exiting before processing jobs"
# olur. Bu yüzden try/except; token yine snapshot_download'a ayrıca geçiliyor.
HF_TOKEN = os.environ.get("HF_TOKEN")
if HF_TOKEN:
    try:
        from huggingface_hub import login as _hf_login

        _hf_login(token=HF_TOKEN, add_to_git_credential=False)
        print("hf login ok", flush=True)
    except Exception as _exc:  # noqa: BLE001
        print(f"hf login failed (non-fatal): {_exc}", flush=True)

print("handler module loaded", flush=True)

MODEL_ID = os.environ.get("TRELLIS_MODEL_ID", "microsoft/TRELLIS.2-4B")

# resolution → run() pipeline_type. TRELLIS.2 grid çözünürlüğünü bu string belirler.
RESOLUTION_TO_PIPELINE_TYPE = {
    1024: "1024",
    1536: "1536_cascade",
}
ALLOWED_RESOLUTIONS = tuple(RESOLUTION_TO_PIPELINE_TYPE.keys())

# ── Model tek sefer yüklenir (cold start), sonraki isteklerde yeniden kullanılır ──
_pipeline = None


def _load_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    from huggingface_hub import snapshot_download
    from trellis2.pipelines import Trellis2ImageTo3DPipeline

    # from_pretrained, config içindeki ckpts/... alt-model yollarını f"{path}/{ckpt}"
    # olarak çözer. path bir HF repo id ("microsoft/TRELLIS.2-4B") olduğunda bu birleşik
    # id geçersiz olur ve fallback "ckpts/..."yi AYRI bir repo sanıp indirmeye çalışır
    # → 401 Repository Not Found. Bu yüzden önce reponun TAMAMINI yerel bir klasöre indirip
    # from_pretrained'e o yerel yolu veriyoruz; ckpts/... artık yerel dosya olarak çözülür.
    local_dir = snapshot_download(MODEL_ID, token=HF_TOKEN)

    # pipeline config'leri GATED HF repolarına işaret ediyor (image_cond_model →
    # facebook/dinov3-..., rembg_model → briaai/RMBG-2.0). Endpoint'teki HF_TOKEN
    # geçersiz olduğundan bunlar runtime'da 401 veriyordu. Config'i indirilen snapshot
    # içinde UNGATED aynalarla değiştiriyoruz (public, token gerektirmez; RMBG aynası
    # trust_remote_code için birefnet.py/BiRefNet_config.py'yi de içeriyor).
    # (Sembolik linkleri gerçek dosyayla değiştirerek paylaşılan cache blob'u bozmayız.)
    gated_to_mirror = {
        "facebook/dinov3-vitl16-pretrain-lvd1689m": os.environ.get(
            "DINOV3_REPO", "camenduru/dinov3-vitl16-pretrain-lvd1689m"
        ),
        "briaai/RMBG-2.0": os.environ.get("RMBG_REPO", "camenduru/RMBG-2.0"),
    }
    for cfg_name in ("pipeline.json", "texturing_pipeline.json"):
        cfg_path = os.path.join(local_dir, cfg_name)
        if not os.path.exists(cfg_path):
            continue
        with open(cfg_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        patched = content
        for gated, mirror in gated_to_mirror.items():
            patched = patched.replace(gated, mirror)
        if patched != content:
            os.remove(cfg_path)  # snapshot symlink'ini kaldır, gerçek dosya yaz
            with open(cfg_path, "w", encoding="utf-8") as fh:
                fh.write(patched)
            print(f"patched {cfg_name}: gated repos -> ungated mirrors", flush=True)

    pipe = Trellis2ImageTo3DPipeline.from_pretrained(local_dir)
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
        if image_ref.startswith("data:"):
            image_ref = image_ref.split(",", 1)[-1]  # "data:image/png;base64," önekini at
        raw = base64.b64decode(image_ref)

    return Image.open(io.BytesIO(raw)).convert("RGB")


def _to_glb_bytes(mesh, texture_size: int) -> bytes:
    """MeshWithVoxel çıktısından GLB üretir (resmi o_voxel.postprocess.to_glb yolu)."""
    import o_voxel

    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=1000000,
        texture_size=texture_size,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=False,
    )

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=True) as tmp:
        glb.export(tmp.name, extension_webp=True)
        tmp.seek(0)
        return tmp.read()


# RunPod serverless çıktısı boyut-sınırlı: büyük base64 GLB'yi /status'a inline
# döndürünce output tamamen düşüyor (job COMPLETED ama output boş). Bu yüzden GLB'yi
# geçici bir dosya barındırıcıya yükleyip URL döndürüyoruz; yalnızca küçük dosyaları
# inline base64 olarak veriyoruz.
INLINE_MAX_BYTES = int(os.environ.get("GLB_INLINE_MAX_BYTES", 4_000_000))


def _upload_glb(glb_bytes: bytes) -> str:
    """GLB'yi geçici dosya barındırıcıya yükler, indirilebilir URL döndürür."""
    # 1) tmpfiles.org — JSON {"data":{"url": "https://tmpfiles.org/<id>/<name>"}}
    try:
        resp = requests.post(
            "https://tmpfiles.org/api/v1/upload",
            files={"file": ("nexus.glb", glb_bytes, "model/gltf-binary")},
            timeout=120,
        )
        resp.raise_for_status()
        url = resp.json()["data"]["url"]
        # sayfa URL'sini doğrudan-indirme URL'sine çevir (/<id>/ -> /dl/<id>/)
        return url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)
    except Exception as exc_tmp:  # noqa: BLE001
        last_err = f"tmpfiles: {exc_tmp}"

    # 2) 0x0.st — düz metin gövdede URL döner
    try:
        resp = requests.post(
            "https://0x0.st",
            files={"file": ("nexus.glb", glb_bytes, "model/gltf-binary")},
            headers={"User-Agent": "nexus-trellis2/1.0"},
            timeout=120,
        )
        resp.raise_for_status()
        return resp.text.strip()
    except Exception as exc_0x0:  # noqa: BLE001
        raise RuntimeError(f"GLB upload başarısız ({last_err}; 0x0: {exc_0x0})")


def handler(event):
    job_input = event.get("input") or {}

    try:
        image_ref = job_input.get("image")
        resolution = int(job_input.get("resolution", 1024))
        seed = int(job_input.get("seed", 42))
        texture_size = int(job_input.get("texture_size", 2048))

        if resolution not in ALLOWED_RESOLUTIONS:
            return {"error": f"resolution 1024 veya 1536 olmalı (gelen: {resolution})"}

        image = _load_image(image_ref)
        pipeline = _load_pipeline()

        mesh = pipeline.run(
            image,
            seed=seed,
            pipeline_type=RESOLUTION_TO_PIPELINE_TYPE[resolution],
        )[0]
        mesh.simplify(16777216)  # nvdiffrast limiti (resmi örnek)

        glb_bytes = _to_glb_bytes(mesh, texture_size=texture_size)

        result = {
            "resolution": resolution,
            "format": "glb",
            "seed": seed,
            "glb_size": len(glb_bytes),
        }
        # Küçükse inline base64; büyükse (RunPod output limiti) URL ile döndür.
        if len(glb_bytes) <= INLINE_MAX_BYTES:
            result["glb"] = base64.b64encode(glb_bytes).decode("utf-8")
        else:
            result["glb_url"] = _upload_glb(glb_bytes)
        return result

    except Exception as exc:  # noqa: BLE001 — hata istemciye anlamlı dönsün
        return {"error": str(exc)}


runpod.serverless.start({"handler": handler})
