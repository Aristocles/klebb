// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/reports-api.js
// The data layer behind /api/reports and its management actions.
//
// Kept out of server.js because it is real logic (frontmatter rewriting, path
// containment, quota interplay) rather than routing, and because the traversal
// guards below want unit tests that do not need an HTTP server.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const catalogue = require('../ingest/catalogue');
const { nextRung, rungLabel } = require('../ingest/reader');
const { parseReportHeader } = catalogue;

// Internal files that are not user reports.
const EXCLUDED = new Set(['PEPI_SYSTEM_PROMPT_FOR_ONYX.md', 'PROFILE.md']);

// Same shape the read_report tool validates against: no slashes, no traversal.
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

const SOURCE_CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

function isValidName(name) {
  return typeof name === 'string' && !!name && NAME_RE.test(name);
}

function reportPath(name) {
  const abs = path.join(PATHS.REPORTS_DIR, `${name}.md`);
  const rootWithSep = PATHS.REPORTS_DIR + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}

// Resolve the archived original for a report.
//
// archive_path comes from a file on disk that the user can edit, so it is
// untrusted input: only its basename is used, resolved against the archive dir,
// and containment is re-checked afterwards. Never joined relative to the
// markdown file either, because on a legacy install reports live under data/
// while the archive is anchored at $HEALTH_HOME/reports/_archive.
function resolveSource(header) {
  const claimed = header?.archivePath || header?.sourceFile;
  if (!claimed) return null;
  const base = path.basename(String(claimed));
  if (!base || base === '.' || base === '..') return null;
  const abs = path.join(PATHS.REPORTS_ARCHIVE_DIR, base);
  const rootWithSep = PATHS.REPORTS_ARCHIVE_DIR + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  return abs;
}

function sourceContentType(absPath) {
  return SOURCE_CONTENT_TYPES[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
}

// The report's content with the frontmatter block and the h1 removed: what a
// human compares against the original. Done here rather than in the client
// because /report/<name> serves a rendered HTML page, and regex-stripping a
// header out of markup leaks it into the pane being checked.
function bodyText(text) {
  return String(text || '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    // Trim first: the frontmatter block is followed by a blank line, so the
    // heading is not at index 0 and an unanchored-to-content ^# misses it.
    .trim()
    .replace(/^#\s+.*(\n+|$)/, '')
    .trim();
}

function _titleFromBody(text, fallback) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function _dateFromName(name) {
  const m = name.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// One report as the client sees it. A file with no ingest sentinel is
// hand-authored: ready, never gated, and not app-managed (no delete, no
// reprocess, no quota slot).
function describeReport(name, text) {
  const header = parseReportHeader(text);
  if (!header) {
    return {
      name,
      title: _titleFromBody(text, name),
      date: _dateFromName(name),
      sourceFormat: null,
      status: 'ready',
      verify: 'not_required',
      bullets: [],
      reason: null,
      url: `/report/${name}`,
      hasSource: false,
      managed: false,
    };
  }
  const source = resolveSource(header);
  return {
    name,
    title: header.title || _titleFromBody(text, name),
    // The document's own date is the useful one; the filename date is only
    // when it was ingested.
    date: header.documentDate || _dateFromName(name),
    sourceFormat: header.sourceFormat,
    status: header.status,
    verify: header.verify,
    bullets: header.bullets,
    reason: header.reason,
    ocrPsm: header.ocrPsm,
    readBy: header.readBy || null,
    // Tri-state: null = no local witness ran, [] = every number corroborated,
    // non-empty = the tokens the verify screen highlights.
    unwitnessed: header.unwitnessed ?? null,
    // What "read it again" would try next, so the client can name it on the
    // button instead of promising a mystery.
    nextRead: (header.sourceFormat === 'image' || header.sourceFormat === 'pdf-ocr')
      ? rungLabel(nextRung(header))
      : null,
    url: `/report/${name}`,
    hasSource: !!source && fs.existsSync(source),
    managed: true,
  };
}

function listReports() {
  let entries;
  try { entries = fs.readdirSync(PATHS.REPORTS_DIR); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.md') || f.startsWith('.') || f.startsWith('_') || EXCLUDED.has(f)) continue;
    const abs = path.join(PATHS.REPORTS_DIR, f);
    let text;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    out.push(describeReport(f.replace(/\.md$/, ''), text));
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
  return out;
}

// Files still in the inbox: uploaded, not yet extracted.
function listProcessing() {
  let entries;
  try { entries = fs.readdirSync(PATHS.INBOX_DIR); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (f.startsWith('.') || f.startsWith('_')) continue;
    try {
      if (fs.statSync(path.join(PATHS.INBOX_DIR, f)).isFile()) out.push({ filename: f, status: 'processing' });
    } catch {}
  }
  return out;
}

// Files the pipeline could not handle, with the reason from the .error sibling.
// Surfaced so a failure is visible in the UI rather than only in a server log,
// which is no use at all to a non-technical instance owner.
function listFailed() {
  let entries;
  try { entries = fs.readdirSync(PATHS.INBOX_FAILED_DIR); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (f.endsWith('.error') || f.startsWith('.')) continue;
    let reason = null;
    try {
      const raw = fs.readFileSync(path.join(PATHS.INBOX_FAILED_DIR, `${f}.error`), 'utf8');
      // The sidecar is "<timestamp>\n<reason>\n".
      reason = raw.split('\n').slice(1).join(' ').trim() || null;
    } catch {}
    out.push({ filename: f, status: 'failed', reason });
  }
  return out;
}

function envelope() {
  const q = catalogue.quota();
  return {
    quota: { used: q.used, max: q.max, remaining: q.remaining },
    reports: listReports(),
    processing: listProcessing(),
    failed: listFailed(),
  };
}

function readReportFile(name) {
  if (!isValidName(name)) return { error: 'invalid report name' };
  const abs = reportPath(name);
  if (!abs) return { error: 'invalid report name' };
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return { error: 'not found', notFound: true }; }
  return { abs, text, header: parseReportHeader(text) };
}

// Rewrite one frontmatter key in place, leaving every other byte alone.
// Written atomically via a temp file so a crash mid-write cannot leave a report
// truncated.
function setHeaderField(abs, text, key, value) {
  const m = text.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) throw new Error('report has no frontmatter block');
  const line = `${key}: ${value}`;
  const keyRe = new RegExp(`^${key}:.*$`, 'm');
  const block = keyRe.test(m[2])
    ? m[2].replace(keyRe, line)
    // Append after the last scalar, before any list, so a bullets list stays
    // attached to its own key.
    : `${m[2]}\n${line}`;
  const updated = m[1] + block + m[3] + text.slice(m[0].length);
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, updated);
  fs.renameSync(tmp, abs);
  return updated;
}

// Mark an OCR-derived report as human-checked. Idempotent, so a double-tap on a
// phone is harmless.
function verifyReport(name) {
  const found = readReportFile(name);
  if (found.error) return found;
  const { header, abs, text } = found;
  if (!header) return { error: 'not an app-managed report', status: 403 };
  if (header.verify === 'verified') return { ok: true, verify: 'verified', alreadyVerified: true };
  if (header.verify !== 'required') {
    return { error: 'this report does not need OCR verification', status: 409 };
  }
  setHeaderField(abs, text, 'verify', 'verified');
  return { ok: true, verify: 'verified' };
}

// Remove a report and its archived original, freeing a quota slot. Refuses on a
// hand-authored file: those are the user's own, not app-managed.
function deleteReport(name) {
  const found = readReportFile(name);
  if (found.error) return found;
  const { header, abs } = found;
  if (!header) return { error: 'this report was authored by hand; delete the file yourself', status: 403 };

  const source = resolveSource(header);
  let removedSource = false;
  if (source) {
    try { fs.unlinkSync(source); removedSource = true; } catch (e) {
      // Not fatal, but worth saying: an orphan in the archive is invisible and
      // would otherwise be a slow leak.
      if (e.code !== 'ENOENT') console.warn(`[reports] could not remove archived original for ${name}: ${e.message}`);
    }
  }
  fs.unlinkSync(abs);
  return { ok: true, name, removedSource };
}

module.exports = {
  envelope,
  bodyText,
  listReports,
  listProcessing,
  listFailed,
  describeReport,
  readReportFile,
  verifyReport,
  deleteReport,
  setHeaderField,
  resolveSource,
  sourceContentType,
  reportPath,
  isValidName,
  EXCLUDED,
  NAME_RE,
};
