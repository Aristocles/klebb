// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.samples-stream-headers.test.js
//
// The reader's header-capture hook (#639): a caller that needs a header
// value (the import validator gates on version) gets it without a
// whole-file parse, capped so a hostile header cannot be buffered whole,
// and the hook's presence must not disturb what the stream yields.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { streamPushes } = require('../health-auto-export/samples-stream');

let seq = 0;
function fileWith(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-stream-hdr-'));
  const file = path.join(dir, `s${seq++}.json`);
  fs.writeFileSync(file, content);
  return file;
}

async function collect(content, opts) {
  const file = fileWith(content);
  const pushes = [];
  try {
    for await (const p of streamPushes(file, opts)) pushes.push(p);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  return pushes;
}

describe('samples-stream header capture', () => {
  test('scalar, string, and complex headers arrive with the right kind', async () => {
    const seen = [];
    const pushes = await collect(
      '{"version":1,"device":"iPhone","meta":{"a":[1,2]},"count":42,"pushes":[{"receivedAt":"x"}],"trailing":null}',
      { onHeader: (k, v) => seen.push([k, v]) });
    assert.strictEqual(pushes.length, 1);
    assert.deepStrictEqual(seen, [
      ['version', { kind: 'scalar', text: '1' }],
      ['device', { kind: 'string', text: '"iPhone"' }],
      ['meta', { kind: 'complex' }],
      ['count', { kind: 'scalar', text: '42' }],
      ['trailing', { kind: 'scalar', text: 'null' }],
    ]);
  });

  test('text re-parses as JSON, escapes included', async () => {
    const seen = {};
    await collect('{"note":"a \\"quoted\\" thing","pushes":[]}',
      { onHeader: (k, v) => { seen[k] = v; } });
    assert.strictEqual(JSON.parse(seen.note.text), 'a "quoted" thing');
  });

  test('a header after the pushes array is still delivered', async () => {
    const seen = {};
    const pushes = await collect('{"pushes":[{"a":1},{"b":2}],"version":2}',
      { onHeader: (k, v) => { seen[k] = v; } });
    assert.strictEqual(pushes.length, 2);
    assert.deepStrictEqual(seen.version, { kind: 'scalar', text: '2' });
  });

  test('an over-cap header value degrades to complex instead of buffering', async () => {
    const seen = {};
    await collect(`{"big":"${'x'.repeat(4096)}","pushes":[]}`,
      { onHeader: (k, v) => { seen[k] = v; } });
    assert.deepStrictEqual(seen.big, { kind: 'complex' });
  });

  test('no hook, no change: the stream yields the same pushes', async () => {
    const content = '{"version":1,"pushes":[{"a":1},{"b":2}]}';
    assert.deepStrictEqual(await collect(content), await collect(content, { onHeader: () => {} }));
  });

  test('a hostile header key is refused at the cap, not buffered (#672)', async () => {
    // Values were capped from the start; the key was the one accumulator a
    // crafted in-cap archive could grow without bound.
    const content = `{"${'k'.repeat(4096)}":1,"pushes":[]}`;
    await assert.rejects(collect(content), { code: 'SAMPLES_STREAM_INVALID' });
    await assert.rejects(collect(content, { onHeader: () => {} }), { code: 'SAMPLES_STREAM_INVALID' });
  });

  test('a bare array yields pushes and no headers', async () => {
    const seen = [];
    const pushes = await collect('[{"a":1}]', { onHeader: (k, v) => seen.push([k, v]) });
    assert.strictEqual(pushes.length, 1);
    assert.deepStrictEqual(seen, []);
  });
});
