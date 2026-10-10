import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { MAIN_QUEUE } from '../src/lib/jobs.js';
import { sha256Hex } from '../src/lib/common.js';

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.has(key) ? this.values.get(key) : null; }
  async put(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }
}

const password = 'test-administrator-password-which-is-not-used-in-production';
const sessionSecret = 'a-deterministic-test-secret-only-for-local-unit-tests-000000000000';
let env;
let cookie;
let enqueued;
let modelCalls;

function makeMessage(body) {
  return { body, attempts: 1, acked: false, retried: false, ack() { this.acked = true; }, retry() { this.retried = true; } };
}

function req(path, { method = 'GET', body, headers = {}, authenticated = true } = {}) {
  const requestHeaders = new Headers(headers);
  if (method !== 'GET' && method !== 'HEAD') requestHeaders.set('Origin', 'https://studio.test');
  if (authenticated && cookie) requestHeaders.set('Cookie', cookie);
  let requestBody = body;
  if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    requestHeaders.set('Content-Type', requestHeaders.get('Content-Type') || 'application/json');
    requestBody = JSON.stringify(body);
  }
  return new Request(`https://studio.test${path}`, { method, headers: requestHeaders, body: requestBody });
}

async function json(response) { return response.json(); }

async function setup() {
  enqueued = [];
  modelCalls = [];
  env = {
    METADATA: new MemoryKV(),
    ADMIN_PASSWORD_HASH: await sha256Hex(password),
    SESSION_SECRET: sessionSecret,
    APP_VERSION: 'test-build',
    GENERATION_QUEUE: { async send(message) { enqueued.push(message); } },
    AI: {
      async run(model, input) {
        modelCalls.push({ model, input });
        if (model.includes('llama')) return { response: 'Real test model output.' };
        if (model.includes('flux')) return { image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') };
        if (model.includes('melotts')) return new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
        if (model.includes('whisper')) return { text: 'A real transcript result.' };
        throw new Error(`Unexpected model ${model}`);
      },
    },
  };
  cookie = '';
  const loginResponse = await worker.fetch(req('/api/auth/login', { method: 'POST', body: { password }, authenticated: false }), env);
  assert.equal(loginResponse.status, 200);
  cookie = loginResponse.headers.get('Set-Cookie').split(';')[0];
}

test('public health is truthful and private project routes reject unauthenticated requests', async () => {
  await setup();
  const health = await json(await worker.fetch(new Request('https://studio.test/api/health'), env));
  assert.equal(health.status, 'ok');
  assert.equal(health.capabilities.textToVideo.enabled, false);
  assert.equal(health.capabilities.imageGeneration.model, '@cf/black-forest-labs/flux-1-schnell');
  const response = await worker.fetch(req('/api/projects', { authenticated: false }), env);
  assert.equal(response.status, 401);
});

test('single-admin session creates, updates, and deletes an owner-scoped project', async () => {
  await setup();
  const createdResponse = await worker.fetch(req('/api/projects', { method: 'POST', body: { name: 'Launch', objective: 'Introduce the product', channels: ['Web', 'Email'] } }), env);
  assert.equal(createdResponse.status, 201);
  const created = (await json(createdResponse)).project;
  assert.equal(created.ownerId, undefined);
  const updatedResponse = await worker.fetch(req(`/api/projects/${created.id}`, { method: 'PATCH', body: { archived: true, templates: [{ name: 'Caption', prompt: 'Write a caption.' }] } }), env);
  const updated = (await json(updatedResponse)).project;
  assert.equal(updated.archived, true);
  assert.equal(updated.templates[0].name, 'Caption');
  const deleted = await worker.fetch(req(`/api/projects/${created.id}`, { method: 'DELETE' }), env);
  assert.equal(deleted.status, 200);
  assert.equal((await json(await worker.fetch(req('/api/projects'), env))).projects.length, 0);
});

test('text jobs are accepted once, call the real model adapter and store the returned output', async () => {
  await setup();
  const body = { prompt: 'Draft three welcome captions.', mode: 'caption' };
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'campaign-test-0001' };
  const first = await worker.fetch(req('/api/jobs', { method: 'POST', body, headers }), env);
  assert.equal(first.status, 202);
  const firstBody = await json(first);
  assert.equal(firstBody.job.status, 'queued');
  assert.equal(enqueued.length, 1);
  const duplicate = await worker.fetch(req('/api/jobs', { method: 'POST', body, headers }), env);
  assert.equal(duplicate.status, 200);
  assert.equal((await json(duplicate)).duplicate, true);
  assert.equal(enqueued.length, 1);
  const message = makeMessage(enqueued[0]);
  await worker.queue({ queue: MAIN_QUEUE, messages: [message] }, env);
  assert.equal(message.acked, true);
  const completed = (await json(await worker.fetch(req(`/api/jobs/${firstBody.job.id}`), env))).job;
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.text, 'Real test model output.');
  assert.equal(modelCalls[0].model, '@cf/meta/llama-3.1-8b-instruct-fp8');
});

test('image and speech endpoints validate actual provider bytes and record browser-local retention', async () => {
  await setup();
  const imageResponse = await worker.fetch(req('/api/generate/image', { method: 'POST', body: { prompt: 'A quiet lake at sunrise', steps: 4 } }), env);
  assert.equal(imageResponse.status, 200);
  const image = await json(imageResponse);
  assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(image.asset.storage, 'browser-local');
  assert.equal(image.asset.fileStoredInCloud, false);
  const speechResponse = await worker.fetch(req('/api/generate/speech', { method: 'POST', body: { prompt: 'Welcome to the studio.', language: 'en' } }), env);
  assert.equal(speechResponse.status, 200);
  const speech = await json(speechResponse);
  assert.match(speech.dataUrl, /^data:audio\/mpeg;base64,/);
  assert.equal(speech.asset.model, '@cf/myshell-ai/melotts');
  assert.equal(modelCalls.length, 2);
});

test('bounded raw audio upload transcribes and persists editable text', async () => {
  await setup();
  const headers = { Origin: 'https://studio.test', 'Content-Type': 'audio/mpeg', 'X-Filename': 'sample.mp3' };
  const response = await worker.fetch(req('/api/transcribe', { method: 'POST', body: new Uint8Array([1, 2, 3, 4]), headers }), env);
  assert.equal(response.status, 200);
  const data = await json(response);
  assert.equal(data.transcript, 'A real transcript result.');
  assert.equal(data.asset.storage, 'kv-text');
  assert.equal(modelCalls[0].model, '@cf/openai/whisper');
  assert.deepEqual(modelCalls[0].input.audio, [1, 2, 3, 4]);
});

test('cross-origin mutations and requests over the application estimate cap fail before inference', async () => {
  await setup();
  const crossOrigin = new Request('https://studio.test/api/generate/image', {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ prompt: 'image' }),
  });
  assert.equal((await worker.fetch(crossOrigin, env)).status, 403);
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  await env.METADATA.put(`quota:${day}:owner`, JSON.stringify({ calls: { image: 0 }, estimatedNeurons: 3000 }));
  const budget = await worker.fetch(req('/api/generate/image', { method: 'POST', body: { prompt: 'A test image' } }), env);
  assert.equal(budget.status, 429);
  assert.equal(modelCalls.length, 0);
});

test('logout revokes the server-side session', async () => {
  await setup();
  const response = await worker.fetch(req('/api/auth/logout', { method: 'POST', body: {} }), env);
  assert.equal(response.status, 200);
  const protectedResponse = await worker.fetch(req('/api/projects'), env);
  assert.equal(protectedResponse.status, 401);
});
