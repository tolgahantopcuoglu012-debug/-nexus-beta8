# Trellis 2 — RunPod Serverless

`microsoft/TRELLIS.2-4B` ile görüntüden (image → 3D) GLB üreten RunPod Serverless worker'ı.

| Dosya | Açıklama |
|-------|----------|
| `handler.py` | RunPod handler — `runpod-python` SDK. Input: `image` (base64/URL) + `resolution` (1024/1536). Output: base64 GLB. |
| `Dockerfile` | CUDA 12.1 tabanlı, Trellis 2 bağımlılıklarıyla. |

---

## Girdi / Çıktı sözleşmesi

**Request** (`input`):
```json
{
  "input": {
    "image": "data:image/png;base64,iVBOR...",   // base64, data URI veya http(s) URL
    "resolution": 1024,                            // 1024 | 1536 (varsayılan 1024)
    "seed": 42                                     // opsiyonel
  }
}
```

**Response** (`output`):
```json
{
  "glb": "Z2xURgIAAAA...",   // base64 kodlu GLB
  "resolution": 1024,
  "format": "glb",
  "seed": 42
}
```

Hata durumunda: `{ "error": "..." }`.

---

## Adım adım: RunPod'da endpoint kurulumu

### 1. Docker imajını derle ve push et
GPU derlemesi (flash-attn, nvdiffrast, kaolin) uzun sürer; iyi bir makinede yapın.
```bash
cd runpod
docker build -t <docker-kullanıcı>/nexus-trellis2:latest .
docker push <docker-kullanıcı>/nexus-trellis2:latest
```
> Alternatif: RunPod **GitHub entegrasyonu** ile bu repo/klasörden doğrudan build alabilirsiniz (Dockerfile yolu: `runpod/Dockerfile`).

### 2. Serverless Endpoint oluştur
1. [RunPod Console](https://www.runpod.io/console/serverless) → **Serverless** → **New Endpoint**.
2. **Container Image**: `<docker-kullanıcı>/nexus-trellis2:latest`.
3. **GPU**: Trellis 2 4B için ≥ 24 GB VRAM önerilir (A5000 / L4 / A100). 1536 çözünürlük için daha çok belleğe ihtiyaç olabilir.
4. **Container Disk**: ≥ 30 GB (model ağırlıkları + bağımlılıklar).
5. **Workers**: Min 0 (soğuk başlatma kabul edilebilirse), Max isteğe göre.
6. **Environment Variables** (opsiyonel):
   - `TRELLIS_MODEL_ID` — varsayılanı geçersiz kılmak için (varsayılan `microsoft/TRELLIS.2-4B`).
   - `HF_TOKEN` — model gated ise Hugging Face token'ı.
7. Kaydet. Endpoint hazır olunca **Endpoint ID**'yi not al.

### 3. RunPod API anahtarını al
RunPod Console → **Settings → API Keys** → yeni anahtar oluştur (`RUNPOD_API_KEY`).

### 4. Cloudflare Worker'ı bağla
`worker.js` içindeki `/generate` route'u RunPod'a proxy yapar. Anahtarlar **koda gömülmez**, Worker secret'ı olarak verilir:
```bash
wrangler secret put RUNPOD_API_KEY       # RunPod API anahtarı
wrangler secret put RUNPOD_ENDPOINT_ID   # 2. adımdaki Endpoint ID
wrangler deploy
```

### 5. Test
Doğrudan RunPod (async):
```bash
curl -X POST https://api.runpod.ai/v2/<ENDPOINT_ID>/run \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"image":"https://.../kedi.png","resolution":1024}}'
# → { "id": "...", "status": "IN_QUEUE" }

curl https://api.runpod.ai/v2/<ENDPOINT_ID>/status/<JOB_ID> \
  -H "Authorization: Bearer $RUNPOD_API_KEY"
# COMPLETED olduğunda output.glb (base64) döner
```

Worker üzerinden (önerilen — anahtar client'a sızmaz):
```bash
# İş başlat
curl -X POST https://nexus-replicate-proxy.<subdomain>.workers.dev/generate \
  -H "Content-Type: application/json" \
  -d '{"image":"data:image/png;base64,....","resolution":1536}'
# → { "id": "...", "status": "IN_QUEUE" }

# Durum sorgula
curl -X POST https://nexus-replicate-proxy.<subdomain>.workers.dev/generate \
  -H "Content-Type: application/json" \
  -d '{"action":"poll","jobId":"<JOB_ID>"}'
```

---

## Notlar
- **Soğuk başlatma:** İlk istekte model GPU'ya yüklenir (dakikalar sürebilir). Sonraki isteklerde sıcak worker yeniden kullanılır.
- **Zaman aşımı:** Trellis 2 üretimi uzun sürebildiği için Worker `runsync` yerine `run` + `status` (async poll) kullanır.
- **Model erişimi:** `microsoft/TRELLIS.2-4B` gated ise endpoint'e `HF_TOKEN` ekleyin.
- **Bağımlılık sürümleri:** `Dockerfile`'daki paket/derleme adımları TRELLIS'in resmi kurulumunu izler; TRELLIS 2 resmi talimatları güncellenirse buna göre uyarlayın.
