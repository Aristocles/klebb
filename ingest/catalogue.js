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

// Ceiling on the whole block. It goes into EVERY chat turn, so an unbounded
// list is a permanent tax on the context budget. 20 reports of a title plus
// five capped bullets is a few KB; hand-authored files have no such caps, which
// is why the ceiling exists at all rather than being trusted to arithmetic.
const CATALOGUE_MAX_BYTES = 8000;

// Newest first, by the date IN the document, falling back to when it was
// ingested. The filename date is only ever the ingest date, so ordering by it
// would put a blood test from 2019 uploaded today above one from last month.
function _sortKey(entry) {
  return entry.header?.documentDate || entry.header?.ingestedAt || '';
}

function describeReportsCatalogue() {
  const entries = listReportsWithMeta()
    .slice()
    .sort((a, b) => _sortKey(b).localeCompare(_sortKey(a)) || a.name.localeCompare(b.name));

  const lines = [
    '## Available reports',
    '',
    'Health documents the user has uploaded (blood tests, scans, letters, notes,',
    'voice memos), newest first. Each entry shows what the document is and the',
    'date on the document itself. Call `read_report(name)` for the full text.',
    '',
    'Prefer the NEWEST report when the user asks about a current value ("what is',
    'my ferritin?"); reach for older ones only to compare or show a trend, and say',
    'which date you are quoting. A summary here is a digest, not the document: call',
    '`read_report` before quoting any specific figure.',
    '',
  ];

  if (!entries.length) {
    lines.push('_No reports yet. The user can add one from the Reports page in Klebb._');
    lines.push('');
    return lines.join('\n');
  }

  let truncatedAt = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const block = [];

    if (!e.header) {
      // Hand-authored markdown: no digest to show, and its body is NEVER
      // inlined here. That is what read_report is for.
      block.push(`- \`${e.name}\` (markdown note authored by the user)`);
    } else {
      const h = e.header;
      const date = h.documentDate || h.ingestedAt.slice(0, 10);
      const label = h.title || e.name;
      const bits = [`${h.sourceFormat}`, `dated ${date}`];
      if (!h.documentDate) bits[1] = `ingested ${h.ingestedAt.slice(0, 10)}, no date in the document`;
      block.push(`- \`${e.name}\` — ${label} (${bits.join(', ')})`);

      if (h.verify === 'required') {
        // Listed so the model knows it exists and can tell the user there is
        // something waiting, but with no bullets and no content: the text is
        // unchecked OCR. The hard stop is in read_report; this is the half that
        // stops the model quoting a digest it should not have.
        block.push('    content withheld pending OCR verification; tell the user to check it in Reports');
      } else if (h.status === 'rejected') {
        block.push('    flagged as not a health document; ignore unless the user asks about it');
      } else {
        if (h.status === 'raw') {
          block.push('    not summarised (raw extracted text); read it if the user asks about this document');
        }
        for (const b of h.bullets) block.push(`    - ${b}`);
      }
    }

    // Budget for the truncation notice too. Checking only the entry would let
    // the notice itself push the block over the ceiling, which is how a limit
    // ends up exceeded by exactly the line announcing the limit.
    const notice = `- _(${entries.length - i} older report(s) not listed here; ask the user if you need them.)_`;
    const candidate = lines.concat(block, [notice, '']).join('\n');
    if (Buffer.byteLength(candidate, 'utf8') > CATALOGUE_MAX_BYTES) {
      truncatedAt = entries.length - i;
      break;
    }
    lines.push(...block);
  }

  if (truncatedAt) {
    lines.push(`- _(${truncatedAt} older report(s) not listed here; ask the user if you need them.)_`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  parseReportHeader,
  CATALOGUE_MAX_BYTES,
  listReportsWithMeta,
  describeReportsCatalogue,
  countIngestedReports,
  quota,
  notePendingUpload,
  releasePendingUpload,
  pendingUploads,
};
