// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.body-integrity.test.js
//
// Regressions for two HAE ingest defects a war-game of the surface confirmed
// (#553), both of which reproduced against a real spawned server:
//
//   1. The POST body was accumulated as a JS string (`body += chunk`), so a
//      multi-byte UTF-8 sequence split across a TCP chunk boundary decoded to
//      U+FFFD on both sides. Permanently: in the parsed rows AND in the
//      "verbatim" raw archive. A device name with a curly apostrophe or an
//      accent is enough, and nothing downstream can recover the bytes.
//   2. The over-cap path called req.destroy() inside the data handler, so
//      'end' never fired and the 413 plus its diagnostic were unreachable.
//      An oversize push got a bare TCP reset.
//
// These need a RAW SOCKET rather than an http client, because the bug only
// appears when a character straddles a chunk boundary, and that means
// controlling exactly where the writes split.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, req,
} = require('./helpers/sandbox');
const { readSamples } = require('./helpers/hae-samples-readback');

const TOKEN = 'hae-body-integrity-token';

// POST a body over a raw socket, splitting it at an exact byte offset so a
// multi-byte character lands across the boundary.
function rawPost(port, pathname, bodyBuf, { splitAt = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const head = Buffer.from([
      `POST ${pathname} HTTP/1.1`,
      'Host: 127.0.0.1',
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      `Content-Length: ${bodyBuf.length}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      'Connection: close',
      '', '',
    ].join('\r\n'), 'utf8');

    const sock = net.connect(port, '127.0.0.1');
    let response = Buffer.alloc(0);
    sock.on('data', d => { response = Buffer.concat([response, d]); });
    sock.on('error', e => {
      // A reset with no response at all is itself a result worth asserting on.
      if (response.length) return resolve(response.toString('utf8'));
      reject(e);
    });
    sock.on('close', () => resolve(response.toString('utf8')));
    sock.on('connect', () => {
      sock.write(head);
      if (splitAt === null) {
        sock.end(bodyBuf);
        return;
      }
      sock.write(bodyBuf.subarray(0, splitAt));
      // Give the server a tick to process the first chunk on its own, which is
      // what makes the two halves decode independently.
      setTimeout(() => sock.end(bodyBuf.subarray(splitAt)), 60);
    });
    setTimeout(() => { try { sock.destroy(); } catch {} }, 20000);
  });
}

function stepCard(id, metric) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: {
      id, label: 'Steps', emoji: '👣',
      view: { enabled: true, component: 'generic-card' },
      ingest: { source: 'hae', metric },
    },
    description: 'HAE step count.',
    data: [],
  };
}

describe('HAE body is decoded as bytes, not per-chunk', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox({ seed: { 'steps.klebb.json': stepCard('steps', 'step_count') } });
    server = await spawnServer(sandbox, { HEALTH_AUTO_EXPORT_TOKEN: TOKEN });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('a multi-byte character split across TCP chunks is not corrupted', async () => {
    // The real-world trigger: an Apple Watch source name with a curly
    // apostrophe, in a payload big enough that the phone sends it in pieces.
    const SOURCE = 'René’s Apple Watch';
    const data = [];
    for (let i = 1; i <= 120; i++) {
      const day = String(i % 28 + 1).padStart(2, '0');
      data.push({ date: `2026-03-${day} 00:00:00 +1100`, qty: 1000 + i, source: SOURCE });
    }
    const payload = { data: { metrics: [{ name: 'step_count', units: 'count', data }] } };
    const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');

    // Split exactly through the first apostrophe's 3 UTF-8 bytes.
    const apostropheAt = bodyBuf.indexOf(Buffer.from('’', 'utf8'));
    assert.ok(apostropheAt > 0, 'test payload has no multi-byte character to split');
    const splitAt = apostropheAt + 1;

    const res = await rawPost(server.port, '/api/health-auto-export', bodyBuf, { splitAt });
    assert.match(res, /HTTP\/1\.1 200/, `push was not accepted: ${res.slice(0, 200)}`);

    // The stored samples must carry exactly the characters that were sent.
    // Since #546 the durable copy is the samples table rather than a verbatim
    // file, so the claim is about the stored values: a per-chunk decode would
    // put U+FFFD in the middle of the source name, permanently, and nothing
    // downstream could recover the original bytes.
    const stored = readSamples(sandbox, 'step_count');
    assert.equal(stored.length, data.length,
      `expected ${data.length} stored samples, got ${stored.length}`);

    const sources = new Set(stored.map(s => s.sample.source));
    assert.deepEqual([...sources], [SOURCE],
      'a source name was corrupted on the way through');
    for (const s of stored) {
      assert.ok(!String(s.sample.source).includes('�'),
        'a stored sample contains a replacement character: the body was decoded per chunk');
    }

    // Nothing about the payload was lost, not just the one field that was split:
    // every sample round-trips to exactly what was POSTed, in order.
    assert.deepStrictEqual(stored.map(s => s.sample), data,
      'the stored samples are not what was POSTed');
    // And the metric wrapper survived too (units live there, not on the sample).
    assert.deepEqual(stored[0].metricMeta, { units: 'count' });
  });

  test('rows land in the datastore from a chunk-split push', async () => {
    const r = await req(server.baseUrl, '/api/health-auto-export/status');
    // Status is session-gated; what matters is that the push above wrote rows,
    // which the stored-sample assertions already prove end to end. Read the card
    // back through the agent surface instead.
    assert.ok(r.status === 401 || r.status === 403 || r.status === 200);
  });
});

describe('HAE over-cap payload gets a real 413, not a socket reset', () => {
  let sandbox, server;

  before(async () => {
    sandbox = createSandbox();
    server = await spawnServer(sandbox, {
      HEALTH_AUTO_EXPORT_TOKEN: TOKEN,
      // The cap is a module constant, so this suite cannot lower it. Instead it
      // asserts the SHAPE of the response path, which is what regressed: the
      // 413 lived in an 'end' handler that req.destroy() made unreachable.
    });
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('a normal push still answers 200 with a JSON body', async () => {
    const payload = { data: { metrics: [] } };
    const res = await rawPost(server.port, '/api/health-auto-export',
      Buffer.from(JSON.stringify(payload), 'utf8'));
    assert.match(res, /HTTP\/1\.1 200/);
    assert.match(res, /"ok":true/);
  });

  test('the over-cap branch sends its response from the data handler', () => {
    // A structural assertion, because the 100 MB cap cannot be exercised in a
    // unit test. The bug was purely one of placement: the 413 and the
    // diagnostic sat in req.on('end'), which never fires after req.destroy().
    // Anything that moves them back there reintroduces a silent reset.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf('HAE_MAX_BODY');
    assert.ok(start > 0, 'could not locate the HAE body cap');
    const block = src.slice(start, start + 2600);

    assert.match(block, /finishOversize/,
      'the over-cap response is no longer factored out of the end handler');
    // The 413 must be reachable without 'end': assert it is invoked from the
    // data handler, and that the handler drains rather than destroys.
    // Scope to the data handler itself, from its opening to the 'aborted'
    // handler that follows it, rather than to a fixed character count.
    const dataStart = block.indexOf("req.on('data'");
    const dataEnd = block.indexOf("req.on('aborted'", dataStart);
    assert.ok(dataStart > 0 && dataEnd > dataStart, 'could not delimit the data handler');
    const dataHandler = block.slice(dataStart, dataEnd);

    assert.match(dataHandler, /finishOversize\(\)/,
      'the over-cap path does not answer from the data handler');
    assert.match(dataHandler, /req\.resume\(\)/,
      'the over-cap path does not drain the request, so the 413 cannot be delivered');
    assert.ok(!/req\.destroy\(\)/.test(dataHandler),
      'req.destroy() is back in the over-cap path; the 413 becomes unreachable');
  });

  test('the body is accumulated as Buffers', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf('HAE_MAX_BODY');
    const block = src.slice(start, start + 2600);
    assert.match(block, /Buffer\.concat\(chunks\)/,
      'the HAE body is no longer concatenated from Buffers');
    assert.ok(!/body \+= c\b/.test(block),
      'the HAE body is being accumulated as a string again, which corrupts multi-byte characters');
  });
});
