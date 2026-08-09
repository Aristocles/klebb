// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/catalogue.js
// Parse ingested-report frontmatter, and build the system-prompt block
// that lists available reports for the read_report chat tool.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const ENV = require('../config/env');

// Parse an ingested report's frontmatter.
//
// Accepts v1 AND v2. Tightening this to v2 alone would silently orphan every
// report already on disk across every live instance plus the demo: they would
// vanish from the chat catalogue and lose their metadata in read_report, with
// nothing in a log to say why. v1 files are never rewritten, so v1 stays valid
// indefinitely and existing data is never at risk.
//
// The format is deliberately line-based rather than real YAML. The one list it
// supports is `bullets`, whose items are `- ` lines following the key.
function parseReportHeader(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const block = m[1];
  const sentinel = block.match(/^klebb_ingest:\s*v([12])\s*$/m);
  if (!sentinel) return null;
  const version = Number(sentinel[1]);

  const out = {};
  let lastKey = null;
  for (const line of block.split('\n')) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && lastKey) {
      if (!Array.isArray(out[lastKey])) out[lastKey] = [];
      out[lastKey].push(item[1].trim());
      continue;
    }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      // A key with an empty value opens a list; anything else is a scalar.
      out[key] = value === '' ? [] : value;
      lastKey = key;
    }
  }
  if (!out.ingested_at || !out.source_file || !out.source_format) return null;

  const scalar = (v) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    version,
    ingestedAt: out.ingested_at,
    sourceFile: out.source_file,
    sourceFormat: out.source_format,
    archivePath: scalar(out.archive_path),
    // v2 digest fields. A v1 file has none of these, so it reads as a plain
    // ready report needing no verification, which is what it has always been.
    status: scalar(out.status) || 'ready',
    verify: scalar(out.verify) || 'not_required',
    title: scalar(out.title),
    documentDate: scalar(out.document_date),
    relevance: scalar(out.relevance),
    ocrPsm: out.ocr_psm ? Number(out.ocr_psm) : null,
    reason: scalar(out.reason),
    bullets: Array.isArray(out.bullets) ? out.bullets : [],
  };
}

function listReportsWithMeta() {
  let entries;
  try {
    entries = fs.readdirSync(PATHS.REPORTS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.md') || f.startsWith('.') || f.startsWith('_')) continue;
    const abs = path.join(PATHS.REPORTS_DIR, f);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    const name = f.replace(/\.md$/, '');
    let header = null;
    try { header = parseReportHeader(fs.readFileSync(abs, 'utf8')); } catch {}
    out.push({ name, header });
  }
  out.sort((a, b) => {
    const ai = a.header?.ingestedAt || '';
    const bi = b.header?.ingestedAt || '';
    return bi.localeCompare(ai);
  });
  return out;
}

// Reports accepted by the upload endpoint whose bytes are not yet at their
// final inbox name. The window is the request body stream: a `.part` file is
// dot-prefixed and so invisible to _countInbox below, which without this
// counter lets two concurrent uploads at `used == max - 1` both pass the
// pre-check and land `max + 1` reports.
//
// Released on the rename into the inbox (the file becomes visible to the
// scan at that instant), and on every abort / error cleanup path.
let _pendingUploads = 0;

function notePendingUpload() { _pendingUploads++; }
function releasePendingUpload() { if (_pendingUploads > 0) _pendingUploads--; }
function pendingUploads() { return _pendingUploads; }

// Reports that count against the cap: top-level .md carrying the ingest
// sentinel. Hand-authored markdown and the demo fixtures parse to null and
// are deliberately free, so the demo does not burn slots and a hand-written
// PROFILE.md is never quota. Cheap enough to do uncached (<= a couple of
// dozen small files).
function countIngestedReports() {
  let entries;
  try { entries = fs.readdirSync(PATHS.REPORTS_DIR); } catch { return 0; }
  let n = 0;
  for (const f of entries) {
    if (!f.endsWith('.md') || f.startsWith('.') || f.startsWith('_')) continue;
    const abs = path.join(PATHS.REPORTS_DIR, f);
    try {
      if (!fs.statSync(abs).isFile()) continue;
      if (parseReportHeader(fs.readFileSync(abs, 'utf8'))) n++;
    } catch {}
  }
  return n;
}

// Inbox files awaiting or undergoing extraction. Same skip rule as the
// pipeline's _isProcessable, so staging (`.part`) and `_failed/` are excluded.
function _countInbox() {
  let entries;
  try { entries = fs.readdirSync(PATHS.INBOX_DIR); } catch { return 0; }
  let n = 0;
  for (const f of entries) {
    if (f.startsWith('.') || f.startsWith('_')) continue;
    try { if (fs.statSync(path.join(PATHS.INBOX_DIR, f)).isFile()) n++; } catch {}
  }
  return n;
}

function quota() {
  const max = ENV.REPORTS_MAX;
  const used = countIngestedReports() + _countInbox() + _pendingUploads;
  return { used, max, remaining: Math.max(0, max - used) };
}

function describeReportsCatalogue() {
  const entries = listReportsWithMeta();
  const lines = [
    '## Available reports',
    '',
    'The user has reports available in Klebb. Call `read_report(name)` to',
    'fetch the full text of any of them. Reports are markdown: either',
    'authored directly in $HEALTH_HOME/reports/, or extracted from PDFs,',
    'images, notes, and audio dropped into $HEALTH_HOME/inbox/.',
    '',
  ];
  if (!entries.length) {
    lines.push('_No reports yet. Drop a file into $HEALTH_HOME/inbox/ and Klebb will ingest it._');
    lines.push('');
    return lines.join('\n');
  }
  for (const e of entries) {
    if (e.header) {
      const date = e.header.ingestedAt.slice(0, 10);
      lines.push(`- \`${e.name}\` (${e.header.sourceFormat}, ingested ${date}, source: ${e.header.sourceFile})`);
    } else {
      lines.push(`- \`${e.name}\` (markdown report)`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  parseReportHeader,
  listReportsWithMeta,
  describeReportsCatalogue,
  countIngestedReports,
  quota,
  notePendingUpload,
  releasePendingUpload,
  pendingUploads,
};
