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
