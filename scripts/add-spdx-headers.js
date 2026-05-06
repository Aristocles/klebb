#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/add-spdx-headers.js
// One-shot helper: insert SPDX + copyright headers into source files that
// don't already have one. Idempotent: files containing 'SPDX-License-Identifier'
// in their first 10 lines are skipped.
//
// Usage: node scripts/add-spdx-headers.js [--dry-run]

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const SPDX_LINE = 'SPDX-License-Identifier: AGPL-3.0-only';
const COPY_LINE = 'Copyright (C) 2026 Aristocles <https://github.com/Aristocles>';

// Comment style per extension.
// type values: 'line-slash' (//), 'line-hash' (#), 'block-html' (<!-- -->),
//              'block-c' (/* */ for CSS).
const STYLES = {
  '.js':      { type: 'line-slash' },
  '.css':     { type: 'block-c' },
  '.html':    { type: 'block-html' },
  '.sh':      { type: 'line-hash' },
  '.service': { type: 'line-hash' },
  '.yml':     { type: 'line-hash' },
  '.yaml':    { type: 'line-hash' },
};

// File globs to skip (relative to repo root).
const SKIP_PREFIXES = [
  'node_modules/',
  'public/js/components/_legacy-v1/',
  '.git/',
];

const SKIP_FILES = new Set([
  'scripts/add-spdx-headers.js', // this file; covered via normal path but keep explicit
]);

function listTrackedFiles() {
  const out = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function shouldSkip(rel) {
  if (SKIP_FILES.has(rel)) return true;
  for (const p of SKIP_PREFIXES) if (rel.startsWith(p)) return true;
  return false;
}

function styleFor(rel) {
  const ext = path.extname(rel);
  return STYLES[ext] || null;
}

function renderHeader(style) {
  const lines = [SPDX_LINE, COPY_LINE];
  if (style.type === 'line-slash') {
    return lines.map(l => '// ' + l).join('\n') + '\n';
  }
  if (style.type === 'line-hash') {
    return lines.map(l => '# ' + l).join('\n') + '\n';
  }
  if (style.type === 'block-html') {
    return '<!--\n  ' + lines.join('\n  ') + '\n-->\n';
  }
  if (style.type === 'block-c') {
    return '/*\n * ' + lines.join('\n * ') + '\n */\n';
  }
  throw new Error('unknown style ' + style.type);
}

function hasHeader(content) {
  const head = content.split('\n').slice(0, 10).join('\n');
  return head.includes('SPDX-License-Identifier');
}

function injectHeader(content, header, rel) {
  // HTML: DOCTYPE must stay on line 1.
  if (rel.endsWith('.html')) {
    const lines = content.split('\n');
    if (lines[0] && /^\s*<!doctype/i.test(lines[0])) {
      return lines[0] + '\n' + header + lines.slice(1).join('\n');
    }
    return header + content;
  }
  // Shebang lines must stay on line 1.
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n');
    if (nl === -1) return content + '\n' + header;
    return content.slice(0, nl + 1) + header + content.slice(nl + 1);
  }
  return header + content;
}

const files = listTrackedFiles();
const changed = [];
const skipped = [];
let scanned = 0;

for (const rel of files) {
  if (shouldSkip(rel)) continue;
  const style = styleFor(rel);
  if (!style) continue;
  scanned++;
  const abs = path.join(REPO, rel);
  const content = fs.readFileSync(abs, 'utf8');
  if (hasHeader(content)) { skipped.push(rel); continue; }
  const header = renderHeader(style);
  const next = injectHeader(content, header, rel);
  if (!DRY) fs.writeFileSync(abs, next);
  changed.push(rel);
}

console.log(`scanned:  ${scanned}`);
console.log(`changed:  ${changed.length}`);
console.log(`skipped:  ${skipped.length} (already had SPDX header)`);
if (DRY) console.log('(dry-run; no files written)');
if (process.env.VERBOSE) {
  console.log('\nchanged files:');
  changed.forEach(f => console.log('  + ' + f));
}
