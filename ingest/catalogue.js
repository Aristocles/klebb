// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/catalogue.js
// Parse ingested-report frontmatter, and build the system-prompt block
// that lists available reports for the read_report chat tool.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

function parseReportHeader(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const block = m[1];
  if (!/^klebb_ingest:\s*v1\s*$/m.test(block)) return null;
  const out = {};
  for (const line of block.split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  if (!out.ingested_at || !out.source_file || !out.source_format) return null;
  return {
    ingestedAt: out.ingested_at,
    sourceFile: out.source_file,
    sourceFormat: out.source_format,
    archivePath: out.archive_path || null,
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

module.exports = { parseReportHeader, listReportsWithMeta, describeReportsCatalogue };
