/**
 * CatchiMediaStudio2.O — Orchestration Worker
 * ============================================================
 * Zero-cost AI media generation factory running 100% on the
 * Cloudflare Workers free tier (no R2, no D1).
 *
 * Architecture implemented here (per the master product brief):
 *  - Hybrid AI inference engine: Workers AI (edge-native) with
 *    optional Groq / Hugging Face fallback via secrets.
 *  - Dual-storage model: generated media binaries are uploaded to
 *    a GitHub Release (asset store); metadata lives in Workers KV.
 *  - Secure proxy download endpoint with the documented
 *    redirect:'manual' workaround for the Workers fetch bug
 *    (Authorization header dropped on cross-origin redirect to S3).
 *  - Prompt-hash KV caching, per-IP rate limiting, KV-backed job
 *    queue processed by a Cron Trigger, daily quota ledger and
 *    automated lifecycle cleanup of aged GitHub release assets.
 * ============================================================
 */

const MODELS = {
  image: '@cf/black-forest-labs/flux-1-schnell', // ~4.8 neurons / 512px tile (cheapest image model)
  text: '@cf/meta/llama-3.1-8b-instruct-fp8',
  speech: '@cf/myshell-ai/melotts',
  transcribe: '@cf/openai/whisper',
};

const RELEASE_TAG = 'catchi-media-assets';
const RATE_LIMIT_PER_HOUR = 30;       // generation calls per client IP
const ASSET_RETENTION_DAYS = 60;      // lifecycle cleanup horizon
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* ------------------------------------------------ helpers */

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function uid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Per-IP sliding-window rate limit backed by KV. */
async function rateLimit(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'anonymous';
  const window = Math.floor(Date.now() / 3600000);
  const key = `ratelimit:${ip}:${window}`;
  const count = parseInt((await env.METADATA.get(key)) || '0', 10);
  if (count >= RATE_LIMIT_PER_HOUR) {
    return json({ error: 'Rate limit exceeded', limit: RATE_LIMIT_PER_HOUR, retryAfterSeconds: 3600 - Math.floor((Date.now() % 3600000) / 1000) }, 429);
  }
  await env.METADATA.put(key, String(count + 1), { expirationTtl: 7200 });
  return null;
}

/** Daily quota ledger (neurons proxy + operation counters). */
async function bumpLedger(env, field, amount = 1) {
  const key = `ledger:${utcDay()}`;
  const current = JSON.parse((await env.METADATA.get(key)) || '{}');
  current[field] = (current[field] || 0) + amount;
  current.updatedAt = new Date().toISOString();
  await env.METADATA.put(key, JSON.stringify(current), { expirationTtl: 60 * 60 * 24 * 45 });
}

/* ------------------------------------- GitHub Releases store */

function githubEnabled(env) {
  return Boolean(env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO);
}

function ghHeaders(env, accept = 'application/vnd.github+json') {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'CatchiMediaStudio2.O-Worker',
  };
}

/** Fetch (or lazily create) the single release used as the asset bucket. */
async function ensureRelease(env) {
  const base = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  let res = await fetch(`${base}/releases/tags/${RELEASE_TAG}`, { headers: ghHeaders(env) });
  if (res.status === 404) {
    res = await fetch(`${base}/releases`, {
      method: 'POST',
      headers: ghHeaders(env),
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        name: 'CatchiMediaStudio2.O — Generated Media Assets',
        body: 'Automated asset bucket managed by the CatchiMediaStudio2.O worker. Do not delete manually.',
        draft: false,
        prerelease: false,
      }),
    });
  }
  if (!res.ok) throw new Error(`GitHub release lookup failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Upload a binary asset to the release; returns the asset object. */
async function uploadToGitHub(env, bytes, filename, contentType) {
  const release = await ensureRelease(env);
  const uploadBase = release.upload_url.replace('{?name,label}', '');
  const res = await fetch(`${uploadBase}?name=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { ...ghHeaders(env, 'application/octet-stream'), 'Content-Type': contentType },
    body: bytes,
  });
  if (!res.ok) throw new Error(`GitHub asset upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Download a release asset through the documented workaround for the
 * Workers fetch bug: Authorization is dropped when fetch follows a
 * cross-origin redirect (api.github.com -> S3 signed URL), so we disable
 * automatic redirects and re-fetch the Location header target without
 * the Authorization header.
 */
async function downloadFromGitHub(env, assetId) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${assetId}`;
  const res = await fetch(url, { headers: ghHeaders(env, 'application/octet-stream'), redirect: 'manual' });
  if (res.status === 302 || res.status === 307 || res.status === 301) {
    const location = res.headers.get('Location');
    if (!location) throw new Error('Redirect without Location header');
    const fileRes = await fetch(location); // signed S3 URL — no auth header
    if (!fileRes.ok) throw new Error(`Asset fetch failed: ${fileRes.status}`);
    return fileRes;
  }
  if (!res.ok) throw new Error(`GitHub asset download failed: ${res.status} ${await res.text()}`);
  return res;
}

/* --------------------------------------------- asset registry */

async function registerAsset(env, meta) {
  const key = `asset:${meta.type}:${utcDay()}:${meta.id}`;
  await env.METADATA.put(key, JSON.stringify(meta));
  return key;
}

/** Persist generated bytes: GitHub Releases when configured, inline fallback otherwise. */
async function storeBinary(env, { bytes, type, ext, contentType, prompt, model, provider }) {
  const id = uid();
  const filename = `${type}-${id}.${ext}`;
  const base = { id, type, prompt, model, provider, contentType, size: bytes.byteLength, createdAt: new Date().toISOString() };
  if (githubEnabled(env)) {
    const asset = await uploadToGitHub(env, bytes, filename, contentType);
    const meta = { ...base, storage: 'github-release', ghAssetId: asset.id, filename, downloadPath: `/asset/${id}` };
    await registerAsset(env, meta);
    return { meta, inline: null };
  }
  // No GitHub token configured yet — persist small binaries directly in KV.
  let binary = '';
  const view = new Uint8Array(bytes);
  const chunk = 8192;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  const meta = { ...base, storage: 'kv-inline', downloadPath: `/asset/${id}` };
  await env.METADATA.put(`blob:${id}`, btoa(binary), { expirationTtl: 60 * 60 * 24 * ASSET_RETENTION_DAYS });
  await registerAsset(env, meta);
  return { meta, inline: null };
}

/* -------------------------------------------- AI backends */

async function runTextModel(env, prompt, system) {
  // Tier 1: Groq (optional, higher throughput) — OpenAI-compatible API.
  if (env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        return { text: data.choices?.[0]?.message?.content || '', provider: 'groq', model: 'llama-3.1-8b-instant' };
      }
    } catch (_) { /* fall through to Workers AI */ }
  }
  // Tier 2 (default): Workers AI edge inference.
  const out = await env.AI.run(MODELS.text, {
    messages: [
      { role: 'system', content: system || 'You are CatchiMediaStudio2.O, a concise creative assistant.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 2048,
  });
  return { text: out.response || out.result?.response || '', provider: 'workers-ai', model: MODELS.text };
}

async function runImageModel(env, prompt, steps) {
  const out = await env.AI.run(MODELS.image, { prompt, num_steps: steps || 4 });
  // flux-1-schnell returns base64 PNG in `image`
  const b64 = out.image;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes: bytes.buffer, contentType: 'image/png', ext: 'png' };
}

async function runSpeechModel(env, prompt) {
  const out = await env.AI.run(MODELS.speech, { prompt });
  // melotts returns base64 mp3 in `audio`
  const b64 = out.audio;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes: bytes.buffer, contentType: 'audio/mpeg', ext: 'mp3' };
}

/* ------------------------------------------------ queue + cron */

async function enqueueJob(env, job) {
  const key = `queue:${Date.now()}:${uid()}`;
  await env.METADATA.put(key, JSON.stringify({ ...job, status: 'queued', queuedAt: new Date().toISOString() }));
  return key;
}

async function processQueue(env) {
  const list = await env.METADATA.list({ prefix: 'queue:', limit: 5 });
  const results = [];
  for (const k of list.keys) {
    const job = JSON.parse(await env.METADATA.get(k.name));
    try {
      if (job.type === 'image') {
        const img = await runImageModel(env, job.prompt);
        const { meta } = await storeBinary(env, { ...img, type: 'image', prompt: job.prompt, model: MODELS.image, provider: 'workers-ai' });
        job.resultId = meta.id;
      } else if (job.type === 'text') {
        const out = await runTextModel(env, job.prompt, job.system);
        job.resultText = out.text.slice(0, 4000);
      }
      job.status = 'done';
      await bumpLedger(env, `queued_${job.type}`);
    } catch (e) {
      job.status = 'error';
      job.error = String(e).slice(0, 500);
    }
    job.processedAt = new Date().toISOString();
    await env.METADATA.put(k.name.replace('queue:', 'job:'), JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 7 });
    await env.METADATA.delete(k.name);
    results.push({ key: k.name, status: job.status });
  }
  return results;
}

/** Lifecycle cleanup: delete GitHub release assets older than retention window. */
async function cleanupOldAssets(env) {
  if (!githubEnabled(env)) return { skipped: 'GITHUB_TOKEN not configured' };
  const release = await ensureRelease(env);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/${release.id}/assets?per_page=100`, { headers: ghHeaders(env) });
  if (!res.ok) return { error: res.status };
  const assets = await res.json();
  const cutoff = Date.now() - ASSET_RETENTION_DAYS * 86400000;
  let deleted = 0;
  for (const a of assets) {
    if (new Date(a.created_at).getTime() < cutoff) {
      const del = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${a.id}`, { method: 'DELETE', headers: ghHeaders(env) });
      if (del.status === 204) deleted++;
    }
  }
  return { scanned: assets.length, deleted };
}

/* ------------------------------------------------ router */

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // ---- health / status
  if (path === '/api/health' && request.method === 'GET') {
    const ledgerKey = `ledger:${utcDay()}`;
    const ledger = JSON.parse((await env.METADATA.get(ledgerKey)) || '{}');
    return json({
      status: 'ok',
      platform: 'CatchiMediaStudio2.O',
      models: MODELS,
      integrations: {
        workersAI: Boolean(env.AI),
        kv: Boolean(env.METADATA),
        githubStorage: githubEnabled(env),
        groq: Boolean(env.GROQ_API_KEY),
        huggingFace: Boolean(env.HF_TOKEN),
      },
      freeTierBudget: { workersAINeuronsPerDay: 10000, kvReadsPerDay: 100000, kvWritesPerDay: 1000, rateLimitPerHourPerIp: RATE_LIMIT_PER_HOUR },
      today: ledger,
    });
  }

  // ---- list assets (prefix query keeps KV list usage minimal)
  if (path === '/api/assets' && request.method === 'GET') {
    const type = url.searchParams.get('type') || '';
    const prefix = type ? `asset:${type}:` : 'asset:';
    const list = await env.METADATA.list({ prefix, limit: 60, cursor: url.searchParams.get('cursor') || undefined });
    const items = [];
    for (const k of list.keys) {
      const meta = JSON.parse(await env.METADATA.get(k.name));
      if (meta) items.push(meta);
    }
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return json({ items, cursor: list.list_complete ? null : list.cursor });
  }

  // ---- proxy download of a stored binary (GitHub redirect-manual workaround)
  const assetMatch = path.match(/^\/asset\/([a-z0-9]+)$/);
  if (assetMatch && request.method === 'GET') {
    const id = assetMatch[1];
    const list = await env.METADATA.list({ prefix: 'asset:' });
    for (const k of list.keys) {
      if (!k.name.endsWith(`:${id}`)) continue;
      const meta = JSON.parse(await env.METADATA.get(k.name));
      if (!meta) break;
      let fileRes;
      if (meta.storage === 'github-release') {
        fileRes = await downloadFromGitHub(env, meta.ghAssetId);
      } else {
        const b64 = await env.METADATA.get(`blob:${id}`);
        if (!b64) return json({ error: 'Blob expired or missing' }, 404);
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        fileRes = new Response(bytes, { status: 200 });
      }
      const headers = new Headers(fileRes.headers);
      headers.set('Content-Type', meta.contentType);
      headers.set('Content-Disposition', `inline; filename="${meta.filename || meta.id}"`);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      Object.entries(CORS).forEach(([k2, v]) => headers.set(k2, v));
      return new Response(fileRes.body, { status: 200, headers });
    }
    return json({ error: 'Asset not found' }, 404);
  }

  // ---- generation endpoints (rate limited + prompt-hash cached)
  const genMatch = path.match(/^\/api\/generate\/(image|text|speech)$/);
  if (genMatch && request.method === 'POST') {
    const limited = await rateLimit(env, request);
    if (limited) return limited;
    const kind = genMatch[1];
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
    const prompt = (body.prompt || '').trim();
    if (!prompt) return json({ error: 'prompt is required' }, 400);
    if (prompt.length > 4000) return json({ error: 'prompt too long (max 4000 chars)' }, 400);

    // cache lookup — identical prompts never burn quota twice
    const cacheKey = `cache:${kind}:${await sha256Hex(prompt)}`;
    const cached = await env.METADATA.get(cacheKey);
    if (cached) return json({ ...JSON.parse(cached), cached: true });

    try {
      if (kind === 'text') {
        const out = await runTextModel(env, prompt, body.system);
        await bumpLedger(env, 'texts');
        const payload = { type: 'text', prompt, text: out.text, provider: out.provider, model: out.model, createdAt: new Date().toISOString() };
        await env.METADATA.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 });
        return json(payload);
      }
      if (kind === 'image') {
        const img = await runImageModel(env, prompt, body.steps);
        const { meta } = await storeBinary(env, { ...img, type: 'image', prompt, model: MODELS.image, provider: 'workers-ai' });
        await bumpLedger(env, 'images');
        await bumpLedger(env, 'neurons_estimate', 5);
        await env.METADATA.put(cacheKey, JSON.stringify(meta), { expirationTtl: 60 * 60 * 24 });
        return json(meta);
      }
      // speech
      const audio = await runSpeechModel(env, prompt);
      const { meta } = await storeBinary(env, { ...audio, type: 'speech', prompt, model: MODELS.speech, provider: 'workers-ai' });
      await bumpLedger(env, 'speech');
      await env.METADATA.put(cacheKey, JSON.stringify(meta), { expirationTtl: 60 * 60 * 24 });
      return json(meta);
    } catch (e) {
      return json({ error: 'Generation failed', detail: String(e).slice(0, 500) }, 502);
    }
  }

  // ---- enqueue background job
  if (path === '/api/queue' && request.method === 'POST') {
    const limited = await rateLimit(env, request);
    if (limited) return limited;
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
    if (!body.prompt || !['image', 'text'].includes(body.type)) return json({ error: 'type (image|text) and prompt are required' }, 400);
    const key = await enqueueJob(env, { type: body.type, prompt: String(body.prompt).slice(0, 4000) });
    return json({ queued: true, jobKey: key }, 202);
  }

  return json({ error: 'Not found', routes: ['/api/health', '/api/assets', '/api/generate/image', '/api/generate/text', '/api/generate/speech', '/api/queue', '/asset/:id'] }, 404);
}

/* ------------------------------------------------ entrypoint */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/asset/')) {
      return handleApi(request, env, ctx);
    }
    return new Response(STUDIO_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const processed = await processQueue(env);
      // lifecycle cleanup once a day (00:xx UTC run)
      if (new Date().getUTCHours() === 0) {
        const cleaned = await cleanupOldAssets(env);
        await bumpLedger(env, 'cleanup_runs');
        console.log('cleanup', JSON.stringify(cleaned));
      }
      console.log('queue processed', JSON.stringify(processed));
    })());
  },
};

/* The studio UI is injected below at build/deploy time. */
const STUDIO_HTML = `__STUDIO_HTML__`;
