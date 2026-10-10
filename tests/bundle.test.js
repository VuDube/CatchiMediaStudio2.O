import test from 'node:test';
import assert from 'node:assert/strict';
import bundledWorker from '../dist/worker.js';

test('self-contained Worker serves the actual PWA shell with browser security headers', async () => {
  const response = await bundledWorker.fetch(new Request('https://studio.test/'), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/html/);
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'self'/);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(await response.text(), /CatchiMediaStudio/);
});

test('self-contained Worker serves compressed application code and valid install icons', async () => {
  const css = await bundledWorker.fetch(new Request('https://studio.test/styles.css'), {});
  assert.equal(css.status, 200);
  assert.match(css.headers.get('Content-Type'), /^text\/css/);
  assert.match(await css.text(), /prefers-reduced-motion/);
  const icon = await bundledWorker.fetch(new Request('https://studio.test/icon-192.png'), {});
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('Content-Type'), /^image\/png/);
  const signature = new Uint8Array(await icon.arrayBuffer()).slice(0, 8);
  assert.deepEqual([...signature], [137, 80, 78, 71, 13, 10, 26, 10]);
});
