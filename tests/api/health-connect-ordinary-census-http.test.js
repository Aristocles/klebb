// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, close, first, postBatch, TYPE, BASE, req, noAuthority,
  coldReadSourceNative } = require('../helpers/health-connect-source-index-test-fixture.cjs');

function coverage(binding, status) {
  const window = { start: '2026-10-28T03:45:00Z', end: '2026-10-28T03:46:00Z' };
  const queryJson = JSON.stringify({ recordType: TYPE, window,
    dataOrigins: ['example.synthetic.producer.one', 'example.synthetic.producer.two'],
    historyStart: '2026-10-01T00:00:00Z',
    features: { history: true, backgroundRead: false } });
  const filterDigest = 'sha256:' + crypto.createHash('sha256').update(queryJson).digest('hex');
  const fingerprint = 'sha256:' + '1'.repeat(64);
  return JSON.stringify({ version: 1, kind: 'coverage', binding, recordType: TYPE,
    window, filterDigest, rawFrontier: '1', status, pagesFinished: true,
    permissionsStable: true, tokenValid: true, permissionFingerprintStart: fingerprint,
    permissionFingerprintEnd: fingerprint, historyIncludesScope: true,
    changesBarrierDrained: true, queryJson });
}

test('authenticated HTTP census keeps membership provisional and preserves native history',
  { timeout: 20000 }, async () => {
    const data = await fixture();
    try {
      const initial = first(data);
      const admitted = await postBatch(data, initial);
      assert.equal(admitted.status, 200, 'healthy existing ingestion precedes census assertions');
      assert.deepEqual(admitted.json, initial.receipt);
      const before = coldReadSourceNative(data.home);
      const authorityFile = path.join(data.home, 'credentials', 'health-connect.json');
      const beforeAuthority = fs.readFileSync(authorityFile);
      const startBody = { coverageJson: coverage(data.binding, 'partial') };
      const anonymous = await req(data.server.baseUrl, `${BASE}/v1/censuses/begin`,
        { method: 'POST', body: startBody });
      assert.equal(anonymous.status, 401);
      const stale = await req(data.server.baseUrl, `${BASE}/v1/censuses/begin`,
        { method: 'POST', body: startBody,
          headers: { ...data.headers, 'Klebb-Health-Generation': '0' } });
      assert.equal(stale.status, 409);
      const begun = await req(data.server.baseUrl, `${BASE}/v1/censuses/begin`,
        { method: 'POST', headers: data.headers, body: startBody });
      assert.equal(begun.status, 200);
      assert.equal(begun.json.phase, 'begun');
      assert.match(begun.json.handle, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(begun.json.nativeCompleteness, 'unverified');
      assert.equal(begun.json.deletionEligible, false);
      const sealBody = { coverageJson: coverage(data.binding, 'complete'),
        handle: begun.json.handle, seenNativeRecordIds: ['raw-a'], tokenReset: false };
      const sealed = await req(data.server.baseUrl, `${BASE}/v1/censuses/seal`,
        { method: 'POST', headers: data.headers, body: sealBody });
      assert.equal(sealed.status, 200);
      const key = id => JSON.stringify([data.binding.tenantId, data.binding.sourceStoreId, TYPE, id]);
      assert.deepEqual(sealed.json, { phase: 'complete', seenNativeKeys: [key('raw-a')],
        unseenNativeKeys: [key('raw-b')], unresolvedNativeKeys: [],
        nativeCompleteness: 'unverified', deletionEligible: false });
      const replay = await req(data.server.baseUrl, `${BASE}/v1/censuses/seal`,
        { method: 'POST', headers: data.headers, body: sealBody });
      assert.equal(replay.status, 409, 'custody handles are consumed once');
      for (const response of [anonymous, stale, begun, sealed, replay]) noAuthority(response.body, data);
      assert.deepEqual(coldReadSourceNative(data.home), before,
        'census does not mutate native records, tombstones, receipts, frontiers or jobs');
      assert.deepEqual(fs.readFileSync(authorityFile), beforeAuthority);
    } finally { await close(data); }
  });

test('authenticated HTTP census refuses non-object coverage as malformed protocol',
  { timeout: 20000 }, async () => {
    const data = await fixture();
    try {
      const initial = first(data);
      const admitted = await postBatch(data, initial);
      assert.equal(admitted.status, 200, 'healthy existing ingestion precedes malformed input assertions');
      assert.deepEqual(admitted.json, initial.receipt);
      const before = coldReadSourceNative(data.home);
      const authorityFile = path.join(data.home, 'credentials', 'health-connect.json');
      const beforeAuthority = fs.readFileSync(authorityFile);
      for (const coverageJson of ['null', '[]', '"synthetic"', '7', 'true']) {
        const response = await req(data.server.baseUrl, `${BASE}/v1/censuses/begin`,
          { method: 'POST', headers: data.headers, body: { coverageJson } });
        assert.equal(response.status, 400, 'non-object coverage is malformed protocol');
        assert.equal(response.json.kind, 'error');
        assert.equal(response.json.code, 'invalid-message');
        assert.equal(response.json.retryable, false);
        noAuthority(response.body, data);
        assert.deepEqual(coldReadSourceNative(data.home), before);
        assert.deepEqual(fs.readFileSync(authorityFile), beforeAuthority);
      }
    } finally { await close(data); }
  });
