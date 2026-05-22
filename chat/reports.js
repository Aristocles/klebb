// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/reports.js
//
// Reader for ingested + hand-authored reports under $HEALTH_HOME/reports/.
// Backs the read_report chat tool: the agent gets a catalogue in the
// system prompt (describeReportsCatalogue) and can pull any listed
// report's full text on demand. Distinct from chat/docs.js, which
// reads in-repo documentation.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const { describeReportsCatalogue, parseReportHeader } = require('../ingest/catalogue');

const NAME_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_BYTES = 200_000;

function readReport(name) {
  if (typeof name !== 'string' || !name) {
    return { error: 'name is required' };
  }
  if (!NAME_RE.test(name)) {
    return { error: `invalid report name: ${name}` };
  }
  const reportsDir = PATHS.REPORTS_DIR;
  const abs = path.join(reportsDir, name + '.md');
  const rootWithSep = reportsDir + path.sep;
  if (!abs.startsWith(rootWithSep) && abs !== reportsDir) {
    return { error: `path escapes reports dir: ${name}` };
  }
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { error: `failed to read report ${name}: ${e.message}` };
  }
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    content = content.slice(0, MAX_BYTES);
    truncated = true;
  }
  const header = parseReportHeader(content);
  return {
    name,
    path: `reports/${name}.md`,
    content,
    ingestedAt: header?.ingestedAt || null,
    sourceFormat: header?.sourceFormat || null,
    truncated,
  };
}

module.exports = { readReport, describeReportsCatalogue };
