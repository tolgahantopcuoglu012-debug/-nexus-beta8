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
