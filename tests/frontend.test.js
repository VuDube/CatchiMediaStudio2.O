import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
]);

test('all literal app.js ID selectors exist in the PWA document', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const appIds = new Set([...app.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map((match) => match[1]));
  assert.deepEqual([...appIds].filter((id) => !htmlIds.has(id)), []);
  assert.match(app, /\$\('#assemble-button'\)\.addEventListener\('click'/);
});

test('PWA install prompt is retained and invoked only by an explicit install-button action', () => {
  assert.match(html, /id="install-button"[^>]*hidden/);
  assert.match(app, /addEventListener\('beforeinstallprompt', \(event\) => \{\s*event\.preventDefault\(\);/);
  assert.match(app, /addEventListener\('click', async \(\) => \{\s*if \(!installPromptEvent\) return;/);
  assert.match(app, /await promptEvent\.prompt\(\)/);
  assert.match(app, /addEventListener\('appinstalled'/);
});
