import { APP_NAME, APP_VERSION, HttpError, errorResponse, json, login, logout, readJSON, requireKV, verifySession } from './lib/common.js';
import { createProject, deleteProject, getProject, listProjects, updateProject, validProjectId } from './lib/projects.js';
import { cancelJob, consumeQueue, enqueueTextJob, getDailyBudget, getJobEndpoint, listJobs } from './lib/jobs.js';
import { deleteAsset, downloadLegacyAsset, generateImage, generateSpeech, getAsset, listAssets, saveTextAsset, transcribe, MODELS } from './lib/media.js';

// scripts/build.mjs replaces this marker with the bounded, public static-file map.
const EMBEDDED_ASSETS = globalThis.__CATCHI_EMBEDDED_ASSETS__ || {};
const APP_FALLBACK_VERSION = APP_VERSION;

async function health(env) {
  const configured = Boolean(env.ADMIN_PASSWORD_HASH && env.SESSION_SECRET && env.METADATA);
  return json({
    status: configured && env.METADATA && env.AI && env.GENERATION_QUEUE ? 'ok' : 'degraded',
    platform: APP_NAME,
    version: env.APP_VERSION || APP_FALLBACK_VERSION,
    authRequired: true,
    adminAuthConfigured: configured,
    providers: {
      cloudflareWorkersAI: Boolean(env.AI),
      privateKVMetadata: Boolean(env.METADATA),
      backgroundTextQueue: Boolean(env.GENERATION_QUEUE),
      externalFallbacks: false,
    },
    capabilities: {
      textGeneration: { enabled: Boolean(env.AI && env.GENERATION_QUEUE), model: MODELS.text, execution: 'queued' },
      imageGeneration: { enabled: Boolean(env.AI), model: MODELS.image, execution: 'synchronous; bytes returned to the browser' },
      speechGeneration: { enabled: Boolean(env.AI), model: MODELS.speech, execution: 'synchronous; bytes returned to the browser' },
      transcription: { enabled: Boolean(env.AI), model: MODELS.transcribe, maxUploadBytes: 512 * 1024 },
      videoPlanning: { enabled: Boolean(env.AI && env.GENERATION_QUEUE), execution: 'AI-generated script/storyboard text only' },
      textToVideo: { enabled: false, reason: 'No verified no-charge video-synthesis provider is configured.' },
      videoAssembly: { enabled: true, execution: 'browser MediaRecorder; requires supported browser/device' },
    },
    freeTierPolicy: {
      aiProvider: 'Cloudflare Workers AI only; no paid provider fallback',
      applicationDailyEstimateCap: 3000,
      applicationBudgetsAreEstimates: true,
      accountWideUsageAvailableHere: false,
    },
  });
}

async function ops(env) {
  const [budget, jobResponse] = await Promise.all([getDailyBudget(env), listJobs(env)]);
  const { jobs } = await jobResponse.json();
  const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) if (job.status in counts) counts[job.status] += 1;
  return json({
    version: env.APP_VERSION || APP_FALLBACK_VERSION,
    provider: { id: 'cloudflare-workers-ai', models: MODELS, enabled: Boolean(env.AI) },
    queue: { enabled: Boolean(env.GENERATION_QUEUE), maxJobsPerDay: 50, freeTierOperationsBudgetedPerJob: 3 },
    today: budget,
    recentJobCounts: counts,
    recentJobs: jobs,
    telemetryWarning: 'This dashboard reports application-side records only. It does not expose account-wide Cloudflare billing or exact AI usage.',
  });
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return json({ error: 'cors_disabled', message: 'Cross-origin API access is not enabled.' }, 403);
  if (path === '/api/health' && method === 'GET') return health(env);
  if (path === '/api/auth/session' && method === 'GET') {
    const session = await verifySession(request, env);
    return json({ authenticated: Boolean(session), expiresAt: session ? new Date(session.expiresAt * 1000).toISOString() : null });
  }
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(request, env);

  const session = await verifySession(request, env);
  if (!session) return json({ error: 'authentication_required', message: 'Sign in to use this private studio.' }, 401, { 'WWW-Authenticate': 'Session' });
  requireKV(env);

  if (path === '/api/projects' && method === 'GET') return json({ projects: await listProjects(env) });
  if (path === '/api/projects' && method === 'POST') return createProject(request, env);
  const projectMatch = path.match(/^\/api\/projects\/([a-f0-9]{24})$/);
  if (projectMatch) {
    const id = projectMatch[1];
    if (method === 'GET') return json({ project: await getProject(env, id) });
    if (method === 'PATCH') return updateProject(request, env, id);
    if (method === 'DELETE') return deleteProject(request, env, id);
  }

  if (path === '/api/jobs' && method === 'GET') return listJobs(env);
  if (path === '/api/jobs' && method === 'POST') return enqueueTextJob(request, env);
  const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9]{24})$/);
  if (jobMatch) {
    const id = jobMatch[1];
    if (method === 'GET') return getJobEndpoint(env, id);
    if (method === 'DELETE') return cancelJob(request, env, id);
  }

  if (path === '/api/generate/image' && method === 'POST') return generateImage(request, env);
  if (path === '/api/generate/speech' && method === 'POST') return generateSpeech(request, env);
  if (path === '/api/transcribe' && method === 'POST') return transcribe(request, env);

  if (path === '/api/assets' && method === 'GET') return listAssets(env);
  if (path === '/api/assets/text' && method === 'POST') return saveTextAsset(request, env);
  const assetMatch = path.match(/^\/api\/assets\/([a-f0-9]{24})$/);
  if (assetMatch) {
    const id = assetMatch[1];
    if (method === 'GET') return getAsset(env, id);
    if (method === 'DELETE') return deleteAsset(request, env, id);
  }
  const legacyDownload = path.match(/^\/asset\/([a-f0-9]{24})$/);
  if (legacyDownload && method === 'GET') return downloadLegacyAsset(env, legacyDownload[1]);
  if (path === '/api/ops' && method === 'GET') return ops(env);

  return json({ error: 'not_found', message: 'This API route does not exist.' }, 404);
}

const decodedAssetCache = new Map();

async function decodeEmbeddedAsset(path, asset) {
  if (decodedAssetCache.has(path)) return decodedAssetCache.get(path);
  const binary = atob(asset.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const compressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const decoded = new Uint8Array(await new Response(compressed).arrayBuffer());
  decodedAssetCache.set(path, decoded);
  return decoded;
}

async function serveStatic(request, env, url) {
  if (env.ASSETS?.fetch) return env.ASSETS.fetch(request);
  const assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const asset = EMBEDDED_ASSETS[assetPath];
  if (!asset) return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
  const headers = {
    'Content-Type': asset.contentType,
    'Cache-Control': assetPath === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(await decodeEmbeddedAsset(assetPath, asset), { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/asset/')) {
      return serveStatic(request, env, url);
    }
    try {
      return await handleApi(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async queue(batch, env) {
    try {
      await consumeQueue(batch, env);
    } catch (error) {
      // Leave unacknowledged Queue messages for Cloudflare's configured bounded retry policy.
      console.error('CatchiMediaStudio queue batch failed:', error?.name || 'Error');
      throw error;
    }
  },
};
