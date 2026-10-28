// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { fixture, restart, close, post, failure, stage, finalise, committedNative, purgedWithReceipt,
  coldReadNative, coldReadObjects, makeObject, sha, noAuthority, BASE, FINAL, TYPE } =
  require('../helpers/health-connect-object-test-fixture.cjs');
function events(data) {
  const text = fs.readFileSync(data.observations, 'utf8');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function fault(data, mode) {
  data.observations = path.join(data.home, 'object-native-fault-observations.jsonl');
  const existing = path.join(__dirname, '../helpers/health-connect-ingest-fault-preload.cjs')
    .replaceAll('\\', '/');
  const compact = path.join(__dirname, '../helpers/health-connect-object-compact-fault-preload.cjs')
    .replaceAll('\\', '/');
  await restart(data, { NODE_OPTIONS: `--require "${existing}"` +
    (mode === 'compact-insert-refusal' ? ` --require "${compact}"` : ''),
  INDEPENDENT_INGEST_OBSERVATIONS: data.observations,
  INDEPENDENT_INGEST_FAULT: mode === 'compact-insert-refusal' ? 'observe' : mode });
}
function ownWriterFull(observed) {
  const writes = observed.filter(event => event.kind === 'native-writer');
  assert.ok(writes.length > 0);
  for (const write of writes) {
    assert.equal(write.journalMode, 'wal');
    assert.equal(write.synchronous, 2);
    assert.equal(write.transactionActive, true);
    const before = observed.findIndex(event => event.kind === 'transaction-begin' &&
      event.handleId === write.handleId && event.transactionId === write.transactionId);
    const begun = observed.findIndex(event => event.kind === 'transaction-begin-complete' &&
      event.handleId === write.handleId && event.transactionId === write.transactionId);
    assert.ok(before >= 0 && begun > before && begun < observed.indexOf(write));
    assert.equal(observed[before].journalMode, 'wal');
    assert.equal(observed[before].synchronous, 2);
    assert.equal(observed[before].transactionActive, false);
  }
}
function childExit(child) {
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bounded finalise child exit not observed')), 15000);
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  void promise.catch(() => {});
  return promise;
}
function lostResponse(data, object) {
  return new Promise((resolve, reject) => {
    let request;
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error('bounded finalise response loss not observed'));
    }, 15000);
    const finish = result => { clearTimeout(timeout); resolve(result); };
    request = http.request(`${data.server.baseUrl}${FINAL}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...data.headers },
    }, response => {
      let body = '';
      response.on('data', bytes => { body += bytes.toString('utf8'); });
      response.on('end', () => finish({ status: response.statusCode, body }));
      response.on('aborted', () => finish({ lost: true, code: 'RESPONSE_ABORTED' }));
      response.on('error', error => finish({ lost: true, code: error.code }));
    });
    request.on('error', error => finish({ lost: true, code: error.code }));
    request.end(JSON.stringify(object.finalise));
  });
}
for (const mode of ['sqlite-full', 'outbox-insert-full', 'compact-insert-refusal']) {
  test(`actual finalise ${mode} rolls back native/compact effects and preserves actual staged BLOBs`,
    async () => {
      const data = await fixture();
      try {
        // A distinct existing tombstone makes preservation observable without suppressing the upload.
        const template = makeObject(data.binding);
        const seedPayload = { binding: data.binding, recordType: TYPE, sequence: '1',
          batchId: 'a-preexisting-source-delete',
          changes: [{ operation: 'delete', identity: { ...template.header.identity,
            nativeRecordId: 'independent-retained-tombstone' } } ] };
        const payloadJson = JSON.stringify(seedPayload);
        const seedDigest = sha(Buffer.from(payloadJson, 'utf8'));
        const seedReceipt = { version: 1, kind: 'durable-receipt', binding: data.binding,
          recordType: TYPE, sequence: '1', batchId: seedPayload.batchId, payloadDigest: seedDigest };
        const seeded = await post(data, `${BASE}/v1/batches`, {
          version: 1, kind: 'batch', payloadJson, payloadDigest: seedDigest });
        assert.equal(seeded.status, 200);
        assert.deepEqual(seeded.json, seedReceipt);
        const object = makeObject(data.binding, { sequence: '2', batchId: 'synthetic-large-2' });
        await stage(data, object);
        const nativeBefore = coldReadNative(data.home);
        const objectsBefore = coldReadObjects(data.home);
        assert.deepEqual(nativeBefore.records, []);
        assert.deepEqual(nativeBefore.tombstoneIds, ['independent-retained-tombstone']);
        assert.deepEqual(nativeBefore.receipts, [seedReceipt]);
        assert.equal(nativeBefore.frontiers[0].acknowledgedSequence, '1');
        assert.equal(objectsBefore.physicalPartCount, 3);
        await fault(data, mode);
        failure(await post(data, FINAL, object.finalise), 503, 'storage-unavailable', data);
        const observed = events(data);
        ownWriterFull(observed);
        if (mode === 'sqlite-full') {
          assert.deepEqual(observed.find(event => event.kind === 'native-write-error'),
            { kind: 'native-write-error', sqliteResult: 13 });
          assert.equal(observed.filter(event => event.kind === 'fault-fired').length, 1);
        } else if (mode === 'outbox-insert-full') {
          const fired = observed.filter(event => event.kind === 'fault-fired');
          assert.equal(fired.length, 1);
          assert.ok(fired[0].rawWrites > 0 && fired[0].receiptWritten);
        } else {
          const fired = observed.filter(event => event.kind === 'object-compact-fault-fired');
          assert.equal(fired.length, 1);
          assert.ok(fired[0].rawWrites > 0 && fired[0].receiptWritten);
        }
        assert.deepEqual(coldReadNative(data.home), nativeBefore,
          'rollback preserves the independent source tombstone and all ordinary effects');
        assert.deepEqual(coldReadObjects(data.home), objectsBefore,
          'rollback preserves exact staged bytes/reservation and no compact ACK metadata');
        await restart(data, {});
        await finalise(data, object);
        const saved = coldReadNative(data.home);
        assert.deepEqual(saved.records, [{ identity: object.header.identity,
          record: object.payload.changes[0].record }]);
        assert.deepEqual(saved.tombstoneIds, ['independent-retained-tombstone']);
        assert.deepEqual(saved.receipts, [seedReceipt, object.receipt]);
        assert.deepEqual(saved.frontiers, [{ recordType: TYPE, acknowledgedSequence: '2' }]);
        assert.deepEqual(saved.jobs, [
          { batchId: seedPayload.batchId, state: 'queued' },
          { batchId: object.header.batchId, state: 'queued' },
        ]);
        assert.deepEqual(saved.legacyCards, data.before.legacyCards);
        assert.deepEqual(saved.legacyRows, data.before.legacyRows);
        purgedWithReceipt(data, object);
      } finally { await close(data); }
    });
}
for (const mode of ['before-commit-kill', 'after-commit-kill']) {
  test(`actual finalise ${mode} proves exact cold atomic staging and original retry receipt`,
    async () => {
      const data = await fixture();
      try {
        const object = makeObject(data.binding);
        await stage(data, object);
        const beforeNative = coldReadNative(data.home);
        const beforeObjects = coldReadObjects(data.home);
        assert.equal(beforeObjects.physicalPartCount, 3);
        await fault(data, mode);
        const exited = childExit(data.server.proc);
        const response = await lostResponse(data, object);
        assert.equal(response.lost, true, 'no usable receipt arrived at the observed death boundary');
        assert.ok(['ECONNRESET', 'RESPONSE_ABORTED'].includes(response.code));
        const exit = await exited;
        assert.deepEqual(exit, process.platform === 'win32' ?
          { code: 1, signal: null } : { code: null, signal: 'SIGKILL' });
        data.server = null;
        const observed = events(data);
        ownWriterFull(observed);
        const fired = observed.filter(event => event.kind === 'fault-fired');
        assert.equal(fired.length, 1);
        assert.equal(fired[0].phase, mode === 'before-commit-kill' ?
          'immediately-before-native-commit' : 'immediately-after-native-commit');
        if (mode === 'before-commit-kill') {
          assert.deepEqual(coldReadNative(data.home), beforeNative);
          assert.deepEqual(coldReadObjects(data.home), beforeObjects);
        } else {
          // This cold proof precedes any startup cleanup or finalise retry.
          committedNative(data, object);
          purgedWithReceipt(data, object);
        }
        await restart(data, {});
        await finalise(data, object);
        const saved = committedNative(data, object);
        const compact = purgedWithReceipt(data, object);
        await finalise(data, object);
        assert.deepEqual(coldReadNative(data.home), saved);
        assert.deepEqual(coldReadObjects(data.home), compact);
      } finally { await close(data); }
    });
}
test('actual busy finalise cannot ACK or alter staged/history state and original batch resumes after unlocking',
  async () => {
    const data = await fixture();
    let writer;
    try {
      const object = makeObject(data.binding);
      await stage(data, object);
      const beforeNative = coldReadNative(data.home);
      const beforeObjects = coldReadObjects(data.home);
      writer = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
      writer.exec('BEGIN IMMEDIATE');
      failure(await post(data, FINAL, object.finalise), 503, 'storage-unavailable', data);
      assert.deepEqual(coldReadNative(data.home), beforeNative);
      assert.deepEqual(coldReadObjects(data.home), beforeObjects);
      writer.exec('ROLLBACK'); writer.close(); writer = null;
      await finalise(data, object);
      committedNative(data, object);
      purgedWithReceipt(data, object);
    } finally { if (writer) writer.close(); await close(data); }
  });
test('actual corrupted saved BLOB is observed independently and finalise refuses without overwriting corruption or native history',
  async () => {
    const data = await fixture();
    let writer;
    try {
      const object = makeObject(data.binding);
      await stage(data, object);
      writer = new DatabaseSync(path.join(data.home, 'db', 'klebb.db'));
      const stored = writer.prepare('SELECT stream_key, part_bytes FROM health_object_parts WHERE part_index=0')
        .get();
      const changed = Buffer.from(stored.part_bytes);
      changed[changed.length - 1] ^= 1;
      writer.prepare('UPDATE health_object_parts SET part_bytes=? WHERE stream_key=? AND part_index=0')
        .run(changed, stored.stream_key);
      writer.close(); writer = null;
      const corrupted = coldReadObjects(data.home);
      assert.equal(corrupted.partDigestEvidence[0].matches, false);
      assert.notEqual(corrupted.objects[0].parts[0].digest, object.manifest[0].digest);
      const nativeBefore = coldReadNative(data.home);
      failure(await post(data, FINAL, object.finalise), 503, 'storage-unavailable', data);
      assert.deepEqual(coldReadObjects(data.home), corrupted);
      assert.deepEqual(coldReadNative(data.home), nativeBefore);
      noAuthority(corrupted.compactText, data);
    } finally { if (writer) writer.close(); await close(data); }
  });
