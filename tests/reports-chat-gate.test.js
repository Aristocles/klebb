// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/reports-chat-gate.test.js
//
// The chat side of reports: the catalogue block that goes into every turn, and
// the hard gate on unverified OCR text.
//
// The gate assertions are the point. Implemented only in the prompt, the gate
// looks finished and does nothing: the model sees a report listed, calls
// read_report, gets a body, and answers from it. So the tool-layer test comes
// first and is the real detector; the catalogue test is the second half (it
// stops the model quoting a digest it should not have).
//
// Needs a per-test HEALTH_HOME because catalogue and chat/reports resolve
// PATHS.REPORTS_DIR at require time, so no spawnServer in this file.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

let home;
let catalogue;
let chatReports;
let tools;

function purge() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](config[\\/]paths|config[\\/]env|ingest[\\/]catalogue|chat[\\/]reports|chat[\\/]tools)\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-chatgate-'));
  fs.mkdirSync(path.join(home, 'reports', '_archive'), { recursive: true });
  fs.mkdirSync(path.join(home, 'inbox', '_failed'), { recursive: true });
  process.env.HEALTH_HOME = home;
  process.env.HEALTH_HOME_WARNED = '1';
  purge();
  catalogue = require(path.join(REPO_ROOT, 'ingest', 'catalogue.js'));
  chatReports = require(path.join(REPO_ROOT, 'chat', 'reports.js'));
  tools = require(path.join(REPO_ROOT, 'chat', 'tools.js'));
});

afterEach(() => {
  purge();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

function writeReport(name, over = {}) {
  const o = {
    version: 2,
    sourceFile: `${name}.png`,
    sourceFormat: 'image',
    ingestedAt: '2026-08-09T01:02:03Z',
    status: 'ready',
    verify: 'not_required',
    title: `Report ${name}`,
    documentDate: '2026-03-12',
    relevance: 'health',
    bullets: ['Ferritin 88 ug/L, low end of range'],
    body: 'Haemoglobin 147 g/L (130-180)\nFerritin 88 ug/L (30-300)',
    ...over,
  };
  const lines = ['---', `klebb_ingest: v${o.version}`,
    `source_file: ${o.sourceFile}`,
    `source_format: ${o.sourceFormat}`,
    `ingested_at: ${o.ingestedAt}`,
    `archive_path: reports/_archive/${o.sourceFile}`,
  ];
  if (o.version === 2) {
    lines.push(`status: ${o.status}`, `verify: ${o.verify}`);
    if (o.title) lines.push(`title: ${o.title}`);
    if (o.documentDate) lines.push(`document_date: ${o.documentDate}`);
    if (o.relevance) lines.push(`relevance: ${o.relevance}`);
    if (o.reason) lines.push(`reason: ${o.reason}`);
    if (o.bullets?.length) {
      lines.push('bullets:');
      for (const b of o.bullets) lines.push(`  - ${b}`);
    }
  }
  lines.push('---', '', `# ${o.title || name}`, '', o.body);
  fs.writeFileSync(path.join(home, 'reports', `${name}.md`), lines.join('\n'));
  return name;
}

function writeHandAuthored(name, body = 'Cholesterol 4.8 mmol/L') {
  fs.writeFileSync(path.join(home, 'reports', `${name}.md`), `# ${name} notes\n\n${body}\n`);
  return name;
}

function callTool(name, args) {
  return JSON.parse(tools.dispatchToolCall({
    function: { name, arguments: JSON.stringify(args) },
  }));
}

describe('read_report: the unverified-OCR gate is enforced at the tool layer', () => {
  test('an unverified report returns an error and NO content key at all', () => {
    // The detector. A prompt instruction is advisory; a tool return is not.
    writeReport('2026-03-12-photo', { verify: 'required' });
    const r = chatReports.readReport('2026-03-12-photo');
    assert.match(r.error, /awaiting OCR verification/);
    assert.ok(!('content' in r),
      'unverified report content reached the model; the gate is defeated');
    assert.equal(r.verify, 'required');
  });

  test('the refusal still names the report, so the model can tell the user', () => {
    writeReport('2026-03-12-photo', { verify: 'required', title: 'Full blood count' });
    const r = chatReports.readReport('2026-03-12-photo');
    assert.equal(r.name, '2026-03-12-photo');
    assert.equal(r.title, 'Full blood count');
    assert.equal(r.documentDate, '2026-03-12');
    assert.match(r.error, /verify it in Reports/);
  });

  test('none of the withheld numbers leak through any field of the refusal', () => {
    writeReport('leaky', {
      verify: 'required',
      bullets: ['Ferritin 88 ug/L'],
      body: 'Haemoglobin 147 g/L\nFerritin 88 ug/L',
    });
    const serialised = JSON.stringify(chatReports.readReport('leaky'));
    assert.ok(!serialised.includes('147'), 'a withheld lab value leaked through the refusal');
    assert.ok(!serialised.includes('88'), 'a withheld lab value leaked through the refusal');
  });

  test('a verified report returns its content', () => {
    writeReport('2026-03-12-checked', { verify: 'verified' });
    const r = chatReports.readReport('2026-03-12-checked');
    assert.ok(!r.error, `verified report was refused: ${r.error}`);
    assert.match(r.content, /Haemoglobin 147 g\/L/);
    assert.equal(r.verify, 'verified');
  });

  test('a report that never needed verification returns its content', () => {
    writeReport('2026-03-12-docx', { sourceFormat: 'docx', verify: 'not_required' });
    const r = chatReports.readReport('2026-03-12-docx');
    assert.ok(!r.error);
    assert.match(r.content, /Ferritin 88 ug\/L/);
  });

  test('a hand-authored report is never gated', () => {
    writeHandAuthored('my-notes');
    const r = chatReports.readReport('my-notes');
    assert.ok(!r.error, `a hand-authored report was gated: ${r.error}`);
    assert.match(r.content, /Cholesterol 4\.8 mmol\/L/);
  });

  test('a v1 report is never gated', () => {
    // v1 has no verify field. It has always been readable and must stay so.
    writeReport('2026-01-01-legacy', { version: 1, body: 'Legacy cholesterol 4.8 mmol/L' });
    const r = chatReports.readReport('2026-01-01-legacy');
    assert.ok(!r.error, `a v1 report was gated: ${r.error}`);
    assert.match(r.content, /4\.8 mmol\/L/);
  });

  test('a raw (unsummarised) report is readable: only verification gates', () => {
    // status and verify are independent. A raw text report has nothing to check.
    writeReport('2026-03-12-raw', {
      sourceFormat: 'text', status: 'raw', verify: 'not_required',
      reason: 'comprehension unavailable: gateway unreachable',
    });
    const r = chatReports.readReport('2026-03-12-raw');
    assert.ok(!r.error);
    assert.match(r.content, /Haemoglobin 147 g\/L/);
    assert.equal(r.status, 'raw');
  });

  test('the gate holds through the tool dispatcher, not just the function', () => {
    // The model reaches readReport via dispatchToolCall, so that is the path
    // that actually matters.
    writeReport('dispatch-gated', { verify: 'required' });
    const out = callTool('read_report', { name: 'dispatch-gated' });
    assert.match(out.error, /awaiting OCR verification/);
    assert.ok(!('content' in out), 'the dispatcher returned withheld content');
  });

  test('traversal guards still apply', () => {
    assert.match(chatReports.readReport('../etc/passwd').error, /invalid report name/);
    assert.match(chatReports.readReport('').error, /required/);
  });
});

describe('the reports catalogue block', () => {
  test('is empty-stated without mentioning a filesystem drop', () => {
    // Upload is the only ingest path now; telling the model to drop a file in a
    // directory would have it instruct the user to do something impossible.
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /No reports yet/);
    assert.match(block, /Reports page/);
    assert.ok(!/inbox/i.test(block), 'the empty state still references the inbox');
  });

  test('lists a report with its title, date and bullets', () => {
    writeReport('2026-03-12-bloods', { verify: 'not_required', sourceFormat: 'pdf' });
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /2026-03-12-bloods/);
    assert.match(block, /Report 2026-03-12-bloods/);
    assert.match(block, /dated 2026-03-12/);
    assert.match(block, /Ferritin 88 ug\/L, low end of range/);
  });

  test('orders newest-first by DOCUMENT date, not by filename', () => {
    // The filename date is the ingest date. Ordering by it puts a 2019 blood
    // test uploaded today above one from last month.
    writeReport('2026-08-01-old-doc', { documentDate: '2019-01-15', verify: 'not_required' });
    writeReport('2026-01-01-new-doc', { documentDate: '2026-07-20', verify: 'not_required' });
    const block = catalogue.describeReportsCatalogue();
    const newIdx = block.indexOf('2026-01-01-new-doc');
    const oldIdx = block.indexOf('2026-08-01-old-doc');
    assert.ok(newIdx >= 0 && oldIdx >= 0, 'both reports should be listed');
    assert.ok(newIdx < oldIdx,
      'the newer DOCUMENT is not listed first; ordering fell back to the filename');
  });

  test('falls back to the ingest date when the document has none, and says so', () => {
    writeReport('2026-05-05-undated', { documentDate: null, verify: 'not_required' });
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /no date in the document/);
    assert.match(block, /ingested 2026-08-09/);
  });

  test('carries the recency guidance the model needs', () => {
    writeReport('2026-03-12-bloods', { verify: 'not_required' });
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /newest/i);
    assert.match(block, /compare|trend/i);
    assert.match(block, /read_report/);
  });

  test('an unverified report is listed WITHOUT its bullets', () => {
    // The second half of the gate: the title tells the model something exists,
    // and the digest is withheld so it cannot quote unchecked OCR output.
    writeReport('2026-03-12-photo', { verify: 'required', title: 'Photographed blood panel' });
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /Photographed blood panel/, 'the report should still be listed');
    assert.match(block, /content withheld pending OCR verification/);
    assert.ok(!block.includes('Ferritin 88 ug/L, low end of range'),
      'an unverified report\'s bullets reached the prompt');
    assert.ok(!block.includes('147'), 'an unverified value reached the prompt');
  });

  test('a rejected report is flagged rather than silently listed', () => {
    writeReport('2026-03-12-receipt', {
      status: 'rejected', relevance: 'unrelated', verify: 'not_required',
      title: 'Supermarket receipt', bullets: [],
      reason: 'not a health document',
    });
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /Supermarket receipt/);
    assert.match(block, /not a health document/);
  });

  test('a raw report says it is not summarised', () => {
    writeReport('2026-03-12-raw', {
      status: 'raw', verify: 'not_required', sourceFormat: 'text', bullets: [],
    });
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /not summarised/);
  });

  test('a hand-authored report is listed but its body is NEVER inlined', () => {
    // Hand-authored files have no bullet caps, so inlining a body here would
    // let one file bloat every chat turn indefinitely.
    writeHandAuthored('genome-notes', 'A'.repeat(5000) + '\nSECRETMARKER');
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /genome-notes/);
    assert.ok(!block.includes('SECRETMARKER'), 'a hand-authored body was inlined into the prompt');
    assert.ok(!block.includes('A'.repeat(200)), 'a hand-authored body was inlined into the prompt');
  });

  test('a v1 report still appears, with its metadata', () => {
    // The hard abort condition: a v1 report falling out of the catalogue is
    // silent data loss from the user's point of view.
    writeReport('2026-01-01-legacy', { version: 1, sourceFormat: 'pdf' });
    const block = catalogue.describeReportsCatalogue();
    assert.match(block, /2026-01-01-legacy/, 'a v1 report vanished from the catalogue');
    assert.match(block, /pdf/);
  });

  test('stays under the byte ceiling with 20 reports, and says what it dropped', () => {
    for (let i = 1; i <= 20; i++) {
      const day = String(i).padStart(2, '0');
      writeReport(`2026-06-${day}-panel`, {
        verify: 'not_required',
        documentDate: `2026-06-${day}`,
        title: `Comprehensive metabolic and lipid panel number ${i}, Melbourne Pathology`,
        bullets: Array.from({ length: 5 }, (_, b) =>
          `Analyte ${b} reading ${100 + b} units, within the reference range of 80 to 120`),
      });
    }
    const block = catalogue.describeReportsCatalogue();
    const bytes = Buffer.byteLength(block, 'utf8');
    assert.ok(bytes <= catalogue.CATALOGUE_MAX_BYTES,
      `catalogue is ${bytes} bytes, over the ${catalogue.CATALOGUE_MAX_BYTES} ceiling; it goes into every chat turn`);
    // Whatever was dropped is declared rather than silently missing.
    if (bytes > catalogue.CATALOGUE_MAX_BYTES * 0.8) {
      assert.match(block, /not listed here/, 'truncation happened without saying so');
    }
    // And the newest survived the truncation, since that is what gets asked about.
    assert.match(block, /2026-06-20-panel/, 'truncation dropped the newest report');
  });

  test('a single enormous hand-authored set cannot blow the ceiling', () => {
    for (let i = 0; i < 200; i++) writeHandAuthored(`note-${String(i).padStart(3, '0')}`);
    const block = catalogue.describeReportsCatalogue();
    assert.ok(Buffer.byteLength(block, 'utf8') <= catalogue.CATALOGUE_MAX_BYTES,
      'the ceiling does not hold against many hand-authored files');
  });
});

describe('the eval scenario fixtures are actually gated', () => {
  // The eval scenarios need a real gateway, so they cannot run in CI. What CAN
  // be checked here is that their fixtures set up the state they claim to: an
  // eval asserting "the model must not quote 132" proves nothing if the seeded
  // report was never gated in the first place.
  test('the seeded unverified report is gated, and its values stay out of the prompt', () => {
    const { writeReportSeed } = require(path.join(REPO_ROOT, 'evals', 'lib', 'scenario.js'));
    const scenarios = require(path.join(REPO_ROOT, 'evals', 'scenarios', 'reports.js'));

    const gatedScenario = scenarios.find(s => s.name === 'reports-unverified-content-is-withheld');
    assert.ok(gatedScenario, 'the gate scenario is missing');
    for (const seed of gatedScenario.reportSeeds) writeReportSeed(home, seed);

    const header = catalogue.parseReportHeader(
      fs.readFileSync(path.join(home, 'reports', '2026-07-02-unverified-thyroid.md'), 'utf8'));
    assert.ok(header, 'the seeded report does not parse as an ingested report');
    assert.equal(header.verify, 'required',
      'the eval seeds a report that is NOT gated, so the scenario would pass vacuously');

    const r = chatReports.readReport('2026-07-02-unverified-thyroid');
    assert.ok(r.error, 'the eval fixture is readable, so the gate scenario tests nothing');
    assert.ok(!('content' in r));

    // And the numbers the scenario forbids in a reply are genuinely withheld
    // from the prompt, so a model could only produce them by inventing them.
    const block = catalogue.describeReportsCatalogue();
    for (const value of ['132', '205']) {
      assert.ok(!block.includes(value),
        `${value} is in the prompt, so the eval's noMatch assertion is not testing the gate`);
    }
  });

  test('the verified fixture IS readable, so its scenario can pass honestly', () => {
    const { writeReportSeed } = require(path.join(REPO_ROOT, 'evals', 'lib', 'scenario.js'));
    const scenarios = require(path.join(REPO_ROOT, 'evals', 'scenarios', 'reports.js'));
    const scenario = scenarios.find(s => s.name === 'reports-verified-report-is-used');
    for (const seed of scenario.reportSeeds) writeReportSeed(home, seed);

    const r = chatReports.readReport('2026-03-12-verified-bloods');
    assert.ok(!r.error, `the verified fixture is gated: ${r.error}`);
    assert.match(r.content, /88 ug\/L/, 'the value the scenario asserts on is not in the fixture');
  });
});

describe('read_report tool definition', () => {
  test('documents the gated shape so the model knows what to do with it', () => {
    const def = tools.TOOL_DEFS.find(t => t.function?.name === 'read_report');
    assert.ok(def);
    assert.match(def.function.description, /verify/i);
    assert.match(def.function.description, /NO content|no content/);
    assert.match(def.function.description, /Reports page/);
  });

  test('tells the model to read before quoting a figure', () => {
    const def = tools.TOOL_DEFS.find(t => t.function?.name === 'read_report');
    assert.match(def.function.description, /before quoting/i);
  });
});
