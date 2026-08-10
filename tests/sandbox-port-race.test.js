// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/sandbox-port-race.test.js
//
// The test harness itself, because when it fails it blames innocent code.
//
// spawnServer picks a port in the parent, closes the probe socket, then hands
// the number to a child. Between the close and the child's bind another test
// file's harness can be handed the same port. Reproduced directly on this
// platform: 24 concurrent processes doing probe / close / wait 300 ms / bind
// were handed a duplicate. The loser's server dies of EADDRINUSE before it
// prints anything, so a full run drops one or two spawnServer files, a
// different pair each run, with every subtest in the dropped file reporting as
// passing. That reads as a regression in whatever changed last and never is one.
//
// The window cannot be closed from the harness (the probe must be released
// before the child can bind, and passing a listening handle down would mean
// teaching server.js about a test harness), so the harness retries. These tests
// pin that the retry exists, that it is driven by the right signal, and that it
// does NOT swallow a genuinely broken server.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const {
  createSandbox, cleanupSandbox, spawnServer, req,
} = require('./helpers/sandbox');

// Hold a port open, and report which one.
function occupy() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, release: () => new Promise(r => srv.close(r)) });
    });
  });
}

describe('spawnServer survives losing the port race', () => {
  test('a server whose first drawn port is taken still starts', async () => {
    // The harness cannot be told which port to draw, so this comes at it from
    // the other side: occupy a large block of ports so that a first draw
    // landing on one of them is likely, and assert the server starts anyway.
    // Without a retry the file would abort with "server exited with code 1".
    const held = [];
    for (let i = 0; i < 200; i++) held.push(await occupy());
    const sandbox = createSandbox();
    let server;
    try {
      server = await spawnServer(sandbox);
      const health = await req(server.baseUrl, '/healthz');
      assert.equal(health.status, 200, 'the server started but is not answering');
      // And it did not end up on a port somebody else is holding.
      assert.ok(!held.some(h => h.port === server.port),
        'the server bound a port another socket already held');
    } finally {
      if (server) await server.kill();
      cleanupSandbox(sandbox);
      for (const h of held) await h.release();
    }
  });

  test('the retry is driven by EADDRINUSE, and a broken server is not retried', () => {
    // Structural, deliberately. The distinction is the load-bearing part: a
    // retry loop that swallowed every startup failure would turn a real bug
    // into five slow identical failures and a misleading message. There is no
    // way to make server.js fail in a controlled non-port way from here without
    // shipping a test-only failure switch in production code.
    const src = fs.readFileSync(path.join(__dirname, 'helpers', 'sandbox.js'), 'utf8');

    const spawnAt = src.indexOf('async function spawnServer(');
    assert.ok(spawnAt > 0, 'could not find spawnServer');
    const spawnBody = src.slice(spawnAt, src.indexOf('async function _spawnServerOnce', spawnAt));

    assert.match(spawnBody, /addrInUse/,
      'spawnServer no longer distinguishes a port race from a broken server');
    assert.match(spawnBody, /throw e/,
      'spawnServer no longer rethrows a non-port failure immediately');
    assert.match(spawnBody, /for \(|while \(/,
      'spawnServer retries at most once again; a single retry leaves a real residual failure rate');

    // And the signal it keys on is still set from stderr, which is where a bind
    // failure prints (verified: exit code 1, stderr carries EADDRINUSE).
    assert.match(src, /err\.addrInUse = \/EADDRINUSE\/\.test\(errBuf\)/,
      'the addrInUse flag is no longer derived from the child stderr');
  });

  test('several servers started at once all get distinct ports', async () => {
    // The condition the retry exists to handle, exercised concurrently rather
    // than by structure. Two servers sharing a port would mean requests landing
    // on the wrong sandbox, which is worse than a crash.
    const sandboxes = [];
    const servers = [];
    try {
      for (let i = 0; i < 6; i++) sandboxes.push(createSandbox());
      const started = await Promise.all(sandboxes.map(s => spawnServer(s)));
      servers.push(...started);

      const ports = started.map(s => s.port);
      assert.equal(new Set(ports).size, ports.length,
        `two servers bound the same port: ${ports.join(', ')}`);

      // Each one is genuinely serving its own sandbox.
      for (const s of started) {
        const health = await req(s.baseUrl, '/healthz');
        assert.equal(health.status, 200, `server on ${s.port} is not answering`);
      }
    } finally {
      for (const s of servers) await s.kill();
      for (const s of sandboxes) cleanupSandbox(s);
    }
  });
});
