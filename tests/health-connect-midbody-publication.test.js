// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const helper = process.env.INDEPENDENT_LATCH_HELPER ||
  path.join(__dirname, 'helpers/health-connect-midbody-preload.cjs');
const expected = {
  phase: 'admission-iterator-consumed-first-chunk-before-request-end',
  bytes: 5,
  action: 'admission-observe',
};
const childSource = `
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const latch = process.env.INDEPENDENT_MID_BODY_LATCH;
const original = fs.writeFileSync;
let intercepted = false;
fs.writeFileSync = function (destination, value, options) {
  if (!intercepted && pathOwned(destination)) {
    intercepted = true;
    const bytes = Buffer.from(value, 'utf8');
    const fd = fs.openSync(destination, options.flag || 'w', options.mode);
    try {
      const split = Math.floor(bytes.length / 2);
      fs.writeSync(fd, bytes, 0, split);
      process.send({ phase: 'partial-observation-write-held' });
      const release = Buffer.alloc(1);
      if (fs.readSync(0, release, 0, 1, null) !== 1 || release[0] !== 82) {
        throw new Error('controlled observation writer was not released');
      }
      fs.writeSync(fd, bytes, split, bytes.length - split);
    } finally { fs.closeSync(fd); }
    return;
  }
  return Reflect.apply(original, fs, [destination, value, options]);
};
function pathOwned(destination) {
  return typeof destination === 'string' &&
    (destination === latch || destination.startsWith(latch + '.'));
}
require(process.env.INDEPENDENT_LATCH_HELPER);
const request = {
  method: 'POST', url: '/api/connectors/health-connect/pairing-grants',
  async *[Symbol.asyncIterator]() { yield Buffer.from('abcde'); },
};
const server = http.createServer();
server.emit('request', request);
(async () => {
  for await (const chunk of request) {
    if (chunk.toString('utf8') !== 'abcde') throw new Error('fixture chunk changed');
  }
  if (!intercepted) throw new Error('actual fixture write was not intercepted');
  process.send({ phase: 'actual-fixture-iterator-complete' });
  process.disconnect();
})().catch(error => { console.error(error.message); process.exitCode = 1; process.disconnect(); });
`;
test('mid-body observation filename is absent until its complete JSON is published',
  { timeout: 15000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-test-'));
    const latch = path.join(home, 'publication-latch.json');
    const child = spawn(process.execPath, ['-e', childSource], {
      env: { ...process.env, HEALTH_HOME: home, NODE_OPTIONS: '',
        INDEPENDENT_LATCH_HELPER: path.resolve(helper),
        INDEPENDENT_MID_BODY_LATCH: latch,
        INDEPENDENT_MID_BODY_ACTION: 'admission-observe' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '', stderr = '', held = false, completed = false;
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.on('error', () => {});
    const close = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      assert.equal(fs.existsSync(latch), false);
      const partial = new Promise((resolve, reject) => {
        child.on('message', event => {
          if (event.phase === 'partial-observation-write-held') { held = true; resolve(); }
          if (event.phase === 'actual-fixture-iterator-complete') completed = true;
        });
        child.once('error', reject);
        child.once('close', () => { if (!held) reject(new Error('held fixture write was not observed')); });
      });
      let observationError;
      try {
        await partial;
        assert.equal(fs.existsSync(latch), false,
          'final observation filename must stay absent while its JSON write is partial');
      } catch (error) { observationError = error; }
      finally { child.stdin.end('R'); }
      const result = await close;
      assert.deepEqual(result, { code: 0, signal: null }, stderr || stdout);
      assert.equal(completed, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(latch, 'utf8')), expected);
      if (observationError) throw observationError;
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await close;
      assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
      assert.ok(path.basename(home).startsWith('eh-test-'));
      assert.equal(fs.lstatSync(home).isSymbolicLink(), false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
