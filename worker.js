const REPLICATE_BASE = 'https://api.replicate.com/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return new Response(msg, { status, headers: CORS });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response('', { status: 200, headers: CORS });
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

    const REPLICATE_KEY = env.REPLICATE_API_KEY || 'r8_HBUaxBMLz2JDs4T6yEsmCvYgrFcNjQ021WFFU';
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

        const res = await fetch(url, { method: 'POST', headers: AUTH, body: JSON.stringify(payload) });
        const data = await res.json();
        return json(data, res.status);
      }

      // ── POLL ──
      if (body.action === 'poll') {
        if (!body.predictionId) return err('predictionId gerekli');
        const res = await fetch(`${REPLICATE_BASE}/predictions/${body.predictionId}`, { headers: AUTH });
        const data = await res.json();
        return json(data, res.status);
      }

      // ── DOWNLOAD ──
      if (body.action === 'download') {
        if (!body.url) return err('url gerekli');
        const res = await fetch(body.url);
        if (!res.ok) throw new Error(`Download upstream ${res.status}`);
        const buffer = await res.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        return json({ data: base64 });
      }

      return err('Bilinmeyen action');

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
