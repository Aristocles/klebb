// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/request-body-utf8.test.js
//
// Every JSON route accumulated its request body with `body += chunk`, which
// decodes each chunk independently. A multi-byte UTF-8 character straddling a
// TCP chunk boundary therefore became two replacement characters, silently, in
// whatever was then stored: a card label, a note, a chat message, a manifest.
//
// Found while fixing the same bug on the HAE ingest route (#553); the shape
// turned out to be repeated on 13 other routes (#556).
//
// These tests need a RAW SOCKET, because the defect only appears when a
// character is split across writes and an http client will not do that on
// demand. They also deliberately drive real routes rather than a stub: the
// point is that the fix is wired up where it matters, not that Node's
// StringDecoder works.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, fakeAuthState,
} = require('./helpers/sandbox');

// A string whose characters are multi-byte in UTF-8: the curly apostrophe and
// the accented e are both the kind of thing that turns up in a real device
// name, clinic name or note.
const TRICKY = 'Café — René’s 20µg dose';

// POST/PUT a body over a raw socket, splitting mid-character.
function rawSend(port, method, pathname, bodyBuf, { cookie = null, splitAt = null } = {}) {
  return new Promise((resolve, reject) => {
    const head = Buffer.from([
      `${method} ${pathname} HTTP/1.1`,
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      `Content-Length: ${bodyBuf.length}`,
      ...(cookie ? [`Cookie: ${cookie}`] : []),
      'Connection: close',
      '', '',
    ].join('\r\n'), 'utf8');

    const sock = net.connect(port, '127.0.0.1');
    let out = Buffer.alloc(0);
    sock.on('data', d => { out = Buffer.concat([out, d]); });
    sock.on('error', e => (out.length ? resolve(out.toString('utf8')) : reject(e)));
    sock.on('close', () => resolve(out.toString('utf8')));
    sock.on('connect', () => {
      sock.write(head);
      if (splitAt === null) return sock.end(bodyBuf);
      sock.write(bodyBuf.subarray(0, splitAt));
      // Let the server process the first piece alone; that is what makes the
      // two halves decode independently under the old code.
      setTimeout(() => sock.end(bodyBuf.subarray(splitAt)), 60);
    });
    setTimeout(() => { try { sock.destroy(); } catch {} }, 15000);
  });
}

// Split point: one byte into the first multi-byte character in the payload.
function midCharacterSplit(bodyBuf, char = '’') {
  const at = bodyBuf.indexOf(Buffer.from(char, 'utf8'));
  assert.ok(at > 0, `payload has no ${char} to split on`);
  return at + 1;
}

describe('a request body split mid-character is not corrupted', () => {
  let sandbox, server, auth;

  before(async () => {
    auth = fakeAuthState();
    sandbox = createSandbox({ credentials: auth.credentials, sessions: auth.sessions });
    server = await spawnServer(sandbox);
  });

  after(async () => {
    if (server) await server.kill();
    if (sandbox) cleanupSandbox(sandbox);
  });

  test('a card created with a tricky label keeps it intact', async () => {
    // POST /api/manifests. Padding pushes the label past the first chunk so the
    // split lands inside a character rather than between fields.
    const manifest = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'utf8-label', label: TRICKY, emoji: '🧪',
        view: { enabled: true, component: 'generic-card' },
        // The data route requires this, so the row-write test below can run.
        writeable: {
          fromWebapp: true, todayAllowed: true, pastAllowed: true,
          inputs: [{ key: 'note', label: 'Note', type: 'textarea' }],
        },
      },
      description: `Padding to push the label along. ${'x'.repeat(2000)}`,
      data: [],
    };
    const body = Buffer.from(JSON.stringify(manifest), 'utf8');
    const res = await rawSend(server.port, 'POST', '/api/manifests', body, {
      cookie: auth.cookie, splitAt: midCharacterSplit(body),
    });
    assert.match(res, /HTTP\/1\.1 20[01]/, `create failed: ${res.slice(0, 300)}`);

    // Read it back off disk: what was actually persisted is what matters.
    // The create route names the file <id>.json.
    const file = path.join(sandbox, 'data', 'utf8-label.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.meta.label, TRICKY,
      'the card label was corrupted by a chunk-split request body');
    assert.ok(!JSON.stringify(saved).includes('�'),
      'the saved manifest contains a replacement character');
  });

  test('a data write with tricky row content keeps it intact', async () => {
    // POST /api/manifests/:id/data, the row-write path a note goes through.
    const rows = [];
    for (let i = 0; i < 40; i++) {
      rows.push({ date: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, note: TRICKY });
    }
    const body = Buffer.from(JSON.stringify({ data: rows }), 'utf8');
    const res = await rawSend(server.port, 'POST', '/api/manifests/utf8-label/data', body, {
      cookie: auth.cookie, splitAt: midCharacterSplit(body),
    });
    assert.match(res, /HTTP\/1\.1 200/, `data write failed: ${res.slice(0, 300)}`);

    const read = await rawSend(server.port, 'GET', '/api/manifests/utf8-label/data',
      Buffer.alloc(0), { cookie: auth.cookie });
    assert.ok(!read.includes('�'), 'the stored rows contain a replacement character');
    assert.ok(read.includes('Caf'), 'the note text is missing entirely');
  });

  test('chat history survives a mid-character split', async () => {
    // PUT /api/chat/history: the body most likely to carry this text in
    // practice, and it was the one accumulator with its own size cap.
    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: i % 2 ? 'assistant' : 'user', content: `${TRICKY} #${i}` });
    }
    const body = Buffer.from(JSON.stringify({ messages }), 'utf8');
    const res = await rawSend(server.port, 'PUT', '/api/chat/history', body, {
      cookie: auth.cookie, splitAt: midCharacterSplit(body),
    });
    assert.match(res, /HTTP\/1\.1 200/, `history write failed: ${res.slice(0, 300)}`);

    const stored = fs.readFileSync(path.join(sandbox, 'chat', 'history.json'), 'utf8');
    assert.ok(!stored.includes('�'),
      'chat history was corrupted by a chunk-split request body');
    assert.ok(stored.includes(TRICKY), 'the message text did not round-trip');
  });
});

describe('every JSON accumulator decodes on the stream', () => {
  // A structural guard. The bug is a one-line omission that is easy to
  // reintroduce when adding a route by copying an existing one, and it fails
  // silently: nothing errors, the text is just quietly wrong.
  test('no `body += chunk` accumulator lacks a setEncoding above it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').split('\n');
    const offenders = [];
    for (let i = 0; i < src.length; i++) {
      const line = src[i];
      if (!/body \+= c\b/.test(line)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      const window = src.slice(Math.max(0, i - 12), i).join('\n');
      if (!/setEncoding\('utf8'\)/.test(window)) offenders.push(`${i + 1}: ${trimmed}`);
    }
    assert.deepEqual(offenders, [],
      'these routes accumulate a body as a string without utf8 stream decoding, '
      + 'so a character split across TCP chunks will be silently corrupted:\n'
      + offenders.join('\n'));
  });

  test('binary upload paths still collect Buffers, not strings', () => {
    // setEncoding would corrupt an image or an audio file, so the two binary
    // routes must NOT have it: they concat Buffers instead.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const marker of ["parts[1] === 'asr'", "parts[1] === 'upload'"]) {
      const at = src.indexOf(marker);
      assert.ok(at > 0, `could not find the ${marker} route`);
      const block = src.slice(at, at + 3000);
      assert.ok(!/setEncoding/.test(block),
        `${marker} has setEncoding, which would corrupt binary uploads`);
    }
  });
});
