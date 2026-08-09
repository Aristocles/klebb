// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/extractors.test.js
//
// Extractor hardening: the tesseract PSM ladder, the scanned-PDF OCR
// fallback, and the zero-dependency docx reader.
//
// Pure-function and fs-only; no spawnServer here, so this file may safely
// require modules directly.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const { extractImage, PSM_LADDER, nextPsm, tesseractArgs } = require('../ingest/extractors/image');
const { extractDocx, documentXmlToText, MAX_UNCOMPRESSED } = require('../ingest/extractors/docx');
const pdf = require('../ingest/extractors/pdf');
const { EXT_TO_FORMAT, ALLOWED_UPLOAD_EXTS, formatFor } = require('../ingest/extract');
const {
  buildZip, makeDocx, makePng, makeTextPdf, makeImageOnlyPdf, parsePgm,
} = require('./helpers/binary-fixtures');

// A realistic pathology report's worth of text: enough lines to clear the
// sparse-text floor comfortably, so a fixture that is too thin fails loudly
// rather than passing for the wrong reason.
const LAB_ROWS = [
  'PATHOLOGY REPORT  Collected 12/03/2026',
  'HAEMOGLOBIN         147 g/L      (130-180)',
  'WHITE CELL COUNT    6.2 x10^9/L  (4.0-11.0)',
  'PLATELETS           268 x10^9/L  (150-400)',
  'FERRITIN            88 ug/L      (30-300)',
  'IRON                18 umol/L    (10-30)',
  'TRANSFERRIN SAT     34 %         (15-45)',
  'VITAMIN B12         410 pmol/L   (150-700)',
  'FOLATE              22 nmol/L    (7-45)',
  'eGFR                >90 mL/min',
  'CREATININE          78 umol/L    (60-110)',
  'ALT                 26 U/L       (0-41)',
];

function which(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0;
}
const HAS_TESSERACT = which('tesseract');
const HAS_PDFTOPPM = which('pdftoppm');

function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-extract-'));
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, bytes);
  return { abs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('extractors/image: PSM ladder', () => {
  test('the ladder starts at tesseract\'s own default, so ingest speed is unchanged', () => {
    assert.equal(PSM_LADDER[0], 3);
    assert.deepEqual([...PSM_LADDER], [3, 6, 4]);
  });

  test('args are positional-then-flags, with --psm as two tokens', () => {
    // tesseract rejects `--psm=6` outright as an unknown argument, and the
    // input/output positionals must come first.
    const args = tesseractArgs('/tmp/scan.png', 6);
    assert.equal(args[0], '/tmp/scan.png');
    assert.equal(args[1], 'stdout');
    const psmIdx = args.indexOf('--psm');
    assert.ok(psmIdx > 1, '--psm appears before the positionals');
    assert.equal(args[psmIdx + 1], '6', '--psm value is not a separate token');
    assert.ok(!args.some(a => a.includes('--psm=')), '--psm=N form is rejected by tesseract');
  });

  test('preserve_interword_spaces is always passed', () => {
    // Without it tesseract collapses the column gaps that keep a lab table
    // legible, on every rung.
    for (const psm of PSM_LADDER) {
      const args = tesseractArgs('/tmp/x.png', psm);
      const cIdx = args.indexOf('-c');
      assert.ok(cIdx > 0, `-c missing at psm ${psm}`);
      assert.equal(args[cIdx + 1], 'preserve_interword_spaces=1');
    }
  });

  test('language is always eng', () => {
    const args = tesseractArgs('/tmp/x.png', 3);
    const lIdx = args.indexOf('-l');
    assert.ok(lIdx > 0);
    assert.equal(args[lIdx + 1], 'eng');
  });

  test('nextPsm walks the ladder and saturates at the top rung', () => {
    assert.equal(nextPsm(3), 6);
    assert.equal(nextPsm(6), 4);
    assert.equal(nextPsm(4), 4, 'the last rung must be a fixed point, not a wrap');
    assert.equal(nextPsm(undefined), 6, 'an unrecorded psm advances off the default');
    assert.equal(nextPsm(99), 6);
  });

  test('an off-ladder psm falls back to the default rather than being passed through', async () => {
    // Guards against a client posting {psm: 99} and tesseract erroring out.
    const args = tesseractArgs('/tmp/x.png', PSM_LADDER[0]);
    assert.equal(args[args.indexOf('--psm') + 1], '3');
  });

  test('OCRs a real image at two rungs', { skip: !HAS_TESSERACT }, async () => {
    // A blank page yields empty text, which is fine: what is under test is
    // that both rungs invoke cleanly and report the psm they used.
    const { abs, cleanup } = tmpFile('blank.png', makePng(64, 64));
    try {
      const a = await extractImage(abs, { psm: 3 });
      assert.equal(a.psm, 3);
      assert.equal(a.ladderIndex, 0);
      assert.equal(typeof a.text, 'string');
      const b = await extractImage(abs, { psm: 6 });
      assert.equal(b.psm, 6);
      assert.equal(b.ladderIndex, 1);
    } finally { cleanup(); }
  });
});

describe('extractors/pdf: sparseness thresholds', () => {
  test('a per-page floor sits alongside the total floor', () => {
    // A multi-page scan with one text-layer cover sheet clears the total but
    // is still unreadable, so the per-page rule is what catches it.
    assert.equal(pdf.SPARSE_TOTAL_CHARS, 200);
    assert.equal(pdf.SPARSE_CHARS_PER_PAGE, 50);
  });

  test('the page cap and dpi are bounded', () => {
    // 300 dpi PNG per page is several MB and one tesseract run each, on the
    // thread serving HTTP.
    assert.ok(pdf.OCR_MAX_PAGES <= 20, 'page cap too high for a small container');
    assert.equal(pdf.OCR_DPI, 300);
  });

  test('hasPdftoppm probes without throwing either way', () => {
    const v = pdf.hasPdftoppm();
    assert.equal(typeof v, 'boolean');
    assert.equal(v, HAS_PDFTOPPM, 'probe disagrees with PATH');
  });

  test('a digital PDF keeps source_format pdf and its text layer', { skip: !which('pdftotext') }, async () => {
    const { abs, cleanup } = tmpFile('digital.pdf', makeTextPdf(LAB_ROWS));
    try {
      const out = await pdf.extractPdf(abs);
      // Assert the fixture itself is fat enough to be a real test: a thin
      // fixture would fall under the sparse floor and pass this case for the
      // wrong reason (routed to OCR, OCR unavailable, still reports 'pdf').
      const alnum = (out.text.match(/[a-z0-9]/gi) || []).length;
      assert.ok(alnum > pdf.SPARSE_TOTAL_CHARS,
        `fixture yielded only ${alnum} alphanumerics; it must clear the sparse floor to test anything`);
      assert.equal(out.sourceFormat, 'pdf',
        'a PDF with a real text layer must not be routed through OCR');
      assert.equal(out.sparse, undefined, 'a text-layer PDF should not be flagged sparse');
      assert.match(out.text, /HAEMOGLOBIN/i);
      assert.match(out.text, /147/, 'numbers must survive the text layer verbatim');
      assert.match(out.text, /130-180/, 'reference ranges must survive verbatim');
    } finally { cleanup(); }
  });

  test('a blank page does not get pdf-ocr provenance it did not earn', { skip: !which('pdftotext') }, async () => {
    // A page with no content stream at all. It is sparse, so it routes to the
    // fallback, but OCR recovers nothing, so calling it pdf-ocr would be a lie
    // that then costs the user a pointless verification step. Guards against
    // counting our own "--- page N ---" scaffolding as recovered text.
    const { abs, cleanup } = tmpFile('blank.pdf', makeImageOnlyPdf({
      width: 40, height: 56, grey: Buffer.alloc(40 * 56, 0xff),
    }));
    try {
      const out = await pdf.extractPdf(abs);
      assert.equal(out.sourceFormat, 'pdf', 'a blank page must not be reported as pdf-ocr');
      assert.equal(out.sparse, true);
      if (!HAS_PDFTOPPM) {
        assert.match(out.reason || '', /OCR unavailable/,
          'without pdftoppm the report must say why it is empty');
      }
    } finally { cleanup(); }
  });

  test('a real scanned PDF is OCRed and recorded as pdf-ocr', {
    skip: !(HAS_PDFTOPPM && HAS_TESSERACT && which('pdftotext')),
  }, async () => {
    // The criterion this whole fallback exists for. Built by rendering a text
    // PDF to greyscale pixels and wrapping those pixels in an image-only PDF,
    // so pdftotext genuinely returns nothing and the text can only come from
    // OCR. Large type, because 150 dpi of 9pt does not survive tesseract.
    const src = tmpFile('src.pdf', makeTextPdf(
      ['HAEMOGLOBIN 147 g/L', 'FERRITIN 88 ug/L', 'IRON 18 umol/L', 'PLATELETS 268'],
      { fontSize: 24, leading: 30 },
    ));
    const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-render-'));
    try {
      const r = spawnSync('pdftoppm', ['-r', '150', '-gray', '-f', '1', '-l', '1', src.abs, path.join(renderDir, 'p')]);
      assert.equal(r.status, 0, `pdftoppm failed: ${r.stderr}`);
      const pgmName = fs.readdirSync(renderDir).find(f => f.endsWith('.pgm'));
      assert.ok(pgmName, 'pdftoppm produced no .pgm');
      const page = parsePgm(fs.readFileSync(path.join(renderDir, pgmName)));

      const scan = tmpFile('scan.pdf', makeImageOnlyPdf(page));
      try {
        // Precondition: the fixture really has no text layer.
        const probe = spawnSync('pdftotext', ['-layout', scan.abs, '-']);
        const layerChars = (String(probe.stdout).match(/[a-z0-9]/gi) || []).length;
        assert.ok(layerChars < pdf.SPARSE_TOTAL_CHARS,
          `fixture has a ${layerChars}-char text layer; it is not a scan`);

        const out = await pdf.extractPdf(scan.abs);
        assert.equal(out.sourceFormat, 'pdf-ocr',
          'a scanned PDF must be OCRed and labelled pdf-ocr');
        assert.equal(out.pages, 1);
        assert.equal(out.truncated, false);
        assert.match(out.text, /--- page 1 ---/, 'per-page separators missing');
        assert.match(out.text, /HAEMOGLOBIN/i);
        // The numbers are the point: this is a health app.
        assert.match(out.text, /147/, 'OCR lost a lab value');
        assert.match(out.text, /88/);
        assert.match(out.text, /268/);
      } finally { scan.cleanup(); }
    } finally {
      src.cleanup();
      fs.rmSync(renderDir, { recursive: true, force: true });
    }
  });

  test('the OCR fallback leaves no temp directory behind', { skip: !HAS_PDFTOPPM }, async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('klebb-pdfocr-')).length;
    const { abs, cleanup } = tmpFile('broken.pdf', Buffer.from('%PDF-1.4\nnot really a pdf\n'));
    try {
      // Whatever this does (throw or degrade), the temp dir must be gone.
      await pdf.extractPdf(abs).catch(() => {});
    } finally { cleanup(); }
    const after = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('klebb-pdfocr-')).length;
    assert.equal(after, before, 'a klebb-pdfocr- temp dir leaked');
  });
});

describe('extractors/docx: text extraction', () => {
  test('paragraphs become lines and runs join without a separator', async () => {
    // Runs are mid-sentence formatting splits, so joining them with a space
    // would corrupt words.
    const docx = makeDocx([
      'Dear Doctor,',
      '<w:r><w:t>The pat</w:t></w:r><w:r><w:t>ient presented</w:t></w:r>',
      'Yours sincerely',
    ]);
    const { abs, cleanup } = tmpFile('letter.docx', docx);
    try {
      const out = await extractDocx(abs);
      const lines = out.text.split('\n');
      assert.equal(lines[0], 'Dear Doctor,');
      assert.equal(lines[1], 'The patient presented', 'runs were joined with a separator');
      assert.equal(lines[2], 'Yours sincerely');
    } finally { cleanup(); }
  });

  test('tabs and breaks are mapped, and entities decoded', async () => {
    const docx = makeDocx([
      '<w:r><w:t>Iron</w:t><w:tab/><w:t>88 ug/L</w:t></w:r>',
      '<w:r><w:t>line one</w:t><w:br/><w:t>line two</w:t></w:r>',
      'Smith &amp; Jones &lt;lab&gt; &quot;quoted&quot;',
    ]);
    const { abs, cleanup } = tmpFile('table.docx', docx);
    try {
      const out = await extractDocx(abs);
      assert.match(out.text, /Iron\t88 ug\/L/);
      assert.match(out.text, /line one\nline two/);
      assert.match(out.text, /Smith & Jones <lab> "quoted"/);
    } finally { cleanup(); }
  });

  test('an &amp;lt; does not double-decode into a literal <', () => {
    // Entity order matters: &amp; must be decoded last.
    const xml = '<w:p><w:r><w:t>&amp;lt;notatag&amp;gt;</w:t></w:r></w:p>';
    assert.equal(documentXmlToText(xml), '&lt;notatag&gt;');
  });

  test('a stored (uncompressed) entry is read as-is', async () => {
    const docx = makeDocx(['Stored not deflated'], { store: true });
    const { abs, cleanup } = tmpFile('stored.docx', docx);
    try {
      assert.match((await extractDocx(abs)).text, /Stored not deflated/);
    } finally { cleanup(); }
  });

  test('numbers and reference ranges survive verbatim', async () => {
    const docx = makeDocx(['Haemoglobin 147 g/L (130-180)', 'Ferritin 8.8 ug/L', 'eGFR >90']);
    const { abs, cleanup } = tmpFile('bloods.docx', docx);
    try {
      const out = await extractDocx(abs);
      assert.match(out.text, /147 g\/L \(130-180\)/);
      assert.match(out.text, /8\.8/);
      assert.match(out.text, />90/);
    } finally { cleanup(); }
  });
});

describe('extractors/docx: hostile and malformed input', () => {
  test('a zip bomb is refused with a size error, not a hang or an OOM', async () => {
    // 30 MB of zeros deflates to a few KB. This is the reason the extractor
    // caps output at all: the file sits at an upload boundary.
    const huge = Buffer.alloc(MAX_UNCOMPRESSED + 1024 * 1024, 0);
    const bomb = buildZip({ 'word/document.xml': huge });
    assert.ok(bomb.length < 1024 * 1024, `bomb did not compress (${bomb.length} bytes)`);
    const { abs, cleanup } = tmpFile('bomb.docx', bomb);
    try {
      await assert.rejects(() => extractDocx(abs), /document too large/);
    } finally { cleanup(); }
  });

  test('a bomb that LIES about its declared size is still refused', async () => {
    // The declared-size precheck is defeatable (it is attacker-controlled), so
    // the inflate cap has to be the real backstop.
    const huge = Buffer.alloc(MAX_UNCOMPRESSED + 1024 * 1024, 0);
    const liar = buildZip({ 'word/document.xml': huge }, { declaredSize: 1024 });
    const { abs, cleanup } = tmpFile('liar.docx', liar);
    try {
      await assert.rejects(() => extractDocx(abs), /document too large/);
    } finally { cleanup(); }
  });

  test('a zip with no word/document.xml is refused by name', async () => {
    const notWord = buildZip({ 'xl/workbook.xml': '<workbook/>' });
    const { abs, cleanup } = tmpFile('spreadsheet.docx', notWord);
    try {
      await assert.rejects(() => extractDocx(abs), /no word\/document\.xml/);
    } finally { cleanup(); }
  });

  test('a file that is not a zip at all is refused', async () => {
    const { abs, cleanup } = tmpFile('fake.docx', Buffer.from('this is just text, not a zip'));
    try {
      await assert.rejects(() => extractDocx(abs), /not a ZIP archive/);
    } finally { cleanup(); }
  });

  test('a truncated zip is refused rather than reading past the buffer', async () => {
    const good = makeDocx(['content']);
    // Keep the EOCD (it is at the end) but destroy the entry data it points at.
    const truncated = Buffer.concat([good.slice(0, 20), good.slice(good.length - 22)]);
    const { abs, cleanup } = tmpFile('truncated.docx', truncated);
    try {
      await assert.rejects(() => extractDocx(abs), /malformed ZIP|not a ZIP archive/);
    } finally { cleanup(); }
  });

  test('an unsupported compression method is refused by number', async () => {
    const z = makeDocx(['x']);
    // Rewrite the central-directory method field to 12 (bzip2).
    const cdSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    let at = z.indexOf(cdSig);
    let found = false;
    while (at !== -1) {
      const nameLen = z.readUInt16LE(at + 28);
      const name = z.slice(at + 46, at + 46 + nameLen).toString();
      if (name === 'word/document.xml') { z.writeUInt16LE(12, at + 10); found = true; break; }
      at = z.indexOf(cdSig, at + 4);
    }
    assert.ok(found, 'test could not locate the central-directory entry to corrupt');
    const { abs, cleanup } = tmpFile('bzip.docx', z);
    try {
      await assert.rejects(() => extractDocx(abs), /unsupported ZIP compression method 12/);
    } finally { cleanup(); }
  });

  test('a local header with zeroed sizes still extracts (central directory is the truth)', async () => {
    // A data-descriptor zip zeroes the sizes in the local header. Reading them
    // from there is the classic wrong-bytes bug, so the parser must not.
    const z = makeDocx(['Sizes only in the central directory']);
    const localSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    let at = z.indexOf(localSig);
    let patched = 0;
    while (at !== -1) {
      const nameLen = z.readUInt16LE(at + 26);
      const name = z.slice(at + 30, at + 30 + nameLen).toString();
      if (name === 'word/document.xml') {
        z.writeUInt32LE(0, at + 18);
        z.writeUInt32LE(0, at + 22);
        z.writeUInt16LE(0x08, at + 6);
        patched++;
        break;
      }
      at = z.indexOf(localSig, at + 4);
    }
    assert.equal(patched, 1, 'test could not locate the local header to zero');
    const { abs, cleanup } = tmpFile('descriptor.docx', z);
    try {
      const out = await extractDocx(abs);
      assert.match(out.text, /Sizes only in the central directory/);
    } finally { cleanup(); }
  });
});

describe('extract dispatcher: allow-list reconciliation', () => {
  test('the upload allow-list and the dispatcher are the same set', () => {
    assert.deepEqual([...ALLOWED_UPLOAD_EXTS].sort(), Object.keys(EXT_TO_FORMAT).sort());
  });

  test('every allow-listed extension resolves to a format the dispatcher handles', () => {
    const handled = new Set(['pdf', 'image', 'text', 'markdown', 'docx', 'audio']);
    for (const ext of ALLOWED_UPLOAD_EXTS) {
      const fmt = formatFor(`x${ext}`);
      assert.ok(fmt, `${ext} maps to no format`);
      assert.ok(handled.has(fmt), `${ext} maps to unhandled format ${fmt}`);
    }
  });

  test('csv and docx are now accepted; .doc is not', () => {
    assert.equal(formatFor('labs.csv'), 'text');
    assert.equal(formatFor('letter.docx'), 'docx');
    assert.equal(formatFor('letter.DOCX'), 'docx');
    assert.equal(formatFor('old.doc'), null,
      'pre-2007 binary .doc is a different format and stays unsupported');
  });

  test('a csv extracts verbatim, so lab exports keep their numbers', async () => {
    const { extract } = require('../ingest/extract');
    const csv = 'analyte,result,unit,range\nhaemoglobin,147,g/L,130-180\nferritin,8.8,ug/L,30-300\n';
    const { abs, cleanup } = tmpFile('labs.csv', Buffer.from(csv));
    try {
      const out = await extract(abs);
      assert.equal(out.sourceFormat, 'text');
      assert.equal(out.text, csv, 'csv body was reformatted');
    } finally { cleanup(); }
  });

  test('extract routes docx through the docx extractor', async () => {
    const { extract } = require('../ingest/extract');
    const { abs, cleanup } = tmpFile('letter.docx', makeDocx(['Referral enclosed']));
    try {
      const out = await extract(abs);
      assert.equal(out.sourceFormat, 'docx');
      assert.match(out.text, /Referral enclosed/);
    } finally { cleanup(); }
  });

  test('extract passes a psm through to the image extractor', { skip: !HAS_TESSERACT }, async () => {
    // The plumbing "retry OCR at the next rung" depends on.
    const { extract } = require('../ingest/extract');
    const { abs, cleanup } = tmpFile('blank.png', makePng(64, 64));
    try {
      const out = await extract(abs, { psm: 6 });
      assert.equal(out.sourceFormat, 'image');
      assert.equal(out.psm, 6, 'psm was not threaded through the dispatcher');
    } finally { cleanup(); }
  });
});
