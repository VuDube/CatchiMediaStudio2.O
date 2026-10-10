#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public');
const required = [
  'public/index.html', 'public/app.js', 'public/styles.css', 'public/sw.js',
  'public/manifest.webmanifest', 'public/icon.svg', 'public/icon-192.png',
  'public/icon-512.png', 'public/offline.html', 'public/_headers',
  'src/index.js', 'src/lib/common.js', 'src/lib/projects.js',
  'src/lib/jobs.js', 'src/lib/media.js',
];
for (const relative of required) {
  try { statSync(join(root, relative)); } catch { throw new Error(`Required source or static asset is missing: ${relative}`); }
}
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const app = readFileSync(join(root, 'public/app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
if (!html.includes('href="/styles.css"') || !html.includes('src="/app.js"') || !html.includes('rel="manifest"')) throw new Error('PWA shell references are incomplete.');
if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html) || /<style\b/i.test(html)) throw new Error('Inline scripts/styles are disallowed by the production CSP.');
if (/innerHTML\s*=|eval\s*\(/.test(app)) throw new Error('Unsafe dynamic HTML/eval pattern detected in the production client.');
if (!manifest.name || !manifest.start_url || !Array.isArray(manifest.icons) || !manifest.icons.some((icon) => icon.sizes === '192x192') || !manifest.icons.some((icon) => icon.sizes === '512x512')) throw new Error('PWA manifest is missing required install icons.');
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
const embeddedAssets = {};
let totalBytes = 0;
let compressedBytes = 0;
for (const filename of readdirSync(publicDir).sort()) {
  if (filename.startsWith('_') || filename === 'favicon.ico') continue;
  const absolute = join(publicDir, filename);
  if (!statSync(absolute).isFile()) continue;
  const extension = extname(filename).toLowerCase();
  const contentType = contentTypes[extension];
  if (!contentType) throw new Error(`No static Content-Type configured for ${filename}.`);
  const bytes = readFileSync(absolute);
  const compressed = gzipSync(bytes, { level: 9 });
  totalBytes += bytes.length;
  compressedBytes += compressed.length;
  embeddedAssets[`/${filename}`] = { contentType, encoding: 'gzip', base64: compressed.toString('base64') };
}
if (totalBytes > 25 * 1024 * 1024) throw new Error('Static payload exceeds the configured safety limit.');
const source = readFileSync(join(root, 'src/index.js'), 'utf8');
const marker = 'globalThis.__CATCHI_EMBEDDED_ASSETS__';
if (!source.includes(marker)) throw new Error('Embedded static asset marker not found in src/index.js.');
const dist = join(root, 'dist');
mkdirSync(join(dist, 'lib'), { recursive: true });
for (const filename of readdirSync(join(root, 'src/lib'))) {
  if (filename.endsWith('.js') && statSync(join(root, 'src/lib', filename)).isFile()) copyFileSync(join(root, 'src/lib', filename), join(dist, 'lib', filename));
}
const bundle = source.replace(marker, JSON.stringify(embeddedAssets));
writeFileSync(join(dist, 'worker.js'), bundle);
console.log(`Validated ${required.length} source/static files and ${Object.keys(embeddedAssets).length} public assets.`);
console.log(`Static source ${Math.ceil(totalBytes / 1024)} KiB; embedded gzip payload ${Math.ceil(compressedBytes / 1024)} KiB.`);
console.log(`Generated dist/worker.js (${Math.ceil(Buffer.byteLength(bundle) / 1024)} KiB) and ${readdirSync(join(dist, 'lib')).length} Worker modules.`);
console.log('No inline script/style, innerHTML assignment, or eval() detected.');
