// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { decodeMessage, payloadDigest, nativeKey } = require('../lib/health-connect/protocol');
const fixtures = require('./fixtures/health-connect/protocol-v1.json');
const adversarial = require('./fixtures/health-connect/adversarial-v1.json');
const context = { binding: fixtures.binding, categories: fixtures.categories,
  rawFrontiers: fixtures.rawFrontiers, serializers: fixtures.serializers };
const message = id => JSON.parse(fixtures.cases.find(c => c.id === id).wire);
const encode = value => Buffer.from(JSON.stringify(value));
const hash = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
function changePayload(edit, id = 'batch') {
  const value = message(id);
  const payload = JSON.parse(value.payloadJson);
  edit(payload);
  value.payloadJson = JSON.stringify(payload);
  value.payloadDigest = hash(value.payloadJson);
  return encode(value);
}
function refuses(input, code, options = context) {
  assert.throws(() => decodeMessage(input, options), error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('complete independently specified wire examples validate without precision loss', () => {
  for (const fixture of fixtures.cases) {
    assert.equal(Buffer.byteLength(fixture.wire), fixture.expectedBytes, fixture.id);
    const parsed = decodeMessage(Buffer.from(fixture.wire), context);
    assert.equal(parsed.kind, fixture.expectedKind, fixture.id);
  }
  const batch = decodeMessage(encode(message('batch')), context);
  assert.equal(batch.payloadJson, message('batch').payloadJson);
  const payload = JSON.parse(batch.payloadJson);
  assert.equal(payload.sequence, '9007199254740993');
  assert.equal(payload.changes[0].record.metadata.clientRecordVersion, '9007199254740993');
  assert.equal(payload.changes[0].record.startTime, '2026-10-28T03:40:31.344000001Z');
});

test('digest uses original UTF-8 bytes, including spacing, key order and decimal spelling', () => {
  for (const vector of fixtures.digestVectors) {
    assert.equal(Buffer.byteLength(vector.text), vector.bytes);
    assert.equal(payloadDigest(vector.text), vector.digest);
  }
  assert.notEqual(payloadDigest('{"a":1,"b":2}'), payloadDigest('{"b":2,"a":1}'));
  assert.notEqual(payloadDigest('{"a":1}'), payloadDigest('{ "a":1}'));
  assert.notEqual(payloadDigest('{"x":null}'), payloadDigest('{}'));
  assert.notEqual(payloadDigest('{"x":"1.0"}'), payloadDigest('{"x":"1.00"}'));
});

test('native identity has four unambiguous components and excludes transport state', () => {
  const identity = { tenantId: 'a|b', sourceStoreId: 'c', recordType: 'StepsRecord',
    nativeRecordId: 'd' };
  assert.equal(nativeKey(identity), '["a|b","c","StepsRecord","d"]');
  assert.notEqual(nativeKey(identity), nativeKey({ ...identity, tenantId: 'a', sourceStoreId: 'b|c' }));
  for (const field of ['tenantId', 'sourceStoreId', 'recordType', 'nativeRecordId']) {
    assert.notEqual(nativeKey(identity), nativeKey({ ...identity, [field]: 'OtherRecord' }));
  }
  assert.equal(nativeKey(identity), nativeKey({ ...identity, installationId: 'new', digest: 'new',
    generation: '8', restoreEpoch: 'new' }));
});

test('incompatible versions, unknown envelope fields and unknown operations are refused', () => {
  refuses(encode({ ...message('error'), version: 2 }), 'unsupported-version');
  refuses(encode({ ...message('error'), cursor: 'synthetic-do-not-echo' }), 'invalid-message');
  refuses(changePayload(p => { p.changes[0].operation = 'replace'; }), 'invalid-message');
  refuses(changePayload(p => { delete p.changes[1].identity.nativeRecordId; }), 'invalid-message');
});

test('native identity, scope, source store, installation, generation and epoch stay bound', () => {
  for (const field of Object.keys(fixtures.binding)) {
    refuses(changePayload(p => { p.binding[field] = field === 'generation' ? '8' : 'other'; }),
      'binding-mismatch');
  }
  for (const field of ['tenantId', 'sourceStoreId', 'recordType']) {
    refuses(changePayload(p => { p.changes[0].identity[field] = 'OtherRecord'; }), 'binding-mismatch');
  }
  refuses(encode(message('rawOnly')), 'scope-denied', { ...context, categories: ['StepsRecord'] });
  refuses(changePayload(p => { p.recordType = 'WeightRecord'; p.changes.forEach(c => {
    c.identity.recordType = 'WeightRecord';
  }); }), 'scope-denied');
});

test('changed exact immutable bytes conflict with the supplied digest', () => {
  const value = message('batch');
  value.payloadJson += ' ';
  refuses(encode(value), 'digest-mismatch');
});

test('count and exact received UTF-8 bytes enforce inclusive negotiated boundaries', () => {
  const fixture = fixtures.cases.find(c => c.id === 'batch');
  decodeMessage(Buffer.from(fixture.wire), { ...context,
    limits: { maxBytes: fixture.expectedBytes, maxChanges: 2 } });
  refuses(Buffer.from(fixture.wire), 'limit-exceeded', { ...context,
    limits: { maxBytes: fixture.expectedBytes - 1 } });
  refuses(Buffer.from(fixture.wire), 'limit-exceeded', { ...context, limits: { maxChanges: 1 } });
  refuses(Buffer.from(fixture.wire + ' '), 'limit-exceeded', { ...context,
    limits: { maxBytes: fixture.expectedBytes } });
});

test('depth, node and nested sample budgets are separate enforced limits', () => {
  refuses(encode(message('batch')), 'limit-exceeded', { ...context, limits: { maxDepth: 2 } });
  refuses(encode(message('batch')), 'limit-exceeded', { ...context, limits: { maxNodes: 10 } });
  refuses(changePayload(p => { p.changes[0].record.samples = [
    { time: '2026-10-28T03:40:32Z', beatsPerMinute: '60' },
    { time: '2026-10-28T03:40:33Z', beatsPerMinute: '61' }
  ]; }), 'limit-exceeded', { ...context, limits: { maxSamples: 1 } });
});

test('reject malformed UTF-8, duplicate keys, scalar corruption and numeric rounding', () => {
  refuses(Buffer.from([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x31, 0x7d]), 'invalid-message');
  refuses('{"version":1,"version":1,"kind":"error","code":"invalid-message","retryable":false}',
    'invalid-message');
  refuses('{"version":1,"kind":"error","code":"invalid-message","retryable":false,"\\ud800":1}',
    'invalid-message');
  refuses('{"version":1,"kind":"error","code":"invalid-message","retryable":1.00000000000000001}',
    'invalid-message');
  refuses(changePayload(p => {
    p.changes[0].record.metadata.clientRecordVersion = 9007199254740993;
  }), 'invalid-message');
  refuses(changePayload(p => {
    p.changes[0].record.metadata.clientRecordVersion = '9223372036854775808';
  }), 'invalid-message');
  const value = message('batch');
  value.payloadJson = value.payloadJson.replace('"sequence":', '"sequence":"1","sequence":');
  value.payloadDigest = hash(value.payloadJson);
  refuses(encode(value), 'invalid-message');
});

test('coverage requires complete pagination, stable permission and exact scope frontier', () => {
  for (const field of ['pagesFinished', 'permissionsStable', 'tokenValid',
    'historyIncludesScope', 'changesBarrierDrained']) {
    refuses(encode({ ...message('coverage'), [field]: false }), 'incomplete-coverage');
    decodeMessage(encode({ ...message('coverage'), status: 'partial', [field]: false }), context);
  }
  refuses(encode({ ...message('coverage'), permissionFingerprintEnd: hash('different') }),
    'incomplete-coverage');
  refuses(encode(message('coverage')), 'frontier-lag', { ...context,
    rawFrontiers: { StepsRecord: '9' } });
  refuses(encode(message('coverage')), 'frontier-lag', { binding: fixtures.binding,
    categories: fixtures.categories });
  refuses(encode(message('aggregate')), 'frontier-lag', { ...context,
    rawFrontiers: { StepsRecord: '9' } });
  decodeMessage(encode({ ...message('aggregate'), status: 'lagging' }), { ...context,
    rawFrontiers: { StepsRecord: '9' } });
});

test('calendar validation and interval comparisons retain nanosecond boundaries', () => {
  for (const end of ['2026-10-28T03:45:19.999999998Z', '2026-10-28T03:45:19.999999999Z',
    '2026-02-29T00:00:00Z']) {
    const value = message('coverage');
    value.window.end = end;
    refuses(encode(value), 'invalid-message');
  }
  refuses(changePayload(p => { p.changes[0].record.startTime = '2026-02-29T00:00:00Z'; }),
    'invalid-message');
});

test('pairing contract requires HTTPS destination without userinfo or path', () => {
  for (const destination of ['http://health.example.test', 'https://u@health.example.test',
    'https://health.example.test/path', 'https://health.example.test?grant=secret']) {
    refuses(encode({ ...message('grant'), destination }), 'invalid-destination');
  }
});

test('chunk contracts bind native identity, limits and exact part bytes without durable ACK', () => {
  refuses(encode({ ...message('part'), partIndex: 1 }), 'invalid-message');
  refuses(encode({ ...message('part'), partDigest: hash('wrong') }), 'digest-mismatch');
  refuses(encode({ ...message('part'), partBase64: 'YR==' }), 'invalid-message');
  refuses(encode({ ...message('finalise'), partCount: 2 }), 'limit-exceeded', { ...context,
    limits: { maxParts: 1 } });
  refuses(encode({ ...message('finalise'), totalBytes: 4 }), 'limit-exceeded', { ...context,
    limits: { maxObjectBytes: 3 } });
  refuses(encode({ ...message('finalise'), acknowledged: true }), 'invalid-message');
});

test('typed errors contain fixed codes and no copied payload, secret or arbitrary detail', () => {
  refuses(encode({ ...message('error'), detail: 'synthetic-secret' }), 'invalid-message');
  refuses(encode({ ...message('error'), code: 'arbitrary-secret' }), 'invalid-message');
});

test('raw-only does not relax negotiated serializer identity or data-family validation', () => {
  refuses(changePayload(p => { p.changes[0].serializerId = 'unknown'; }, 'rawOnly'),
    'invalid-message');
  refuses(changePayload(p => { p.changes[0].serializerVersion = 2; }), 'invalid-message');
  refuses(changePayload(p => { p.changes[0].dataFamily = 'medical'; }), 'invalid-message');
});

test('empty and missing aggregate observations never invent a numeric zero', () => {
  const value = message('aggregate');
  value.observation = { state: 'empty', quantity: null, unit: 'count' };
  decodeMessage(encode(value), context);
  refuses(encode({ ...value, observation: { state: 'empty', quantity: '0', unit: 'count' } }),
    'invalid-message');
  value.observation = { state: 'missing', quantity: null, unit: 'count' };
  refuses(encode(value), 'invalid-message');
  decodeMessage(encode({ ...value, status: 'blocked' }), context);
});

test('finalisation has an ordered dense manifest with exact part-byte sum', () => {
  const value = message('finalise');
  refuses(encode({ ...value, parts: [{ ...value.parts[0], index: 1 }] }), 'invalid-message');
  refuses(encode({ ...value, parts: [{ ...value.parts[0], bytes: 2 }] }), 'invalid-message');
  refuses(encode({ ...value, parts: [] }), 'invalid-message');
});

for (const vector of adversarial.cases) {
  test(`independent ${vector.id}: ${vector.purpose}`, () => {
    const input = vector.wireHex ? Buffer.from(vector.wireHex, 'hex') : Buffer.from(vector.wire);
    assert.equal(input.length, vector.expectedUtf8Bytes);
    if (vector.expected.accepted) decodeMessage(input, vector.context);
    else refuses(input, vector.expected.code, vector.context);
  });
}

test('validated transport objects are immutable and hostile property names never become detail', () => {
  const parsed = decodeMessage(encode(message('coverage')), context);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.binding));
  assert.throws(() => { parsed.binding.generation = '8'; }, TypeError);
  for (const kind of ['toString', '__proto__', {}, null]) {
    refuses(encode({ ...message('error'), kind }), 'invalid-message');
  }
  refuses('{"version":1,"kind":"error","code":"invalid-message","retryable":false,"__proto__":{}}',
    'invalid-message');
});

test('Unicode identifiers use code-point limits and large opaque strings preserve all bytes', () => {
  const nativeRecordId = '\u{1f642}'.repeat(256);
  const large = '\u03a9'.repeat(12000);
  const input = changePayload(p => {
    p.changes[0].identity.nativeRecordId = nativeRecordId;
    p.changes[0].record.metadata.id = nativeRecordId;
    p.changes[0].record.opaqueText = large;
    p.changes[0].record['k'.repeat(300)] = 'opaque';
  }, 'rawOnly');
  const result = decodeMessage(input, context);
  const record = JSON.parse(result.payloadJson).changes[0].record;
  assert.equal(record.opaqueText, large);
  assert.equal(record.metadata.id, nativeRecordId);
  refuses(changePayload(p => {
    p.changes[0].identity.nativeRecordId = nativeRecordId + '\u{1f642}';
    p.changes[0].record.metadata.id = p.changes[0].identity.nativeRecordId;
  }, 'rawOnly'), 'invalid-message');
});

test('top-level authority bindings are checked whenever trusted context is supplied', () => {
  for (const [id, fields] of [['capabilities', ['tenantId', 'instanceId', 'restoreEpoch']],
    ['grant', ['tenantId', 'instanceId']],
    ['exchange', ['tenantId', 'instanceId', 'installationId', 'sourceStoreId']]]) {
    for (const field of fields) {
      refuses(encode({ ...message(id), [field]: 'other' }), 'binding-mismatch');
    }
  }
});

test('future explicitly negotiated route and medical envelopes preserve their own record shape', () => {
  for (const [recordType, dataFamily, record] of [
    ['ExerciseRoute', 'route', { locations: [{ time: '2026-10-28T03:45:20Z',
      latitude: '-33.860000000000001', longitude: '151.200000000000001' }] }],
    ['MedicalResource', 'medical', { resourceJson:
      '{"resourceType":"Observation","valueQuantity":{"value":75.250000000000001}}' }]
  ]) {
    const serializerId = `future-${dataFamily}-fixture`;
    const input = changePayload(p => {
      p.recordType = recordType;
      p.changes = [{ ...p.changes[0], identity: { ...p.changes[0].identity, recordType },
        dataFamily, projection: 'raw-only', serializerId, record }];
    });
    const parsed = decodeMessage(input, { ...context, categories: [recordType],
      serializers: [{ id: serializerId, version: 1, dataFamily }] });
    assert.deepEqual(JSON.parse(parsed.payloadJson).changes[0].record, record);
    refuses(input, 'invalid-message', { ...context, categories: [recordType] });
  }
});

test('aggregate observed numeric zero remains distinct from a complete empty result', () => {
  const value = message('aggregate');
  value.observation = { state: 'value', quantity: '0', unit: 'count' };
  assert.equal(decodeMessage(encode(value), context).observation.quantity, '0');
  value.observation = { state: 'empty', quantity: null, unit: 'count' };
  assert.equal(decodeMessage(encode(value), context).observation.quantity, null);
});

test('coverage and aggregate preserve exact query predicates and reject mismatched query digests', () => {
  for (const id of ['coverage', 'aggregate']) {
    const value = message(id);
    assert.equal(typeof value.queryJson, 'string');
    assert.equal(hash(value.queryJson), value.filterDigest);
    const parsed = decodeMessage(encode(value), context);
    assert.equal(parsed.queryJson, value.queryJson);
    refuses(encode({ ...value, queryJson: value.queryJson + ' ' }), 'digest-mismatch');
    const query = JSON.parse(value.queryJson);
    query.recordType = 'WeightRecord';
    value.queryJson = JSON.stringify(query);
    value.filterDigest = hash(value.queryJson);
    refuses(encode(value), 'binding-mismatch');
  }
});

test('a declared readable history boundary cannot support completeness outside that boundary', () => {
  const value = message('coverage');
  const query = JSON.parse(value.queryJson);
  query.historyStart = '2026-10-28T03:45:20Z';
  value.queryJson = JSON.stringify(query);
  value.filterDigest = hash(value.queryJson);
  refuses(encode(value), 'incomplete-coverage');
  decodeMessage(encode({ ...value, status: 'partial' }), context);
});

test('unlimited history is explicit null and import-date policy stays a separate instant', () => {
  const value = message('coverage');
  const query = JSON.parse(value.queryJson);
  query.historyStart = null;
  query.importStart = '2026-10-28T03:45:19.999999999Z';
  value.queryJson = JSON.stringify(query);
  value.filterDigest = hash(value.queryJson);
  const parsed = decodeMessage(encode(value), context);
  assert.equal(JSON.parse(parsed.queryJson).historyStart, null);
  query.importStart = '2026-02-29T00:00:00Z';
  value.queryJson = JSON.stringify(query);
  value.filterDigest = hash(value.queryJson);
  refuses(encode(value), 'invalid-message');
});
