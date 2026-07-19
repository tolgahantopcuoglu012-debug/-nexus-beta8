const REPLICATE_BASE = 'https://api.replicate.com/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function fetchWithBackoff(url, options, maxRetries = 4) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    if (attempt === maxRetries) return res;
    await new Promise(r => setTimeout(r, delay));
    delay *= 2;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === 'GET') {
      return json({ status: 'ok', service: 'nexus-replicate-proxy' });
    }
    if (request.method !== 'POST') {
      return err('Method Not Allowed', 405);
    }

    const url = new URL(request.url);

    // ── /download : GLB indirme proxy'si ──
    // Barındırıcı (tmpfiles) iki nedenle tarayıcıdan doğrudan çekilemez:
    //   1) /dl/<id>/<ad> linki 302 ile HTML ara sayfaya gider; gerçek dosya o sayfadaki
    //      token'lı /dl/<token>/<id>/<ad> linkindedir.
    //   2) Yanıtta Access-Control-Allow-Origin yok → tarayıcı fetch'i CORS'a takılır.
    // Bu uç ikisini de çözer: ara sayfayı çözümler ve gövdeyi CORS başlığıyla akıtır.
    if (url.pathname === '/download') {
      let dlBody;
      try {
        dlBody = await request.json();
      } catch {
        return err('Invalid JSON');
      }
      const target = Array.isArray(dlBody.url) ? dlBody.url[0] : String(dlBody.url || '');
      if (!target) return err('url gerekli');

      try {
        let res = await fetch(target, { redirect: 'follow' });
        if (!res.ok) return err(`Download upstream ${res.status}`, 502);

        if ((res.headers.get('Content-Type') || '').includes('text/html')) {
          const html = await res.text();
          const m = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+)"/);
          if (!m) return err('Barındırıcı ara sayfasında indirme linki bulunamadı', 502);
          res = await fetch(m[1], { redirect: 'follow' });
          if (!res.ok) return err(`Download upstream ${res.status}`, 502);
        }

        return new Response(res.body, {
          status: 200,
          headers: {
            ...CORS,
            'Content-Type': 'model/gltf-binary',
            'Cache-Control': 'no-store',
          },
        });
      } catch (e) {
        return err(`Download hatası: ${e.message}`, 502);
      }
    }

    // ── /flux : RunPod (FLUX.1-schnell, ComfyUI worker) text→görsel proxy ──
    // Temiz API: { prompt, num_images } → tek işte N varyant (farklı seed).
    // İçeride ComfyUI workflow JSON'una çevrilir; frontend workflow bilmez.
    // Çıktı: worker-comfyui { output: { images:[{type:"base64"|"s3_url", data}] } }.
    if (url.pathname === '/flux') {
      const RUNPOD_KEY = env.RUNPOD_API_KEY;
      const FLUX_ENDPOINT = env.FLUX_ENDPOINT_ID || 'ytp43akq7q07ts';
      if (!RUNPOD_KEY) return err('RUNPOD_API_KEY env tanımlı değil', 500);

      let fBody;
      try { fBody = await request.json(); } catch { return err('Invalid JSON'); }

      const FLUX_BASE = `https://api.runpod.ai/v2/${FLUX_ENDPOINT}`;
      const RP_AUTH = { 'Authorization': `Bearer ${RUNPOD_KEY}`, 'Content-Type': 'application/json' };

      // Durum sorgulama: { action:'poll', jobId }
      if (fBody.action === 'poll') {
        if (!fBody.jobId) return err('jobId gerekli');
        const res = await fetchWithBackoff(`${FLUX_BASE}/status/${fBody.jobId}`, { headers: RP_AUTH });
        return json(await res.json(), res.status);
      }

      if (!fBody.prompt) return err('prompt gerekli');
      // Trellis-hazır default şablon: tek obje, ortalanmış, düz arka plan, 3d ürün render.
      const SUFFIX = 'single object, centered, full object in frame, clean plain light-grey background, 3d product render, even studio lighting, no other objects, high detail';
      const promptText = `${String(fBody.prompt)}, ${SUFFIX}`;
      const n = Math.max(1, Math.min(4, parseInt(fBody.num_images) || 3)); // 1-4 varyant

      // ComfyUI flux1-schnell workflow: paylaşılan yükleyiciler + N sampler dalı.
      const wf = {
        '5':  { inputs:{ width:1024, height:1024, batch_size:1 }, class_type:'EmptyLatentImage' },
        '6':  { inputs:{ text:promptText, clip:['11',0] }, class_type:'CLIPTextEncode' },
        '10': { inputs:{ vae_name:'ae.safetensors' }, class_type:'VAELoader' },
        '11': { inputs:{ clip_name1:'t5xxl_fp8_e4m3fn.safetensors', clip_name2:'clip_l.safetensors', type:'flux' }, class_type:'DualCLIPLoader' },
        '12': { inputs:{ unet_name:'flux1-schnell.safetensors', weight_dtype:'fp8_e4m3fn' }, class_type:'UNETLoader' },
        '16': { inputs:{ sampler_name:'euler' }, class_type:'KSamplerSelect' },
        '17': { inputs:{ scheduler:'sgm_uniform', steps:4, denoise:1, model:['12',0] }, class_type:'BasicScheduler' },
        '22': { inputs:{ model:['12',0], conditioning:['6',0] }, class_type:'BasicGuider' },
      };
      for (let i = 0; i < n; i++) {
        const b = 100 + i*10;
        const seed = Math.floor(Math.random() * 2147483647) + 1;
        wf[String(b)]   = { inputs:{ noise_seed:seed }, class_type:'RandomNoise' };
        wf[String(b+1)] = { inputs:{ noise:[String(b),0], guider:['22',0], sampler:['16',0], sigmas:['17',0], latent_image:['5',0] }, class_type:'SamplerCustomAdvanced' };
        wf[String(b+2)] = { inputs:{ samples:[String(b+1),0], vae:['10',0] }, class_type:'VAEDecode' };
        wf[String(b+3)] = { inputs:{ filename_prefix:`variant_${i+1}`, images:[String(b+2),0] }, class_type:'SaveImage' };
      }

      const res = await fetchWithBackoff(`${FLUX_BASE}/run`, {
        method: 'POST', headers: RP_AUTH, body: JSON.stringify({ input:{ workflow:wf } }),
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw:text }; }
      return json(data, res.status);
    }

    // ── /generate : RunPod (Trellis 2) proxy ──
    // Anahtar koda gömülmez; RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID env'den okunur.
    if (url.pathname === '/generate') {
      const RUNPOD_KEY = env.RUNPOD_API_KEY;
      const RUNPOD_ENDPOINT = env.RUNPOD_ENDPOINT_ID;
      if (!RUNPOD_KEY || !RUNPOD_ENDPOINT) {
        return err('RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID env tanımlı değil', 500);
      }

      let genBody;
      try {
        genBody = await request.json();
      } catch {
        return err('Invalid JSON');
      }

      const RUNPOD_BASE = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT}`;
      const RP_AUTH = {
        'Authorization': `Bearer ${RUNPOD_KEY}`,
        'Content-Type': 'application/json',
      };

      // Durum sorgulama: { action: 'poll', jobId }
      if (genBody.action === 'poll') {
        if (!genBody.jobId) return err('jobId gerekli');
        const res = await fetchWithBackoff(`${RUNPOD_BASE}/status/${genBody.jobId}`, { headers: RP_AUTH });
        const data = await res.json();
        return json(data, res.status);
      }

      // İş başlatma: { image, resolution }
      if (!genBody.image) return err('image gerekli (base64 veya URL)');
      const resolution = Number(genBody.resolution) === 1536 ? 1536 : 1024;

      // Kalite/hız parametreleri opsiyonel; verilmezse handler'ın optimize baz konfigü
      // (steps=8 / texture_size=1024 / max_faces=150000) geçerli olur.
      const input = { image: genBody.image, resolution, seed: genBody.seed };
      for (const k of ['steps', 'texture_size', 'max_faces']) {
        if (genBody[k] !== undefined && genBody[k] !== null) input[k] = Number(genBody[k]);
      }

      // Trellis 2 üretimi uzun sürebildiği için async /run + poll kullanılır.
      console.log('[worker] generate -> runpod:', RUNPOD_ENDPOINT, '| resolution:', resolution);
      const res = await fetchWithBackoff(`${RUNPOD_BASE}/run`, {
        method: 'POST',
        headers: RP_AUTH,
        body: JSON.stringify({ input }),
      });
      const text = await res.text();
      console.log('[worker] generate status:', res.status);
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return json(data, res.status);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON');
    }

    console.log('[worker] action:', body.action, '| keys:', Object.keys(body).join(', '));

    const REPLICATE_KEY = env.REPLICATE_API_KEY;
    const AUTH = {
      'Authorization': `Bearer ${REPLICATE_KEY}`,
      'Content-Type': 'application/json',
    };

    try {
      // ── CREATE ──
      if (body.action === 'create') {
        const url = body.model
          ? `${REPLICATE_BASE}/models/${body.model}/predictions`
          : `${REPLICATE_BASE}/predictions`;

        const payload = { input: body.input };
        if (body.version) payload.version = body.version;

        console.log('[worker] create url:', url);
        console.log('[worker] create input keys:', Object.keys(body.input || {}).join(', '));
        const res = await fetchWithBackoff(url, { method: 'POST', headers: AUTH, body: JSON.stringify(payload) });
        const text = await res.text();
        console.log('[worker] create status:', res.status);
        console.log('[worker] create response:', text.slice(0, 500));
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        return json({ ...data, _debug: { status: res.status, url } }, res.status);
      }

      // ── POLL ──
      if (body.action === 'poll') {
        if (!body.predictionId) return err('predictionId gerekli');
        const res = await fetchWithBackoff(`${REPLICATE_BASE}/predictions/${body.predictionId}`, { headers: AUTH });
        const data = await res.json();
        return json(data, res.status);
      }

      // ── DOWNLOAD ──
      if (body.action === 'download') {
        if (!body.url) return err('url gerekli');
        // TripoSG (and some other models) may wrap the URI in an array
        const dlUrl = Array.isArray(body.url) ? body.url[0] : String(body.url);
        if (!dlUrl) return err('url geçersiz');
        const res = await fetch(dlUrl, { redirect: 'follow' });
        if (!res.ok) throw new Error(`Download upstream ${res.status}: ${dlUrl}`);
        const buffer = await res.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < uint8.length; i += 8192) {
          binary += String.fromCharCode(...uint8.subarray(i, i + 8192));
        }
        const base64 = btoa(binary);
        return json({ data: base64 });
      }

      return err('Bilinmeyen action');

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
