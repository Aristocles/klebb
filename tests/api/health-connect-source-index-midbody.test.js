// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { fixture, restart, close, first, postBatch, req, ORIGIN, REBUILD,
  waitForStatus, coldReadSourceState, assertFirstNative, assertFirstIndex, noAuthority } =
  require(path.join(product, 'tests/helpers/health-connect-source-index-test-fixture.cjs'));
const preload = path.join(__dirname, '../helpers/health-connect-source-index-midbody-preload.cjs');
function heldRebuild(data) {
  const wire = Buffer.from('{}', 'utf8');
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(`${data.server.baseUrl}${REBUILD}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'Content-Length': wire.length, Cookie: data.owner.cookie, Origin: ORIGIN },
    }, result => {
      let body = '';
      result.on('data', bytes => { body += bytes.toString('utf8'); });
      result.on('end', () => {
        try { resolve({ status: result.statusCode, body, json: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
      result.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('bounded held rebuild timeout')));
    request.write(wire.subarray(0, 1));
  });
  void response.catch(() => {});
  return { response, finish: () => request.end(wire.subarray(1)), destroy: () => request.destroy() };
}
async function firstChunk(latch, action) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(latch) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(latch), 'real rebuild body iterator consumed one byte before EOF');
  assert.deepEqual(JSON.parse(fs.readFileSync(latch, 'utf8')), {
    phase: 'rebuild-first-body-chunk-consumed-before-request-end',
    route: REBUILD, bytes: 1, action,
  });
}
for (const action of ['observe', 'freeze']) {
  test(`held browser rebuild rechecks ${action === 'freeze' ? 'actual new import freeze' : 'actual session logout'} before queue effects`, async () => {
    const data = await fixture();
    let pending;
    try {
      const vector = first(data);
      const response = await postBatch(data, vector);
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, vector.receipt);
      await waitForStatus(data, json => json.sources[0]?.state === 'current');
      const before = coldReadSourceState(data.home);
      assertFirstNative(before.native, data);
      assertFirstIndex(before.index, data);
      const latch = path.join(data.home, 'source-index-midbody-latch.json');
      await restart(data, { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
        INDEPENDENT_PRODUCT_ROOT: product, INDEPENDENT_INDEX_MIDBODY_ACTION: action,
        INDEPENDENT_INDEX_MIDBODY_LATCH: latch });
      // Actual read-only status waits for boot; an identical current target
      // must not republish/reset its counters or timestamps on startup.
      await waitForStatus(data, json => json.sources[0]?.state === 'current');
      assert.deepEqual(coldReadSourceState(data.home), before);
      pending = heldRebuild(data);
      await firstChunk(latch, action);
      if (action === 'observe') {
        const loggedOut = await req(data.server.baseUrl, '/auth/logout', {
          method: 'POST', cookie: data.owner.cookie, headers: { Origin: ORIGIN }, body: {},
        });
        assert.equal(loggedOut.status, 200);
        assert.deepEqual(loggedOut.json, { ok: true });
      }
      pending.finish();
      const denied = await pending.response;
      if (action === 'freeze') {
        assert.equal(denied.status, 503);
        assert.equal(denied.json.code, 'IMPORT_FROZEN');
      } else assert.equal(denied.status, 401);
      noAuthority(denied.body, data);
      await data.server.kill(); data.server = null;
      assert.deepEqual(coldReadSourceState(data.home), before,
        'exact source/outbox/legacy plus all three derived tables have no refused rebuild effects');
    } finally {
      if (pending) pending.destroy();
      await close(data);
    }
  });
}
