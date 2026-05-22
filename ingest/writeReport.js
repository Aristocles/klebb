// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/writeReport.js
// Build the .md output for an ingested file (frontmatter + body) and
// write it atomically into REPORTS_DIR.

const fs = require('fs');
const path = require('path');

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

function buildFrontmatter({ sourceFile, sourceFormat, ingestedAt, archivePath }) {
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

function writeReport({ reportsDir, text, sourceFile, sourceFormat, ingestedAt, archivePath }) {
  const baseName = buildOutputName(sourceFile, ingestedAt);
  const { abs, name } = pickAvailableName(reportsDir, baseName);
  const body = [
    buildFrontmatter({ sourceFile, sourceFormat, ingestedAt, archivePath }),
    `# ${name}`,
    '',
    text || '',
  ].join('\n');
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, abs);
  return { outAbs: abs, outName: name };
}

module.exports = { writeReport, buildOutputName, sanitiseStem };
