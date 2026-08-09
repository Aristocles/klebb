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

  // The unverified-OCR gate, enforced HERE rather than only in the prompt.
  //
  // A prompt instruction is advisory: the model sees a report listed, calls this
  // tool, gets a body, and answers from it. Enforced at the tool layer there is
  // nothing to answer from. This report came from a photo or a scan, so its text
  // is OCR output that no human has checked, and a mis-read digit in a health
  // record is the failure that actually matters. No content key at all, so a
  // model cannot half-use it.
  if (header && header.verify === 'required') {
    return {
      error: 'report awaiting OCR verification; ask the user to verify it in Reports',
      name,
      path: `reports/${name}.md`,
      title: header.title || null,
      documentDate: header.documentDate || null,
      sourceFormat: header.sourceFormat || null,
      verify: 'required',
    };
  }

  return {
    name,
    path: `reports/${name}.md`,
    content,
    ingestedAt: header?.ingestedAt || null,
    sourceFormat: header?.sourceFormat || null,
    title: header?.title || null,
    documentDate: header?.documentDate || null,
    status: header?.status || null,
    verify: header?.verify || null,
    truncated,
  };
}

module.exports = { readReport, describeReportsCatalogue };
