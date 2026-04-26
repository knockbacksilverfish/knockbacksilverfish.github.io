function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function dayOfYear() {
  const now = new Date();
  return Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
}

const EXT_MAP = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

function validImageMagic(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  return false;
}

async function checkTurnstile(token, secret, ip) {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(ip)}`,
  });
  const data = await res.json();
  return data.success === true;
}

async function getRateLimit(env, ip) {
  const raw = await env.RATE_LIMIT.get(`rl:${ip}`);
  if (!raw) return { blocked: false };
  const data = JSON.parse(raw);
  if (Date.now() > data.resetAt) { await env.RATE_LIMIT.delete(`rl:${ip}`); return { blocked: false }; }
  return { blocked: data.count >= 5 };
}

async function recordFailure(env, ip) {
  const key = `rl:${ip}`;
  const raw = await env.RATE_LIMIT.get(key);
  const data = raw ? JSON.parse(raw) : { count: 0, resetAt: Date.now() + 3600000 };
  data.count += 1;
  await env.RATE_LIMIT.put(key, JSON.stringify(data), { expirationTtl: 3600 });
}

async function clearRateLimit(env, ip) {
  await env.RATE_LIMIT.delete(`rl:${ip}`);
}

async function dailyFromBucket(env, corsHeaders, workerUrl, prefix) {
  const list = await env.BUCKET.list({ prefix });
  const objects = list.objects.filter(o => o.key !== prefix && !o.key.endsWith('/'));
  if (!objects.length) return json({ error: `No images found in ${prefix}` }, 404, corsHeaders);
  const idx = dayOfYear() % objects.length;
  return json({ url: `${workerUrl}/img/${objects[idx].key}` }, 200, corsHeaders);
}

async function dailyMeme(env, corsHeaders, workerUrl) {
  // Check if a meme was manually selected for today
  const selectedKey = await env.RATE_LIMIT.get('memes:selected');
  if (selectedKey) return json({ url: `${workerUrl}/img/${selectedKey}` }, 200, corsHeaders);

  // Fall back to most recently uploaded
  const list = await env.BUCKET.list({ prefix: 'memes/uploads/' });
  const objects = list.objects.filter(o => !o.key.endsWith('/'));
  if (!objects.length) return json({ error: 'No memes' }, 404, corsHeaders);
  objects.sort((a, b) => b.key.localeCompare(a.key));
  return json({ url: `${workerUrl}/img/${objects[0].key}` }, 200, corsHeaders);
}

async function serveImage(env, key, corsHeaders) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
  return new Response(obj.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

async function upload(request, env, corsHeaders, ip) {
  if ((await getRateLimit(env, ip)).blocked)
    return json({ error: 'Too many failed attempts — try again in 1 hour' }, 429, corsHeaders);

  const fd = await request.formData();
  const password = fd.get('password');
  const file = fd.get('meme');
  const turnstileToken = fd.get('cf-turnstile-response');

  if (env.TURNSTILE_SECRET) {
    const valid = await checkTurnstile(turnstileToken || '', env.TURNSTILE_SECRET, ip);
    if (!valid) return json({ error: 'Bot check failed — reload and try again' }, 403, corsHeaders);
  }

  if (password !== env.UPLOAD_PASSWORD) {
    await recordFailure(env, ip);
    return json({ error: 'Invalid authorization' }, 401, corsHeaders);
  }

  if (!file || file.size === 0) return json({ error: 'No file provided' }, 400, corsHeaders);
  if (file.size > 10 * 1024 * 1024) return json({ error: 'File too large — 10MB max' }, 400, corsHeaders);

  const buffer = await file.arrayBuffer();
  if (!validImageMagic(new Uint8Array(buffer)))
    return json({ error: 'Invalid file — must be JPEG, PNG, GIF, or WebP' }, 400, corsHeaders);

  await clearRateLimit(env, ip);

  const ext = EXT_MAP[file.type] || 'jpg';
  const key = `memes/uploads/${Date.now()}.${ext}`;
  await env.BUCKET.put(key, buffer, { httpMetadata: { contentType: file.type } });

  return json({ success: true, key }, 200, corsHeaders);
}

async function selectMeme(request, env, corsHeaders, ip) {
  if ((await getRateLimit(env, ip)).blocked)
    return json({ error: 'Too many failed attempts — try again in 1 hour' }, 429, corsHeaders);

  const body = await request.json();
  const { password, key } = body;

  if (password !== env.UPLOAD_PASSWORD) {
    await recordFailure(env, ip);
    return json({ error: 'Invalid authorization' }, 401, corsHeaders);
  }

  // Verify the key actually exists in R2 before selecting it
  const obj = await env.BUCKET.head(key);
  if (!obj) return json({ error: 'Image not found' }, 404, corsHeaders);

  await clearRateLimit(env, ip);
  // Store selected key — expires at midnight so tomorrow starts fresh
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
  const ttl = Math.ceil((midnight - now) / 1000);
  await env.RATE_LIMIT.put('memes:selected', key, { expirationTtl: ttl });

  return json({ success: true }, 200, corsHeaders);
}

async function listMemes(env, corsHeaders, workerUrl) {
  const list = await env.BUCKET.list({ prefix: 'memes/uploads/' });
  const selectedKey = await env.RATE_LIMIT.get('memes:selected');
  const memes = list.objects
    .filter(o => !o.key.endsWith('/'))
    .sort((a, b) => b.key.localeCompare(a.key))
    .map(o => ({ url: `${workerUrl}/img/${o.key}`, key: o.key }));
  return json({ memes, selectedKey: selectedKey || null }, 200, corsHeaders);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const c = cors(env);

    try {
      const { pathname } = url;
      const workerUrl = `${url.protocol}//${url.host}`;
      const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

      if (request.method === 'OPTIONS') return new Response(null, { headers: c });

      if (pathname === '/daily-cat'  && request.method === 'GET') return dailyFromBucket(env, c, workerUrl, 'cats/');
      if (pathname === '/daily-bear' && request.method === 'GET') return dailyFromBucket(env, c, workerUrl, 'bears/');
      if (pathname === '/daily-meme' && request.method === 'GET') return dailyMeme(env, c, workerUrl);
      if (pathname.startsWith('/img/') && request.method === 'GET') return serveImage(env, pathname.slice(5), c);
      if (pathname === '/memes'  && request.method === 'GET')  return listMemes(env, c, workerUrl);
      if (pathname === '/upload' && request.method === 'POST') return upload(request, env, c, ip);
      if (pathname === '/select' && request.method === 'POST') return selectMeme(request, env, c, ip);

      return new Response('Not found', { status: 404, headers: c });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Internal error', detail: e.message }), {
        status: 500,
        headers: { ...c, 'Content-Type': 'application/json' },
      });
    }
  },
};
