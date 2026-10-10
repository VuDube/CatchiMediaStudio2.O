#!/usr/bin/env node
/**
 * Build step for CatchiMediaStudio2.O.
 * Inlines public/index.html into src/index.js (replacing the
 * __STUDIO_HTML__ placeholder) and emits a single deployable
 * Worker module at dist/worker.js.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/index.js'), 'utf8');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');

// Escape for safe embedding inside a JS template literal.
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

if (!src.includes('__STUDIO_HTML__')) {
  throw new Error('Placeholder __STUDIO_HTML__ not found in src/index.js');
}

const out = src.replace('`__STUDIO_HTML__`', '`' + escaped + '`');
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/worker.js'), out);
console.log('Built dist/worker.js (' + Math.round(out.length / 1024) + ' KB, HTML inlined)');
