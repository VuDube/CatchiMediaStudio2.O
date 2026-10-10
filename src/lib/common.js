export const APP_NAME = 'CatchiMediaStudio';
export const APP_VERSION = '2.1.0';
export const OWNER_ID = 'owner';
export const SESSION_COOKIE = '__Host-catchi_session';
export const SESSION_SECONDS = 12 * 60 * 60;
export const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;
export const META_TTL_SECONDS = 365 * 24 * 60 * 60;
export const MAX_JSON_BYTES = 24 * 1024;
export const MAX_AUDIO_BYTES = 512 * 1024;
export const MAX_PROJECTS = 20;
export const MAX_DAILY_ESTIMATE = 3000;
export const DAILY_LIMITS = Object.freeze({ text: 50, image: 15, speech: 10, transcribe: 10 });
export const NEURON_RESERVATION = Object.freeze({ text: 1, image: 25, speech: 50, transcribe: 150 });
export const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

export function fail(status, code, message) {
  throw new HttpError(status, code, message);
}

export function uid() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 24);
}

export function utcDay() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function requireKV(env) {
  if (!env.METADATA) fail(503, 'storage_unavailable', 'Private metadata storage is not configured.');
}

export async function readJSON(env, key) {
  const value = await env.METADATA.get(key);
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function writeJSON(env, key, value, ttl = META_TTL_SECONDS) {
  await env.METADATA.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

export async function readLimited(request, maxBytes) {
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > maxBytes) fail(413, 'request_too_large', `Request exceeds the ${maxBytes} byte limit.`);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        fail(413, 'request_too_large', `Request exceeds the ${maxBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readJSONBody(request, maxBytes = MAX_JSON_BYTES) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) fail(415, 'unsupported_content_type', 'Send JSON with Content-Type: application/json.');
  const bytes = await readLimited(request, maxBytes);
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(body)) fail(400, 'invalid_body', 'The request body must be a JSON object.');
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

export function requireSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) fail(403, 'origin_rejected', 'This action must come from the CatchiMediaStudio site.');
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x4000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normal = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, '='));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signSession(payload, secret) {
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(encoded));
  return `${encoded}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySession(request, env) {
  if (!env.SESSION_SECRET || !env.METADATA) return null;
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (!token) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), fromBase64Url(signature), new TextEncoder().encode(encoded));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
    if (payload.v !== 1 || payload.sub !== 'owner' || !payload.sid || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!await env.METADATA.get(`session:${payload.sid}`)) return null;
    return { id: 'owner', sessionId: payload.sid, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function login(request, env) {
  requireSameOrigin(request);
  requireKV(env);
  if (typeof env.ADMIN_PASSWORD_HASH !== 'string' || !/^[a-f0-9]{64}$/i.test(env.ADMIN_PASSWORD_HASH) || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) {
    fail(503, 'auth_not_configured', 'Administrator sign-in is not configured. Complete the secure deployment setup.');
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failureKey = `auth:failed:${(await sha256Hex(`${env.SESSION_SECRET}:${ip}`)).slice(0, 32)}`;
  const attempts = Number((await env.METADATA.get(failureKey)) || 0);
  if (attempts >= 8) fail(429, 'login_rate_limited', 'Too many sign-in attempts. Wait 15 minutes before trying again.');
  const body = await readJSONBody(request, 2048);
  if (typeof body.password !== 'string' || !body.password || body.password.length > 256) fail(400, 'invalid_password', 'Enter the administrator password.');
  const submitted = await sha256Hex(body.password);
  if (!equalHex(submitted, env.ADMIN_PASSWORD_HASH.toLowerCase())) {
    await env.METADATA.put(failureKey, String(attempts + 1), { expirationTtl: 900 });
    fail(401, 'invalid_credentials', 'The password was not accepted.');
  }
  await env.METADATA.delete(failureKey);
  const sid = uid();
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await env.METADATA.put(`session:${sid}`, 'active', { expirationTtl: SESSION_SECONDS });
  const cookie = await signSession({ v: 1, sub: 'owner', sid, exp }, env.SESSION_SECRET);
  return json({ authenticated: true, expiresAt: new Date(exp * 1000).toISOString() }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${cookie}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
  });
}

export async function logout(request, env) {
  requireSameOrigin(request);
  const session = await verifySession(request, env);
  if (session) await env.METADATA.delete(`session:${session.sessionId}`);
  return json({ authenticated: false }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  });
}

export function cleanText(value, maxLength, label, allowEmpty = true) {
  if (value === undefined || value === null) {
    if (allowEmpty) return '';
    fail(400, 'invalid_input', `${label} is required.`);
  }
  if (typeof value !== 'string') fail(400, 'invalid_input', `${label} must be text.`);
  const text = value.trim();
  if (!allowEmpty && !text) fail(400, 'invalid_input', `${label} is required.`);
  if (text.length > maxLength) fail(400, 'input_too_long', `${label} must be ${maxLength} characters or fewer.`);
  return text;
}

export function validId(id) {
  return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
}

export async function reserveBudget(env, kind) {
  if (!DAILY_LIMITS[kind]) fail(403, 'capability_not_supported', 'This generation workflow is not enabled.');
  const key = `quota:${utcDay()}:owner`;
  const current = await readJSON(env, key) || { calls: {}, estimatedNeurons: 0, updatedAt: null };
  const nextCalls = Number(current.calls?.[kind] || 0) + 1;
  const reserve = NEURON_RESERVATION[kind];
  if (nextCalls > DAILY_LIMITS[kind]) fail(429, 'daily_job_limit', `The application daily ${kind} limit (${DAILY_LIMITS[kind]}) has been reached. Try again after 00:00 UTC.`);
  if (Number(current.estimatedNeurons || 0) + reserve > MAX_DAILY_ESTIMATE) {
    fail(429, 'application_budget_exhausted', 'The application’s conservative daily AI budget is exhausted. No provider request was sent.');
  }
  const updated = {
    schemaVersion: 1,
    calls: { ...(current.calls || {}), [kind]: nextCalls },
    estimatedNeurons: Number(current.estimatedNeurons || 0) + reserve,
    updatedAt: new Date().toISOString(),
  };
  await writeJSON(env, key, updated, 2 * 24 * 60 * 60);
  return updated;
}

export async function errorResponse(error) {
  if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status, error.headers);
  // Do not log prompts, model responses, account identifiers, or provider credentials.
  console.error('CatchiMediaStudio request failed:', error?.name || 'Error');
  return json({ error: 'internal_error', message: 'The request could not be completed. Try again or check system health.' }, 500);
}
