// netlify/functions/replicate.js
// Trellis (firtoz/trellis) için Replicate API proxy
// CORS sorununu çözer, API key'i gizler

const REPLICATE_KEY = process.env.REPLICATE_API_KEY || 'r8_HBUaxBMLz2JDs4T6yEsmCvYgrFcNjQ021WFFU';
const REPLICATE_BASE = 'https://api.replicate.com/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS, body: 'Invalid JSON' };
  }

  const AUTH = { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json' };

  try {
    // ── CREATE: Yeni prediction başlat ──
    if (body.action === 'create') {
      const url = body.model
        ? `${REPLICATE_BASE}/models/${body.model}/predictions`
        : `${REPLICATE_BASE}/predictions`;

      const payload = { input: body.input };
      if (body.version) payload.version = body.version;

      const res = await fetch(url, { method: 'POST', headers: AUTH, body: JSON.stringify(payload) });
      const data = await res.json();

      return {
        statusCode: res.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    // ── POLL: Prediction durumu sorgula ──
    if (body.action === 'poll') {
      if (!body.predictionId) return { statusCode: 400, headers: CORS, body: 'predictionId gerekli' };

      const res = await fetch(`${REPLICATE_BASE}/predictions/${body.predictionId}`, { headers: AUTH });
      const data = await res.json();

      return {
        statusCode: res.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    // ── DOWNLOAD: GLB dosyasını proxy'le (CORS bypass) ──
    if (body.action === 'download') {
      if (!body.url) return { statusCode: 400, headers: CORS, body: 'url gerekli' };

      const res = await fetch(body.url);
      if (!res.ok) throw new Error(`Download upstream ${res.status}`);

      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: base64 }),
      };
    }

    return { statusCode: 400, headers: CORS, body: 'Bilinmeyen action' };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

