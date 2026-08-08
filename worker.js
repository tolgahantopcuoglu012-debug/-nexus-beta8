const REPLICATE_BASE = 'https://api.replicate.com/v1';

// ── Prompt zenginleştirme (yalnız /flux) ────────────────────────────────────
// Trellis hard-surface objelerde iki şeyden çok zarar görür: parlak yansımalar
// (mesh'e sahte geometri olarak yazılır) ve kırpılmış kadraj (eksik gövde).
// Bu blok tek düzenleme noktasıdır — koda gömülü prompt string'i yoktur.
//
// KAPSAM SINIRI: buraya AÇI ifadesi yazılmaz. Açıyı RunPod handler'ındaki
// ANGLES belirler (3 varyant = ön 3/4 → tam yan → arka 3/4); prompt'a global
// "three-quarter view" eklemek "Yan"/"Arka" varyantlarıyla çelişir.
//
// NOT: FLUX.1-schnell distilled ve handler guidance_scale=0.0 ile çalışıyor →
// gerçek negative_prompt desteklenmiyor (true_cfg_scale>1 gerektirir, 4-adım
// davranışını bozar ve maliyeti ikiye katlar). İstenmeyenler bu yüzden
// AVOID içinde pozitif ifadeyle prompt'a yazılır.
const PROMPT_TUNING = {
  // Eşleşme İngilizce çeviri üzerinde yapılır; çeviri kapalıysa/başarısızsa diye
  // Türkçe karşılıklar da listede. Tek kelimeler token olarak (kelime sınırı),
  // boşluklu ifadeler alt-dizge olarak aranır — "car" → "cartoon" eşleşmez.
  HARD_SURFACE_KEYWORDS: [
    // araçlar (EN)
    'car', 'cars', 'vehicle', 'truck', 'van', 'pickup', 'bus', 'motorcycle',
    'motorbike', 'scooter', 'bicycle', 'bike', 'sedan', 'suv', 'coupe',
    'supercar', 'sports car', 'race car', 'muscle car', 'tank', 'train',
    'locomotive', 'tractor', 'bulldozer', 'excavator', 'forklift', 'crane',
    'trailer', 'buggy', 'kart', 'atv', 'rover', 'submarine', 'boat', 'ship',
    'yacht', 'plane', 'airplane', 'aircraft', 'jet', 'helicopter', 'drone',
    'spaceship', 'spacecraft', 'satellite', 'rocket',
    // makine / hard-surface (EN)
    'robot', 'mech', 'mecha', 'android', 'droid', 'engine', 'turbine',
    'machine', 'machinery', 'gadget', 'device', 'console', 'weapon', 'gun',
    'rifle', 'pistol', 'cannon', 'sword', 'blade', 'armor', 'armour', 'helmet',
    'shield', 'tool', 'wrench', 'hardware', 'chassis', 'wheel', 'tire',
    // eşya / mimari (EN)
    'furniture', 'chair', 'table', 'desk', 'lamp', 'shelf', 'cabinet',
    'building', 'house', 'tower', 'bridge', 'container', 'crate', 'barrel',
    'box', 'canister', 'turret', 'antenna',
    // TR karşılıklar
    'araba', 'araç', 'otomobil', 'kamyon', 'kamyonet', 'otobüs', 'motosiklet',
    'bisiklet', 'spor araba', 'tank', 'tren', 'traktör', 'vinç', 'denizaltı',
    'gemi', 'tekne', 'uçak', 'helikopter', 'drone', 'uzay gemisi', 'roket',
    'uydu', 'robot', 'motor', 'makine', 'silah', 'tüfek', 'top', 'kılıç',
    'zırh', 'kask', 'kalkan', 'alet', 'tekerlek', 'lastik', 'mobilya',
    'sandalye', 'masa', 'lamba', 'dolap', 'raf', 'bina', 'ev', 'kule',
    'köprü', 'konteyner', 'sandık', 'varil', 'kutu',
  ],

  // Tespit edilince prompt'a eklenen nitelikler (açı-nötr).
  //
  // SADELEŞTİRME (2026-08-09): "orta çağ taş ev" üretimi alakasız çıktı verince
  // zincir ölçüldü — FLUX'a giden nihai prompt 57-63 KELİME / 20 öbek oluyordu.
  // FLUX'un CLIP-L kodlayıcısı 77 token'da kesiyor ve schnell 4 adım/CFG-yok
  // konfigürasyonunda yoğun prompt takibinde zaten zayıf. Ekler seyreltiyordu.
  //
  // Silinen tekrarlar (handler'daki BASE zaten aynısını söylüyor):
  //   · 'clean light gray background' ← BASE: 'clean plain light-grey background'
  //   · 'soft studio lighting'        ← BASE: 'even studio lighting' (soft≠even, çelişki)
  //   · 'full body in frame'          ← BASE: 'full object in frame'
  // Sonuncusu ayrıca zararlıydı: "body" figür/beden kelimesi, bina prompt'unu
  // karakter okumasına itiyor olabilir.
  //
  // Geriye ölçülmüş şekilde işe yarayan tek nitelik kalıyor: mat yüzey.
  HARD_SURFACE_QUALIFIERS: [
    'matte surface',
  ],

  // İstenmeyenler — negative_prompt yerine pozitif ifade (yukarıdaki nota bak).
  // schnell olumsuzlamaları güvenilir takip etmiyor: A/B'de 'no reflections'
  // TUTTU (gövde belirgin şekilde matlaştı) ama 'no text' TUTMADI (hayalet yazı
  // yine çıktı). Tutmayanlar öbek yeri işgal ettiği için silindi.
  HARD_SURFACE_AVOID: [
    'no reflections',
  ],

  // ── Açı ön-eki (deneysel) ─────────────────────────────────────────────────
  // Gözlem: handler prompt'un SONUNA eklediği ANGLES ifadelerine FLUX.1-schnell
  // uymuyor — "Ön"/"Arka" düz karşıdan, "Yan" ise 3/4 çıkıyor. schnell 4 adımlık
  // distilled bir model; baştaki token'lara sondakilerden daha çok uyuyor.
  // Bu yüzden hard-surface prompt'ları açı ifadesiyle BAŞLATILIYOR.
  //
  // ⚠ BİLİNEN ÇAKIŞMA: Worker tüm varyantlar için TEK prompt yollar, açıyı ise
  // handler varyant başına kendisi ekler. Yani nihai prompt şöyle olur:
  //     "<ön-ek> <prompt>, ..nitelikler.., <handler'ın ANGLES ifadesi>, <BASE>"
  //   · varyant 1 (Ön)  → ön-ek ile handler AYNI şeyi söyler → pekiştirir ✓
  //   · varyant 2 (Yan) → ön-ek "3/4 ön" der, handler "tam yan profil" der ✗
  //   · varyant 3 (Arka)→ ön-ek "3/4 ön" der, handler "3/4 arka" der        ✗
  // Varyant başına ön-ek ancak handler değişikliğiyle (imaj rebuild) veya /flux'ı
  // 3 ayrı tek-görsellik işe bölmekle mümkün. Bu tur bilinçli olarak kabul edildi.
  //
  // ÖLÇÜM SONUCU (2026-08-09, "kırmızı spor araba", seed 184475924):
  // Ön-ek handler'ın sondaki ANGLES ifadesini GERÇEKTEN eziyor — hipotez doğru.
  // Ama Worker tüm varyantlara AYNI ön-eki yolladığı için 3 varyantın üçü de düz
  // cepheden çıktı: açı çeşitliliği tamamen kayboldu ve ön-ek olmadan elde edilen
  // tek iyi 3/4 kadraj da yok oldu. Yani net etki NEGATİF.
  // Bu yüzden varsayılan KAPALI. Varyant başına ön-ek ancak handler değişikliğiyle
  // (imaj rebuild) anlamlı olur; o zaman burayı true yapmak yeterli.
  HARD_SURFACE_ANGLE_PREFIX_ENABLED: false,
  HARD_SURFACE_ANGLE_PREFIX: 'three-quarter front view of',

  // Ön-ek eklenirken artikel tekrarını önle ("... of a a red car" olmasın).
  ARTICLE_WORDS: ['a', 'an', 'the'],
};

// ── Çeviri katmanı config'i ────────────────────────────────────────────────
// Risk: kısa Türkçe kelimeler İngilizce KISALTMAYA benziyor ve çevirmen onları
// kısaltma sanabiliyor — en bilinen vaka "ev" → "EV (electric vehicle)". Kullanıcı
// ev isterken elektrikli araç üretilir. Sistem prompt'u bu yorumu açıkça yasaklar
// ve kısa kelimelerde en yaygın günlük Türkçe anlamı şart koşar.
const TRANSLATION = {
  MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct',
  MAX_TOKENS: 256,
  SYSTEM: [
    'You translate 3D-object generation prompts from any language into English.',
    '',
    'RULES:',
    '- The input always describes a PHYSICAL OBJECT to be generated in 3D. Translate it as a concrete thing.',
    '- NEVER interpret the input as an abbreviation, acronym or initialism. A short Turkish word that looks',
    '  like an English acronym is an ordinary Turkish word, not an acronym.',
    '- For single or short words use the most common everyday Turkish meaning:',
    '  ev = house, at = horse, kar = snow, çay = tea, el = hand, ay = moon, göz = eye,',
    '  kol = arm, saat = clock, don = frost or underwear (choose by context), yüz = face.',
    '- If the text is already English, return it unchanged.',
    '- Reply with ONLY the English text — no quotes, no explanation, no preamble.',
  ].join('\n'),
};

// prompt içinde hard-surface anahtar kelimesi var mı? → eşleşen kelimeler
function hardSurfaceHits(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const tokens = new Set(t.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  // Set: 'robot'/'tank'/'drone' gibi EN+TR ortak kelimeler iki kez sayılmasın.
  const hits = new Set();
  for (const kw of PROMPT_TUNING.HARD_SURFACE_KEYWORDS) {
    if (kw.includes(' ') ? t.includes(kw) : tokens.has(kw)) hits.add(kw);
  }
  return [...hits];
}

// "three-quarter front view of" + "red sports car" → "... of a red sports car"
// Prompt zaten a/an/the ile başlıyorsa artikel eklenmez.
function withAnglePrefix(text) {
  const first = String(text).trim().split(/\s+/)[0].toLowerCase();
  const article = PROMPT_TUNING.ARTICLE_WORDS.includes(first) ? '' : 'a ';
  return `${PROMPT_TUNING.HARD_SURFACE_ANGLE_PREFIX} ${article}${text}`;
}

// Hard-surface ise açı ön-eki + nitelikleri ekler; organik prompt aynen döner.
function enrichPrompt(text) {
  const hits = hardSurfaceHits(text);
  if (!hits.length) {
    return { prompt: text, hardSurface: false, hits: [], anglePrefixed: false };
  }
  const extra = [...PROMPT_TUNING.HARD_SURFACE_QUALIFIERS, ...PROMPT_TUNING.HARD_SURFACE_AVOID];
  const usePrefix = PROMPT_TUNING.HARD_SURFACE_ANGLE_PREFIX_ENABLED;
  const body = usePrefix ? withAnglePrefix(text) : text;
  return {
    prompt: `${body}, ${extra.join(', ')}`,
    hardSurface: true,
    hits,
    anglePrefixed: usePrefix,
  };
}

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

      // İş başlatma: { prompt, num_images } → minimal diffusers handler (ComfyUI YOK).
      // SUFFIX artık RunPod handler'ında (3D-ideal açı dahil); frontend ham prompt yollar.
      // Çıktı (poll COMPLETED): output.images[] = [{ type:"base64", data, filename, seed }].
      if (!fBody.prompt) return err('prompt gerekli');
      const n = Math.max(1, Math.min(4, parseInt(fBody.num_images) || 3)); // 1-4 varyant

      // ── Prompt çevirisi (Türkçe/herhangi bir dil → İngilizce) ──
      // Flux İngilizce ister. Cloudflare Workers AI (aynı worker, harici API yok, ücretsiz
      // kota). Küçük instruct-LLM tek çağrıda hem dili algılar hem İngilizceyse aynen bırakır.
      // Çeviri hata verirse / AI binding yoksa orijinal prompt kullanılır (üretim kesilmez).
      // İstemci `translate:false` göndererek atlatabilir.
      let engPrompt = String(fBody.prompt);
      if (env.AI && fBody.translate !== false) {
        try {
          const ai = await env.AI.run(TRANSLATION.MODEL, {
            messages: [
              { role: 'system', content: TRANSLATION.SYSTEM },
              { role: 'user', content: engPrompt },
            ],
            max_tokens: TRANSLATION.MAX_TOKENS,
          });
          const t = ((ai && ai.response) || '').trim().replace(/^["']+|["']+$/g, '').trim();
          if (t) engPrompt = t;
        } catch (e) { /* çeviri başarısız / model yoksa → orijinal prompt (üretim kesilmez) */ }
      }

      // Hard-surface (araç/makine/eşya) prompt'larına Trellis-dostu nitelikler eklenir.
      // Tespit çeviri SONRASI, İngilizce metin üzerinde yapılır. Organik/karakter
      // prompt'ları hiç dokunulmadan geçer.
      const enriched = enrichPrompt(engPrompt);
      if (enriched.hardSurface) {
        console.log('[worker] hard-surface tespit:', enriched.hits.slice(0, 5).join(', '));
      }
      // Açı ön-eki handler'ın varyant-başına ANGLES ekiyle çakışabilir (config'teki
      // nota bak). Sessizce yaşanmasın diye her işte açıkça loglanır.
      const angleConflict = enriched.anglePrefixed && fBody.angles !== false;
      if (angleConflict) {
        console.warn('[worker] ⚠ açı çakışması olası: ön-ek "' +
          PROMPT_TUNING.HARD_SURFACE_ANGLE_PREFIX +
          '" tüm varyantlara giderken handler varyant başına ANGLES ekliyor ' +
          '→ varyant 1 (Ön) uyumlu, varyant 2 (Yan) ve 3 (Arka) çelişkili prompt alır.');
      }

      const input = { prompt: enriched.prompt, num_images: n };
      for (const k of ['steps', 'width', 'height', 'seed']) {
        if (fBody[k] !== undefined && fBody[k] !== null) input[k] = Number(fBody[k]);
      }

      // ── Kuru çalıştırma: { translate_only: true } ──
      // Çeviri + keyword tespiti + prompt kurgusunu döndürür, RunPod'a HİÇ gitmez.
      // Prompt/çeviri katmanını GPU yakmadan test etmek için (bir üretim ≈ 40 sn GPU).
      if (fBody.translate_only) {
        console.log('[worker] translate_only:', JSON.stringify(fBody.prompt), '->', JSON.stringify(engPrompt));
        return json({
          dry_run: true,
          _original: String(fBody.prompt),
          _translated: engPrompt,
          _prompt: enriched.prompt,
          _hard_surface: enriched.hardSurface,
          _hs_hits: enriched.hits,
          _angle_prefixed: enriched.anglePrefixed,
        });
      }

      const res = await fetchWithBackoff(`${FLUX_BASE}/run`, {
        method: 'POST', headers: RP_AUTH, body: JSON.stringify({ input }),
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw:text }; }
      return json({
        ...data,
        _translated: engPrompt,
        _prompt: enriched.prompt,
        _hard_surface: enriched.hardSurface,
        _hs_hits: enriched.hits,
        _angle_prefixed: enriched.anglePrefixed,
        _angle_conflict: angleConflict,
      }, res.status);
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
