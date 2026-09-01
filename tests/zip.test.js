// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/zip.test.js
// The vendored zip modules (lib/zip/read.js, lib/zip/write.js) carry the
// import upload and export download. Round trip through the writer, then
// hostile fixtures assembled by hand (headers built byte-by-byte, so each
// refusal is driven by exactly one poisoned field) against the reader.
// Every refusal must throw a stable .code and leave the destination with
// nothing. The writer's output must also be accepted by an independent
// extractor (python3's zipfile, the tooling the hosting side uses); that
// test skips cleanly when python3 is not on PATH.

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { openZip } = require('../lib/zip/read');
const { writeZip } = require('../lib/zip/write');

let tmpRoot;
let dirSeq = 0;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-zip-test-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function freshDir() {
  const dir = path.join(tmpRoot, `case-${dirSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Hand-assembled zip: every field defaults to a valid value so each fixture
// poisons exactly the field under test.
function buildZip(specs, opts = {}) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const spec of specs) {
    const nameBytes = Buffer.from(spec.name, 'utf8');
    const data = spec.data ?? Buffer.from('payload bytes for the fixture');
    const method = spec.method ?? 8;
    const body = spec.compData ??
      (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = spec.crc ?? zlib.crc32(data);
    const uncomp = spec.uncompressedSize ?? data.length;
    const flags = spec.flags ?? 0;
    const localExtra = spec.localExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(uncomp, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    chunks.push(local, nameBytes, localExtra, body);
    centrals.push({
      nameBytes, flags, method, crc,
      comp: body.length, uncomp,
      extra: spec.extra ?? Buffer.alloc(0),
      externalAttrs: spec.externalAttrs ?? 0,
      localOffset: offset,
    });
    offset += 30 + nameBytes.length + localExtra.length + body.length;
  }
  const cdOffset = offset;
  for (const c of centrals) {
    const hdr = Buffer.alloc(46);
    hdr.writeUInt32LE(0x02014b50, 0);
    hdr.writeUInt16LE(20, 4);
    hdr.writeUInt16LE(20, 6);
    hdr.writeUInt16LE(c.flags, 8);
    hdr.writeUInt16LE(c.method, 10);
    hdr.writeUInt32LE(c.crc >>> 0, 16);
    hdr.writeUInt32LE(c.comp, 20);
    hdr.writeUInt32LE(c.uncomp, 24);
    hdr.writeUInt16LE(c.nameBytes.length, 28);
    hdr.writeUInt16LE(c.extra.length, 30);
    hdr.writeUInt32LE(c.externalAttrs >>> 0, 38);
    hdr.writeUInt32LE(c.localOffset, 42);
    chunks.push(hdr, c.nameBytes, c.extra);
    offset += 46 + c.nameBytes.length + c.extra.length;
  }
  const comment = opts.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.entryCount ?? specs.length, 8);
  eocd.writeUInt16LE(opts.entryCount ?? specs.length, 10);
  eocd.writeUInt32LE(opts.cdSize ?? offset - cdOffset, 12);
  eocd.writeUInt32LE(opts.cdOffset ?? cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  chunks.push(eocd, comment);
  return Buffer.concat(chunks);
}

function writeFixture(buf) {
  const file = path.join(freshDir(), 'fixture.zip');
  fs.writeFileSync(file, buf);
  return file;
}

// Structural refusals must fire at openZip time, before any byte is
// extracted; asserting on openZip directly (not extractTo) stops the
// extractor's containment assert from masking a broken central-directory
// guard, which failure injection proved it otherwise does.
async function expectOpenRefusal(zipBuf, code, openOpts) {
  const file = writeFixture(zipBuf);
  await assert.rejects(openZip(file, openOpts),
    (err) => err.code === code ||
      assert.fail(`expected ${code} at open, got ${err.code}: ${err.message}`));
}

async function expectRefusal(zipBuf, code, openOpts) {
  const file = writeFixture(zipBuf);
  await assert.rejects(
    async () => {
      const zip = await openZip(file, openOpts);
      try {
        await zip.extractTo(path.join(path.dirname(file), 'dest'));
      } finally {
        await zip.close();
      }
    },
    (err) => err.code === code ||
      assert.fail(`expected ${code}, got ${err.code}: ${err.message}`),
  );
  const dest = path.join(path.dirname(file), 'dest');
  assert.ok(!fs.existsSync(dest), 'destination must not exist after refusal');
  const leftovers = fs.readdirSync(path.dirname(file))
    .filter((n) => n.includes('.partial-'));
  assert.deepEqual(leftovers, [], 'no partial extraction dirs left behind');
}

describe('#614 zip writer to reader round trip', () => {
  test('small tree with subdirectories survives byte-identical', async () => {
    const base = freshDir();
    const src = path.join(base, 'src');
    fs.mkdirSync(path.join(src, 'sub', 'deeper'), { recursive: true });
    const files = {
      'a.txt': Buffer.from('plain text content\n'.repeat(50)),
      'sub/b.bin': crypto.randomBytes(70000),
      'sub/deeper/c.json': Buffer.from(JSON.stringify({ k: 'v', n: 42 })),
    };
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(src, name), data);
    }
    const zipFile = path.join(base, 'out.zip');
    const result = await writeZip(zipFile, Object.keys(files).map((name) => ({
      name, sourcePath: path.join(src, name),
    })));
    assert.equal(result.entryCount, 3);
    assert.equal(result.bytes, fs.statSync(zipFile).size);

    const zip = await openZip(zipFile);
    try {
      const names = zip.entries().map((e) => e.name).sort();
      assert.deepEqual(names, Object.keys(files).sort());
      const dest = path.join(base, 'dest');
      await zip.extractTo(dest);
      for (const [name, data] of Object.entries(files)) {
        assert.ok(fs.readFileSync(path.join(dest, name)).equals(data),
          `bytes identical: ${name}`);
      }
    } finally {
      await zip.close();
    }
  });

  test('incompressible data is stored, compressible is deflated', async () => {
    const base = freshDir();
    fs.writeFileSync(path.join(base, 'random.bin'), crypto.randomBytes(8000));
    fs.writeFileSync(path.join(base, 'zeros.bin'), Buffer.alloc(8000));
    const zipFile = path.join(base, 'out.zip');
    await writeZip(zipFile, [
      { name: 'random.bin', sourcePath: path.join(base, 'random.bin') },
      { name: 'zeros.bin', sourcePath: path.join(base, 'zeros.bin') },
    ]);
    const zip = await openZip(zipFile);
    try {
      const byName = Object.fromEntries(zip.entries().map((e) => [e.name, e]));
      assert.equal(byName['random.bin'].method, 0, 'store when deflate does not shrink');
      assert.equal(byName['random.bin'].compressedSize, 8000);
      assert.equal(byName['zeros.bin'].method, 8, 'deflate when it shrinks');
      assert.ok(byName['zeros.bin'].compressedSize < 8000);
    } finally {
      await zip.close();
    }
  });

  test('entries above the spill threshold round-trip byte-identical, spill file gone (#655)', async () => {
    // One compressible (deflate wins: body streams from the spill file) and
    // one incompressible (store wins: body streams from the source), both
    // over the 8MB threshold, mixed with a small buffered entry so offsets
    // interleave the two paths.
    const base = freshDir();
    const src = path.join(base, 'src');
    fs.mkdirSync(src, { recursive: true });
    const files = {
      'big-compressible.json': Buffer.from(`[${'{"date":"2026-03-01","qty":123},'.repeat(300000)}null]`),
      'big-random.bin': crypto.randomBytes(9 * 1024 * 1024),
      'small.txt': Buffer.from('hello\n'),
    };
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(src, name), data);
    }
    assert.ok(files['big-compressible.json'].length > 8 * 1024 * 1024, 'fixture under threshold');

    const zipFile = path.join(base, 'out.zip');
    const result = await writeZip(zipFile, Object.keys(files).map((name) => ({
      name, sourcePath: path.join(src, name),
    })));
    assert.equal(result.entryCount, 3);
    assert.equal(result.bytes, fs.statSync(zipFile).size);
    assert.ok(!fs.existsSync(`${zipFile}.spill`), 'the spill file must not outlive the write');

    const zip = await openZip(zipFile);
    try {
      const byName = Object.fromEntries(zip.entries().map((e) => [e.name, e]));
      assert.equal(byName['big-compressible.json'].method, 8, 'deflate when it shrinks');
      assert.equal(byName['big-random.bin'].method, 0, 'store when deflate does not shrink');
      const dest = path.join(base, 'dest');
      await zip.extractTo(dest);
      for (const [name, data] of Object.entries(files)) {
        assert.ok(fs.readFileSync(path.join(dest, name)).equals(data),
          `bytes identical: ${name}`);
      }
    } finally {
      await zip.close();
    }
  });

  test('writer accepts an async iterable of entries', async () => {
    const base = freshDir();
    fs.writeFileSync(path.join(base, 'x.txt'), 'x');
    async function* gen() {
      yield { name: 'x.txt', sourcePath: path.join(base, 'x.txt') };
    }
    const zipFile = path.join(base, 'out.zip');
    const result = await writeZip(zipFile, gen());
    assert.equal(result.entryCount, 1);
  });

  test('writer refuses unsafe names and removes the partial file', async () => {
    const base = freshDir();
    fs.writeFileSync(path.join(base, 'x.txt'), 'x');
    const zipFile = path.join(base, 'out.zip');
    await assert.rejects(
      writeZip(zipFile, [{ name: '../evil', sourcePath: path.join(base, 'x.txt') }]),
      (err) => err.code === 'ZIP_NAME',
    );
    assert.ok(!fs.existsSync(zipFile), 'partial archive removed');
  });

  // #652: the destination is opened before the first entry is validated, and
  // destroying a stream mid-open does not cancel the open. A cleanup that does
  // not wait for the descriptor to close races it, and the late open recreates
  // the archive that was just removed. One attempt loses that race maybe a
  // third of the time, which is a flake rather than a signal, so drive it
  // repeatedly: any single stray is the whole bug.
  test('a refused write leaves nothing behind, however the open lands', async () => {
    const base = freshDir();
    fs.writeFileSync(path.join(base, 'x.txt'), 'x');
    const strays = [];
    for (let i = 0; i < 40; i++) {
      const zipFile = path.join(base, `out-${i}.zip`);
      await assert.rejects(
        writeZip(zipFile, [{ name: '../evil', sourcePath: path.join(base, 'x.txt') }]),
        (err) => err.code === 'ZIP_NAME',
      );
      // Long enough for a deferred open to land: it is queued before the
      // rejection and takes microseconds, so a file still absent here is
      // absent because the writer waited, not because the check was early.
      await new Promise((r) => setTimeout(r, 5));
      if (fs.existsSync(zipFile)) strays.push(i);
    }
    assert.deepEqual(strays, [], 'no attempt left an archive on disk');
  });

  // The other side of that wait: a failure raised after bytes are already
  // written has an open descriptor to close rather than a pending open, so
  // this proves the cleanup completes there too instead of waiting forever.
  test('a source that disappears mid-write cleans up and still rejects', async () => {
    const base = freshDir();
    fs.writeFileSync(path.join(base, 'first.txt'), 'first');
    const zipFile = path.join(base, 'out.zip');
    await assert.rejects(
      writeZip(zipFile, [
        { name: 'first.txt', sourcePath: path.join(base, 'first.txt') },
        { name: 'gone.txt', sourcePath: path.join(base, 'gone.txt') },
      ]),
      (err) => err.code === 'ENOENT',
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(!fs.existsSync(zipFile), 'partial archive removed');
  });

  test('writer output extracts under an independent reader (python3 zipfile)', async (t) => {
    const probe = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      t.skip('python3 not available on PATH');
      return;
    }
    const base = freshDir();
    const src = path.join(base, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    const files = {
      'a.txt': Buffer.from('text payload\n'.repeat(200)),
      'sub/b.bin': crypto.randomBytes(4000),
    };
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(src, name), data);
    }
    const zipFile = path.join(base, 'out.zip');
    await writeZip(zipFile, Object.keys(files).map((name) => ({
      name, sourcePath: path.join(src, name),
    })));
    const dest = path.join(base, 'pydest');
    const script = [
      'import sys, zipfile',
      'zf = zipfile.ZipFile(sys.argv[1])',
      'assert zf.testzip() is None',
      'zf.extractall(sys.argv[2])',
    ].join('\n');
    const run = spawnSync('python3', ['-c', script, zipFile, dest], { encoding: 'utf8' });
    assert.equal(run.status, 0, `python3 zipfile rejected the archive: ${run.stderr}`);
    for (const [name, data] of Object.entries(files)) {
      assert.ok(fs.readFileSync(path.join(dest, name)).equals(data),
        `python-extracted bytes identical: ${name}`);
    }
  });
});

describe('#614 zip reader refusals', () => {
  test('dot-dot name refuses with ZIP_NAME', async () => {
    await expectOpenRefusal(buildZip([{ name: '../escape.txt' }]), 'ZIP_NAME');
    await expectOpenRefusal(buildZip([{ name: 'a/../../b.txt' }]), 'ZIP_NAME');
  });

  test('backslash name refuses with ZIP_NAME', async () => {
    await expectOpenRefusal(buildZip([{ name: 'a\\b.txt' }]), 'ZIP_NAME');
  });

  test('absolute and drive-letter names refuse with ZIP_NAME', async () => {
    await expectOpenRefusal(buildZip([{ name: '/etc/passwd' }]), 'ZIP_NAME');
    await expectOpenRefusal(buildZip([{ name: 'C:/x.txt' }]), 'ZIP_NAME');
  });

  test('control character in name refuses with ZIP_NAME', async () => {
    await expectOpenRefusal(buildZip([{ name: 'bad\x07name.txt' }]), 'ZIP_NAME');
  });

  test('encrypted entry refuses with ZIP_ENCRYPTED', async () => {
    await expectOpenRefusal(buildZip([{ name: 'a.txt', flags: 0x0001 }]), 'ZIP_ENCRYPTED');
  });

  test('compression method 12 refuses with ZIP_METHOD', async () => {
    const data = Buffer.from('payload');
    await expectOpenRefusal(
      buildZip([{ name: 'a.txt', method: 12, data, compData: data }]),
      'ZIP_METHOD');
  });

  test('symlink external attributes refuse with ZIP_SYMLINK', async () => {
    await expectOpenRefusal(
      buildZip([{ name: 'link', externalAttrs: (0o120777 << 16) >>> 0 }]),
      'ZIP_SYMLINK');
  });

  test('zip64 extra field refuses with ZIP_ZIP64', async () => {
    const extra = Buffer.alloc(4 + 16);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    await expectOpenRefusal(buildZip([{ name: 'a.txt', extra }]), 'ZIP_ZIP64');
  });

  test('zip64 EOCD signature in the tail window refuses with ZIP_ZIP64', async () => {
    const comment = Buffer.from('PK\x06\x06', 'latin1');
    await expectOpenRefusal(buildZip([{ name: 'a.txt' }], { comment }), 'ZIP_ZIP64');
  });

  test('0xFFFF entry count and 0xFFFFFFFF offset refuse with ZIP_ZIP64', async () => {
    await expectOpenRefusal(buildZip([{ name: 'a.txt' }], { entryCount: 0xFFFF }), 'ZIP_ZIP64');
    await expectOpenRefusal(buildZip([{ name: 'a.txt' }], { cdOffset: 0xFFFFFFFF }), 'ZIP_ZIP64');
  });

  test('declared uncompressed size smaller than actual aborts with ZIP_SIZE', async () => {
    const data = Buffer.from('x'.repeat(50000));
    await expectRefusal(
      buildZip([{ name: 'a.txt', data, uncompressedSize: 10 }]),
      'ZIP_SIZE');
  });

  test('declared uncompressed size larger than actual refuses with ZIP_SIZE', async () => {
    const data = Buffer.from('short');
    await expectRefusal(
      buildZip([{ name: 'a.txt', data, uncompressedSize: 5000 }]),
      'ZIP_SIZE');
  });

  test('corrupted CRC refuses with ZIP_CRC', async () => {
    const data = Buffer.from('crc target payload');
    const badCrc = (zlib.crc32(data) ^ 0x1) >>> 0;
    await expectRefusal(
      buildZip([{ name: 'a.txt', data, crc: badCrc }]),
      'ZIP_CRC');
  });

  test('maxEntries cap trips with ZIP_CAP naming the cap', async () => {
    const file = writeFixture(buildZip([{ name: 'a.txt' }, { name: 'b.txt' }]));
    await assert.rejects(openZip(file, { maxEntries: 1 }),
      (err) => err.code === 'ZIP_CAP' && /maxEntries/.test(err.message));
  });

  test('maxEntryBytes cap trips with ZIP_CAP naming the cap', async () => {
    const data = Buffer.from('y'.repeat(2000));
    const file = writeFixture(buildZip([{ name: 'a.txt', data }]));
    await assert.rejects(openZip(file, { maxEntryBytes: 100 }),
      (err) => err.code === 'ZIP_CAP' && /maxEntryBytes/.test(err.message));
  });

  test('cumulative maxTotalBytes cap trips with ZIP_CAP naming the cap', async () => {
    const data = Buffer.from('z'.repeat(600));
    const file = writeFixture(buildZip([
      { name: 'a.txt', data }, { name: 'b.txt', data },
    ]));
    await assert.rejects(openZip(file, { maxTotalBytes: 1000 }),
      (err) => err.code === 'ZIP_CAP' && /maxTotalBytes/.test(err.message));
    const zip = await openZip(file, { maxTotalBytes: 1200 });
    await zip.close();
  });

  test('non-zip garbage refuses with ZIP_BAD', async () => {
    const file = writeFixture(Buffer.from('this is not a zip archive at all'));
    await assert.rejects(openZip(file), (err) => err.code === 'ZIP_BAD');
  });
});

describe('#614 zip reader structure handling', () => {
  test('local extra length differing from central still locates the data', async () => {
    const data = Buffer.from('locate me correctly');
    const localExtra = Buffer.alloc(12);
    localExtra.writeUInt16LE(0x6666, 0);
    localExtra.writeUInt16LE(8, 2);
    const file = writeFixture(buildZip([{ name: 'a.txt', data, localExtra }]));
    const zip = await openZip(file);
    try {
      const dest = path.join(path.dirname(file), 'dest');
      await zip.extractTo(dest);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'),
        'locate me correctly');
    } finally {
      await zip.close();
    }
  });

  test('directory entries are created; names exposed as safe relatives', async () => {
    const data = Buffer.from('nested');
    const file = writeFixture(buildZip([
      { name: 'sub/', data: Buffer.alloc(0), method: 0 },
      { name: 'sub/x.txt', data },
    ]));
    const zip = await openZip(file);
    try {
      const entries = zip.entries();
      assert.deepEqual(
        entries.map((e) => [e.name, e.isDirectory]),
        [['sub', true], ['sub/x.txt', false]]);
      const dest = path.join(path.dirname(file), 'dest');
      await zip.extractTo(dest);
      assert.ok(fs.statSync(path.join(dest, 'sub')).isDirectory());
      assert.equal(fs.readFileSync(path.join(dest, 'sub', 'x.txt'), 'utf8'), 'nested');
    } finally {
      await zip.close();
    }
  });

  test('store entries round trip and are CRC-checked too', async () => {
    const data = Buffer.from('stored not deflated');
    const okFile = writeFixture(buildZip([{ name: 's.txt', data, method: 0 }]));
    const zip = await openZip(okFile);
    try {
      const dest = path.join(path.dirname(okFile), 'dest');
      await zip.extractTo(dest);
      assert.equal(fs.readFileSync(path.join(dest, 's.txt'), 'utf8'),
        'stored not deflated');
    } finally {
      await zip.close();
    }
    const badCrc = (zlib.crc32(data) ^ 0xFF) >>> 0;
    await expectRefusal(
      buildZip([{ name: 's.txt', data, method: 0, crc: badCrc }]),
      'ZIP_CRC');
  });
});
