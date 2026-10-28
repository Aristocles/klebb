// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeMessage, decodeJson, HARD_LIMITS } = require('../lib/health-connect/protocol');
const authorityFixtures = require('./fixtures/health-connect/authority-v1.json');
const paired = {
  version: 1, kind: 'paired', destination: 'https://test.klebb.app',
  tenantId: 'tenant-a', instanceId: 'instance-a', connectorId: 'connector-a',
  sourceStoreId: 'source-a', installationId: 'install-a', restoreEpoch: 'epoch-a',
  categories: ['StepsRecord'], streams: {
    StepsRecord: { generation: '1', acknowledgedSequence: '0' },
  }, credential: 'klebb_hc1_' + 'A'.repeat(43),
};
const decode = value => decodeMessage(JSON.stringify(value));
test('authority response keeps approved binding, credential and exact stream strings', () => {
  const value = decode(paired);
  assert.equal(value.credential, paired.credential);
  assert.equal(value.streams.StepsRecord.generation, '1');
  assert.ok(Object.isFrozen(value.streams.StepsRecord));
  const status = { version: 1, kind: 'stream-status', recordType: 'StepsRecord',
    binding: { tenantId: 'tenant-a', instanceId: 'instance-a', sourceStoreId: 'source-a',
      installationId: 'install-a', generation: '1', restoreEpoch: 'epoch-a' },
    generation: '1', acknowledgedSequence: '0' };
  assert.equal(decode(status).acknowledgedSequence, '0');
  const list = { version: 1, kind: 'connector-list', destination: paired.destination,
    connectors: [{ id: 'connector-a', name: 'Test phone', categories: ['StepsRecord'],
      createdAt: '2026-10-28T00:00:00Z', revokedAt: null }] };
  assert.equal(decode(list).connectors[0].name, 'Test phone');
});
test('authority response refuses scope/stream inconsistency, extra secrets and unsafe origins', () => {
  for (const patch of [
    { streams: {} },
    { streams: { ...paired.streams, WeightRecord: { generation: '1', acknowledgedSequence: '0' } } },
    { credential: 'broader-admin-secret' },
    { destination: 'http://test.klebb.app' },
    { destination: 'https://user@test.klebb.app' },
    { adminToken: 'unexpected-secret' },
  ]) assert.throws(() => decode({ ...paired, ...patch }));
  assert.throws(() => decode({ ...paired, streams: {
    StepsRecord: { generation: 1, acknowledgedSequence: '0' },
  } }));
});
test('bounded generic JSON preserves strict duplicate/UTF-8 rules for management and store', () => {
  assert.equal(decodeJson(Buffer.from('{"name":"Test phone"}')).name, 'Test phone');
  for (const text of ['{"name":"a","\\u006eame":"b"}', '{"x":1.2}', '{"x":"\\ud800"}']) {
    assert.throws(() => decodeJson(text));
  }
  assert.throws(() => decodeJson(Buffer.from([0xc3, 0x28])));
  assert.throws(() => decodeJson(' '.repeat(HARD_LIMITS.maxBytes + 1)));
});
test('the shared authority response corpus has independently fixed acceptance and refusals', () => {
  const context = { binding: authorityFixtures.binding, categories: authorityFixtures.categories };
  for (const fixture of authorityFixtures.cases) {
    assert.equal(Buffer.byteLength(fixture.wire, 'utf8'), fixture.expectedBytes, fixture.id);
    assert.equal(decodeMessage(Buffer.from(fixture.wire), context).kind, fixture.expectedKind, fixture.id);
  }
  for (const fixture of authorityFixtures.rejectedCases) {
    assert.throws(() => decodeMessage(Buffer.from(fixture.wire), context),
      error => error.code === fixture.expectedCode, fixture.id);
  }
});
