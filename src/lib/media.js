import { MAX_AUDIO_BYTES, cleanText, fail, json, readJSON, readJSONBody, readLimited, requireSameOrigin, reserveBudget, uid, validId, writeJSON } from './common.js';
import { getProject } from './projects.js';

export const MODELS = Object.freeze({
  text: '@cf/meta/llama-3.1-8b-instruct-fp8',
  image: '@cf/black-forest-labs/flux-1-schnell',
  speech: '@cf/myshell-ai/melotts',
  transcribe: '@cf/openai/whisper',
});
const OWNER = 'owner';
const JOB_TTL = 30 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_OUTPUT_BYTES = 4 * 1024 * 1024;
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac']);

function b64ToBytes(encoded) {
  const clean = String(encoded).replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) fail(502, 'invalid_provider_output', 'The provider returned invalid encoded media.');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x4000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(binary);
}

function detectImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  fail(502, 'invalid_provider_output', 'The image provider did not return a valid JPEG, PNG or WebP file.');
}

function normalizeAudioOutput(output) {
  if (output instanceof Uint8Array) return output;
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (ArrayBuffer.isView(output)) return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  if (typeof output === 'string') return b64ToBytes(output);
  if (output && typeof output.audio === 'string') return b64ToBytes(output.audio);
  fail(502, 'invalid_provider_output', 'The speech provider did not return an MP3 file.');
}

function assertMP3(bytes) {
  const id3 = bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const frame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!id3 && !frame) fail(502, 'invalid_provider_output', 'The speech provider returned an invalid MP3 file.');
}

function newJob(kind, prompt, projectId, model, details = {}) {
  return {
    schemaVersion: 1,
    id: uid(),
    ownerId: OWNER,
    projectId: projectId || null,
    kind,
    mode: kind,
    prompt,
    provider: 'cloudflare-workers-ai',
    model,
    details,
    createdAt: new Date().toISOString(),
  };
}

async function startSynchronousJob(env, job) {
  await writeJSON(env, `job:meta:${job.id}`, job, JOB_TTL);
  await env.METADATA.put(`jobs:by-time:${job.createdAt}:${job.id}`, job.id, { expirationTtl: JOB_TTL });
  await writeJSON(env, `job:state:${job.id}:running`, { state: 'running', updatedAt: new Date().toISOString() }, JOB_TTL);
}

async function finishJob(env, jobId, result) {
  await writeJSON(env, `job:result:${jobId}`, result, JOB_TTL);
  await writeJSON(env, `job:state:${jobId}:succeeded`, { state: 'succeeded', updatedAt: new Date().toISOString() }, JOB_TTL);
}

async function failJob(env, jobId) {
  await writeJSON(env, `job:state:${jobId}:failed`, { state: 'failed', updatedAt: new Date().toISOString(), error: 'The selected Workers AI model did not complete this request.' }, JOB_TTL);
}

async function projectIdFromBody(env, body) {
  if (!body.projectId) return null;
  const project = await getProject(env, body.projectId);
  return project.id;
}

async function saveAssetMeta(env, meta) {
  await writeJSON(env, `asset:meta:${meta.id}`, meta);
}

export async function generateImage(request, env) {
  requireSameOrigin(request);
  if (!env.AI || typeof env.AI.run !== 'function') fail(503, 'provider_unavailable', 'Cloudflare Workers AI is not configured.');
  const body = await readJSONBody(request);
  const prompt = cleanText(body.prompt, 2048, 'Image prompt', false);
  const steps = body.steps === undefined ? 4 : Number(body.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) fail(400, 'invalid_steps', 'FLUX.1 schnell supports 1–8 steps.');
  const seed = body.seed === undefined || body.seed === '' ? undefined : Number(body.seed);
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 1 || seed > 9999999999)) fail(400, 'invalid_seed', 'Seed must be an integer from 1 to 9,999,999,999.');
  const projectId = await projectIdFromBody(env, body);
  await reserveBudget(env, 'image');
  const job = newJob('image', prompt, projectId, MODELS.image, { steps, seed: seed ?? null });
  await startSynchronousJob(env, job);
  try {
    const input = { prompt, steps };
    if (seed !== undefined) input.seed = seed;
    const output = await env.AI.run(MODELS.image, input);
    if (typeof output?.image !== 'string' || output.image.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) fail(502, 'invalid_provider_output', 'The image provider returned an empty or oversized image.');
    const bytes = b64ToBytes(output.image);
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) fail(502, 'invalid_provider_output', 'The image provider returned an empty or oversized image.');
    const mimeType = detectImage(bytes);
    const asset = {
      schemaVersion: 1,
      id: uid(),
      ownerId: OWNER,
      projectId,
      jobId: job.id,
      type: 'image',
      title: prompt.slice(0, 120),
      prompt,
      provider: 'cloudflare-workers-ai',
      model: MODELS.image,
      mimeType,
      sizeBytes: bytes.byteLength,
      storage: 'browser-local',
      fileStoredInCloud: false,
      createdAt: new Date().toISOString(),
      retention: 'The media bytes are saved only in this browser when local storage succeeds; download a copy for durable retention.',
    };
    await saveAssetMeta(env, asset);
    await finishJob(env, job.id, { assetId: asset.id, mimeType, sizeBytes: asset.sizeBytes });
    return json({ asset, jobId: job.id, dataUrl: `data:${mimeType};base64,${output.image}` });
  } catch (error) {
    await failJob(env, job.id).catch(() => {});
    throw error;
  }
}

export async function generateSpeech(request, env) {
  requireSameOrigin(request);
  if (!env.AI || typeof env.AI.run !== 'function') fail(503, 'provider_unavailable', 'Cloudflare Workers AI is not configured.');
  const body = await readJSONBody(request);
  const prompt = cleanText(body.prompt, 1200, 'Speech text', false);
  const language = cleanText(body.language || 'en', 8, 'Language', false).toLowerCase();
  if (!['en', 'fr'].includes(language)) fail(400, 'unsupported_language', 'This model integration currently exposes English (en) and French (fr) only.');
  const projectId = await projectIdFromBody(env, body);
  await reserveBudget(env, 'speech');
  const job = newJob('speech', prompt, projectId, MODELS.speech, { language });
  await startSynchronousJob(env, job);
  try {
    const output = await env.AI.run(MODELS.speech, { prompt, lang: language });
    const bytes = normalizeAudioOutput(output);
    if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_OUTPUT_BYTES) fail(502, 'invalid_provider_output', 'The speech provider returned an empty or oversized audio file.');
    assertMP3(bytes);
    const mimeType = 'audio/mpeg';
    const asset = {
      schemaVersion: 1,
      id: uid(),
      ownerId: OWNER,
      projectId,
      jobId: job.id,
      type: 'speech',
      title: prompt.slice(0, 120),
      prompt,
      provider: 'cloudflare-workers-ai',
      model: MODELS.speech,
      language,
      mimeType,
      sizeBytes: bytes.byteLength,
      storage: 'browser-local',
      fileStoredInCloud: false,
      createdAt: new Date().toISOString(),
      retention: 'The media bytes are saved only in this browser when local storage succeeds; download a copy for durable retention.',
    };
    await saveAssetMeta(env, asset);
    await finishJob(env, job.id, { assetId: asset.id, mimeType, sizeBytes: asset.sizeBytes });
    return json({ asset, jobId: job.id, dataUrl: `data:${mimeType};base64,${bytesToB64(bytes)}` });
  } catch (error) {
    await failJob(env, job.id).catch(() => {});
    throw error;
  }
}

export async function transcribe(request, env) {
  requireSameOrigin(request);
  if (!env.AI || typeof env.AI.run !== 'function') fail(503, 'provider_unavailable', 'Cloudflare Workers AI is not configured.');
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_TYPES.has(contentType)) fail(415, 'unsupported_audio_type', 'Upload MP3, WAV, WebM, Ogg, MP4/M4A, AAC or FLAC audio.');
  const bytes = await readLimited(request, MAX_AUDIO_BYTES);
  if (!bytes.byteLength) fail(400, 'empty_audio', 'Choose an audio file before transcribing.');
  const filename = cleanText(request.headers.get('X-Filename') || 'audio-upload', 120, 'Filename');
  const projectId = request.headers.get('X-Project-Id') || null;
  if (projectId) await getProject(env, projectId);
  await reserveBudget(env, 'transcribe');
  const job = newJob('transcribe', `Transcription of ${filename}`, projectId, MODELS.transcribe, { mimeType: contentType, sizeBytes: bytes.byteLength });
  await startSynchronousJob(env, job);
  try {
    const output = await env.AI.run(MODELS.transcribe, { audio: Array.from(bytes) });
    const transcript = typeof output?.text === 'string' ? output.text.trim() : '';
    if (!transcript) fail(502, 'invalid_provider_output', 'The transcription provider returned no transcript.');
    const asset = {
      schemaVersion: 1,
      id: uid(),
      ownerId: OWNER,
      projectId,
      jobId: job.id,
      type: 'transcript',
      title: filename.slice(0, 120),
      prompt: `Transcription of ${filename}`,
      provider: 'cloudflare-workers-ai',
      model: MODELS.transcribe,
      mimeType: 'text/plain; charset=utf-8',
      sizeBytes: new TextEncoder().encode(transcript).byteLength,
      storage: 'kv-text',
      fileStoredInCloud: true,
      createdAt: new Date().toISOString(),
    };
    await writeJSON(env, `asset:meta:${asset.id}`, asset);
    await env.METADATA.put(`asset:content:${asset.id}`, transcript, { expirationTtl: 365 * 24 * 60 * 60 });
    const result = { text: transcript, assetId: asset.id, provider: job.provider, model: job.model };
    await writeJSON(env, `job:result:${job.id}`, result, JOB_TTL);
    await writeJSON(env, `job:state:${job.id}:succeeded`, { state: 'succeeded', updatedAt: new Date().toISOString() }, JOB_TTL);
    return json({ asset, jobId: job.id, transcript });
  } catch (error) {
    await failJob(env, job.id).catch(() => {});
    throw error;
  }
}

export async function saveTextAsset(request, env) {
  requireSameOrigin(request);
  const body = await readJSONBody(request);
  const title = cleanText(body.title || 'Untitled text', 120, 'Title', false);
  const content = cleanText(body.content, 12000, 'Text output', false);
  let projectId = null;
  if (body.projectId) projectId = (await getProject(env, body.projectId)).id;
  const asset = {
    schemaVersion: 1,
    id: uid(),
    ownerId: OWNER,
    projectId,
    jobId: validId(body.jobId) ? body.jobId : null,
    type: 'text',
    title,
    prompt: '',
    provider: body.provider === 'user-edited' ? 'user-edited' : 'cloudflare-workers-ai',
    model: cleanText(body.model || '', 120, 'Model'),
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: new TextEncoder().encode(content).byteLength,
    storage: 'kv-text',
    fileStoredInCloud: true,
    createdAt: new Date().toISOString(),
  };
  await writeJSON(env, `asset:meta:${asset.id}`, asset);
  await env.METADATA.put(`asset:content:${asset.id}`, content, { expirationTtl: 365 * 24 * 60 * 60 });
  return json({ asset }, 201);
}

async function findLegacyAsset(env, id) {
  for (const type of ['image', 'speech']) {
    const page = await env.METADATA.list({ prefix: `asset:${type}:`, limit: 100 });
    for (const key of page.keys) {
      if (!key.name.endsWith(`:${id}`)) continue;
      const meta = await readJSON(env, key.name);
      if (meta) return meta;
    }
  }
  return null;
}

export async function listAssets(env) {
  const modern = await env.METADATA.list({ prefix: 'asset:meta:', limit: 100 });
  const items = [];
  for (const key of modern.keys) {
    const asset = await readJSON(env, key.name);
    if (asset?.ownerId === OWNER) items.push(asset);
  }
  for (const type of ['image', 'speech']) {
    const legacy = await env.METADATA.list({ prefix: `asset:${type}:`, limit: 100 });
    for (const key of legacy.keys) {
      const asset = await readJSON(env, key.name);
      if (asset) items.push({ ...asset, legacy: true, fileStoredInCloud: true, legacyPublicRelease: asset.storage === 'github-release' });
    }
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return json({ items: items.slice(0, 100), warning: 'New image and speech bytes are retained in this browser only. Older GitHub Release assets were not migrated or deleted.' });
}

export async function getAsset(env, id) {
  if (!validId(id)) fail(400, 'invalid_asset_id', 'The asset ID is invalid.');
  const meta = await readJSON(env, `asset:meta:${id}`) || await findLegacyAsset(env, id);
  if (!meta || (meta.ownerId && meta.ownerId !== OWNER)) fail(404, 'asset_not_found', 'This asset does not exist or has expired.');
  if (meta.storage === 'kv-text') {
    const content = await env.METADATA.get(`asset:content:${id}`);
    if (content === null) fail(404, 'asset_content_missing', 'The saved text content is no longer available.');
    return json({ asset: meta, content });
  }
  return json({ asset: meta, content: null, availableHere: meta.storage !== 'browser-local' });
}

export async function deleteAsset(request, env, id) {
  requireSameOrigin(request);
  if (!validId(id)) fail(400, 'invalid_asset_id', 'The asset ID is invalid.');
  const meta = await readJSON(env, `asset:meta:${id}`);
  if (!meta || meta.ownerId !== OWNER) fail(404, 'asset_not_found', 'This asset does not exist or has already been deleted.');
  await env.METADATA.delete(`asset:meta:${id}`);
  await env.METADATA.delete(`asset:content:${id}`);
  return json({ deleted: true, assetId: id, cloudMediaDeleted: false });
}

function safeFilename(name) {
  return String(name || 'media').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'media';
}

async function downloadLegacyFromGitHub(env, assetId) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) fail(503, 'legacy_storage_unavailable', 'Legacy release storage is not configured for download.');
  const api = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${encodeURIComponent(assetId)}`;
  const response = await fetch(api, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CatchiMediaStudio-legacy-read-only',
    },
    redirect: 'manual',
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('Location');
    if (!location) fail(502, 'legacy_storage_error', 'The legacy storage provider returned an invalid redirect.');
    const file = await fetch(location, { redirect: 'follow' });
    if (!file.ok) fail(502, 'legacy_storage_error', 'The legacy asset could not be retrieved.');
    return file;
  }
  if (!response.ok) fail(502, 'legacy_storage_error', 'The legacy asset could not be retrieved.');
  return response;
}

export async function downloadLegacyAsset(env, id) {
  if (!validId(id)) fail(400, 'invalid_asset_id', 'The asset ID is invalid.');
  const meta = await findLegacyAsset(env, id);
  if (!meta) fail(404, 'asset_not_found', 'This asset does not exist or has expired.');
  let response;
  if (meta.storage === 'github-release') response = await downloadLegacyFromGitHub(env, meta.ghAssetId);
  else if (meta.storage === 'kv-inline') {
    const encoded = await env.METADATA.get(`blob:${id}`);
    if (!encoded) fail(404, 'asset_content_missing', 'The legacy media bytes have expired.');
    response = new Response(b64ToBytes(encoded));
  } else fail(404, 'asset_not_available', 'This file is not available from the server.');
  const headers = new Headers({
    ...Object.fromEntries(Object.entries(SECURITY_HEADERS_PLACEHOLDER)),
    'Content-Type': meta.contentType || meta.mimeType || 'application/octet-stream',
    'Content-Disposition': `inline; filename="${safeFilename(meta.filename || meta.id)}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(response.body, { status: 200, headers });
}

const SECURITY_HEADERS_PLACEHOLDER = { 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
