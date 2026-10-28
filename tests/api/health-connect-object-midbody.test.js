// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Real held HTTP bodies cross current revocation/import fences before effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const product = process.env.INDEPENDENT_PRODUCT_ROOT || path.resolve(__dirname, '../..');
const { fixture, restart, close, stage, makeObject, req, noAuthority,
  coldReadNative, coldReadObjects, BASE, PART, FINAL, ENV } =
  require(path.join(product, 'tests/helpers/health-connect-object-test-fixture.cjs'));

function heldUpload(data, route, wire) {
  let request;
  const split = Math.floor(wire.length / 2);
  assert.ok(split > 0 && split < wire.length);
  const response = new Promise((resolve, reject) => {
    request = http.request(`${data.server.baseUrl}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'Content-Length': wire.length, ...data.headers },
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
    request.setTimeout(15000, () => request.destroy(new Error('bounded held object timeout')));
    request.write(wire.subarray(0, split));
  });
  void response.catch(() => {});
  return { response, finish: () => request.end(wire.subarray(split)),
    destroy: () => request.destroy() };
}
async function consumed(latch, route, action, totalBytes) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(latch) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(latch), 'the actual object body iterator consumed a partial request');
  const event = JSON.parse(fs.readFileSync(latch, 'utf8'));
  assert.equal(event.phase, 'object-iterator-consumed-first-chunk-before-request-end');
  assert.equal(event.route, route);
  assert.equal(event.action, action);
  assert.ok(event.bytes > 0 && event.bytes < totalBytes);
}

for (const route of [PART, FINAL]) {
  for (const action of ['observe', 'freeze']) {
    test(`held ${route === PART ? 'part' : 'finalise'} refuses ${action === 'freeze' ?
      'new import freeze' : 'new browser revocation'} without native or staging changes`,
    async () => {
      const data = await fixture();
      let pending;
      try {
        const object = makeObject(data.binding);
        await stage(data, object, route === PART ? [0] : [0, 1, 2]);
        assert.ok(data.before.legacyCards.length > 0);
        assert.ok(data.before.legacyRows.length > 0);
        const nativeBefore = coldReadNative(data.home);
        const objectsBefore = coldReadObjects(data.home);
        assert.equal(objectsBefore.objects.length, 1);
        assert.equal(objectsBefore.physicalPartCount, route === PART ? 1 : 3);
        assert.equal(objectsBefore.aggregateReservedBytes, 1049872);
        assert.deepEqual(nativeBefore.records, []);
        assert.deepEqual(nativeBefore.receipts, []);
        const latch = path.join(data.home, 'object-midbody-latch.json');
        const preload = path.join(product, 'tests/helpers/health-connect-object-midbody-preload.cjs')
          .replaceAll('\\', '/');
        await restart(data, {
          NODE_OPTIONS: `--require "${preload}"`, INDEPENDENT_PRODUCT_ROOT: product,
          INDEPENDENT_OBJECT_MIDBODY_LATCH: latch,
          INDEPENDENT_OBJECT_MIDBODY_ACTION: action,
          INDEPENDENT_OBJECT_MIDBODY_ROUTE: route,
        });
        assert.deepEqual(coldReadNative(data.home), nativeBefore);
        assert.deepEqual(coldReadObjects(data.home), objectsBefore);
        const wire = Buffer.from(JSON.stringify(route === PART ?
          object.partFrames[1] : object.finalise), 'utf8');
        pending = heldUpload(data, route, wire);
        await consumed(latch, route, action, wire.length);
        if (action === 'observe') {
          const revoked = await req(data.server.baseUrl, `${BASE}/${data.paired.connectorId}`, {
            method: 'DELETE', cookie: data.owner.cookie, headers: { Origin: ENV.HEALTH_ORIGIN },
          });
          assert.equal(revoked.status, 200);
          assert.deepEqual(revoked.json, { revoked: true });
        }
        pending.finish();
        const response = await pending.response;
        if (action === 'observe') {
          assert.equal(response.status, 401);
          assert.equal(response.json.kind, 'error');
          assert.equal(response.json.code, 'revoked');
        } else {
          assert.equal(response.status, 503);
          assert.equal(response.json.code, 'IMPORT_FROZEN');
        }
        assert.notEqual(response.json.kind, 'durable-receipt');
        assert.notEqual(response.json.kind, 'object-part-receipt');
        noAuthority(response.body, data);
        await data.server.kill();
        data.server = null;
        const nativeAfter = coldReadNative(data.home);
        const objectsAfter = coldReadObjects(data.home);
        assert.deepEqual(nativeAfter, nativeBefore,
          'no complete raw record, tombstone, receipt, frontier, job or legacy effect');
        assert.deepEqual(objectsAfter, objectsBefore,
          'no physical part, metadata, reservation, compact receipt or expiry effect');
        noAuthority(nativeAfter.logicalNativeDump, data);
        noAuthority(objectsAfter.compactText, data);
      } finally {
        if (pending) pending.destroy();
        await close(data);
      }
    });
  }
}
