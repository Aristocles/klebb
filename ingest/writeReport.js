// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/writeReport.js
// Build the .md output for an ingested file (frontmatter + body) and
// write it atomically into REPORTS_DIR.

const fs = require('fs');
const path = require('path');

const MAX_TITLE = 120;
const MAX_BULLET = 200;
const MAX_BULLETS = 5;

function sanitiseStem(rawStem) {
  return rawStem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

function buildOutputName(originalFilename, ingestedAtIso) {
  const date = ingestedAtIso.slice(0, 10);
  const stem = sanitiseStem(path.parse(originalFilename).name) || 'report';
  return `${date}-${stem}`;
}

function pickAvailableName(reportsDir, baseName) {
  let candidate = path.join(reportsDir, `${baseName}.md`);
  if (!fs.existsSync(candidate)) return { abs: candidate, name: baseName };
  for (let i = 2; i < 1000; i++) {
    const name = `${baseName}-${i}`;
    candidate = path.join(reportsDir, `${name}.md`);
    if (!fs.existsSync(candidate)) return { abs: candidate, name };
  }
  throw new Error(`could not allocate output name for ${baseName} (1000 collisions)`);
}

// Make a model-supplied string safe to sit on one frontmatter line.
//
// The header format captures values to end-of-line, so a newline inside a value
// ends the value early and the rest of it becomes body text; a value that
// starts with `---` closes the frontmatter block outright and corrupts the
// file. A leading `-` would read back as a list item. None of this needs an
// attacker: a model quite reasonably returns a title containing a line break.
function sanitiseHeaderValue(raw, maxLength) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Repeatedly, so `--- - ---` cannot leave a leading marker behind.
  let previous;
  do {
    previous = s;
    s = s.replace(/^-{1,}\s*/, '').trim();
  } while (s !== previous);
  if (!s) return null;
  return s.slice(0, maxLength);
}

function buildFrontmatter(fields) {
  const {
    sourceFile, sourceFormat, ingestedAt, archivePath,
    status, verify, title, documentDate, relevance, ocrPsm, reason, bullets,
    version = 1,
  } = fields;

  if (version === 1) {
    return [
      '---',
      'klebb_ingest: v1',
      `source_file: ${sourceFile}`,
      `source_format: ${sourceFormat}`,
      `ingested_at: ${ingestedAt}`,
      `archive_path: ${archivePath}`,
      '---',
      '',
    ].join('\n');
  }

  const lines = [
    '---',
    'klebb_ingest: v2',
    `source_file: ${sourceFile}`,
    `source_format: ${sourceFormat}`,
    `ingested_at: ${ingestedAt}`,
    `archive_path: ${archivePath}`,
    `status: ${status || 'raw'}`,
    `verify: ${verify || 'not_required'}`,
  ];
  const safeTitle = sanitiseHeaderValue(title, MAX_TITLE);
  if (safeTitle) lines.push(`title: ${safeTitle}`);
  const safeDate = sanitiseHeaderValue(documentDate, 10);
  if (safeDate) lines.push(`document_date: ${safeDate}`);
  if (relevance) lines.push(`relevance: ${sanitiseHeaderValue(relevance, 20)}`);
  if (Number.isInteger(ocrPsm)) lines.push(`ocr_psm: ${ocrPsm}`);
  const safeReason = sanitiseHeaderValue(reason, MAX_TITLE);
  if (safeReason) lines.push(`reason: ${safeReason}`);

  const safeBullets = (Array.isArray(bullets) ? bullets : [])
    .map(b => sanitiseHeaderValue(b, MAX_BULLET))
    .filter(Boolean)
    .slice(0, MAX_BULLETS);
  if (safeBullets.length) {
    lines.push('bullets:');
    for (const b of safeBullets) lines.push(`  - ${b}`);
  }

  lines.push('---', '');
  return lines.join('\n');
}

// `overwriteName` writes over an existing report instead of allocating a fresh
// name. Reprocess needs it: without it every retry would spawn a -2, -3, -4
// duplicate of the same document.
function writeReport({
  reportsDir, text, sourceFile, sourceFormat, ingestedAt, archivePath,
  status, verify, title, documentDate, relevance, ocrPsm, reason, bullets,
  version = 1, overwriteName = null,
}) {
  const { abs, name } = overwriteName
    ? { abs: path.join(reportsDir, `${overwriteName}.md`), name: overwriteName }
    : pickAvailableName(reportsDir, buildOutputName(sourceFile, ingestedAt));

  const heading = sanitiseHeaderValue(title, MAX_TITLE) || name;
  const body = [
    buildFrontmatter({
      sourceFile, sourceFormat, ingestedAt, archivePath,
      status, verify, title, documentDate, relevance, ocrPsm, reason, bullets,
      version,
    }),
    `# ${heading}`,
    '',
    text || '',
  ].join('\n');

  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, abs);
  return { outAbs: abs, outName: name };
}

module.exports = {
  writeReport,
  buildOutputName,
  sanitiseStem,
  buildFrontmatter,
  sanitiseHeaderValue,
  MAX_TITLE,
  MAX_BULLET,
  MAX_BULLETS,
};
