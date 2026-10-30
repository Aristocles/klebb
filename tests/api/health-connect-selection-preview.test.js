// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../helpers/health-connect-selection-preview-fixture.cjs');
const { O, F, I, E } = H;
const options = { timeout: 180000 };
const shared = [[F.TYPE, F.ID]];
const allAlpha = [[F.TYPE, F.ID], [F.TYPES[1], F.ID]];
const oneNs = E.bank.cases.find(item => item.id === 'S04').period;
const group = (source, ids, footprints = {}) => ({ source, ids, footprints });
const all = data => [group(data.alpha, allAlpha), group(data.beta, shared)];
async function owned(action, fixtureOptions) {
  const data = await H.fixture(fixtureOptions);
  try { return await action(data); } finally { await H.close(data); }
}
const footprint = name => ({ [`${E.inputs.variants[name].recordType}\0${E.inputs.variants[name].nativeRecordId}`]:
  H.variantFootprint(name) });

test('S00 five fixed selection revision literals and original raw bytes are pure serialization controls', () => {
  E.literalControls();
  assert.match(E.bank.literalQualification, /serialization/);
  for (const literal of E.bank.revisionLiterals) {
    assert.equal(literal.literalArray[3], 'paper-owner');
    assert.equal(literal.literalArray[4], '0');
  }
});

test('S01 real issued owner, exact grants, three native ACKs, V2 and current index precede exact category preview',
  options, async () => owned(async data => {
    const cold = F.coldRead(data.home);
    O.assertBase(data, cold);
    assert.match(data.alpha.binding.sourceStoreId, /^[a-f0-9-]{36}$/);
    assert.notEqual(data.alpha.binding.sourceStoreId, E.bank.cases[0].sources[0]);
    assert.equal(data.owner.sessions[data.owner.token].userId, 'owner-deletion-fixture-owner');
    assert.notEqual(data.alpha.binding.restoreEpoch, '0', 'actual issued UUID epoch is not paper serialization authority');
    assert.ok(data.alpha.paired.streams[F.TYPE]);
    assert.equal(data.original.length, 3);
    const current = await O.waitCurrent(data);
    assert.ok(current.json.sources.every(source => source.state === 'current'));
    const result = await H.success(data, H.body([data.alpha], [F.TYPE]), [group(data.alpha, shared)]);
    assert.equal(result.json.effects.removedRecords, 1);
    assert.equal(result.json.selection[0].identities[0].nativeRecordId, F.ID);
    // A selection-domain revision cannot authorize unchanged exact-ID apply.
    await O.stableFailure(data, () => O.apply(data, data.alpha, O.selected(F.ID), result.json.revision),
      409, 'conflict');
  }));

test('S02 one source all saved categories, future known identity and empty result are complete readonly previews',
  options, async () => owned(async data => {
    await H.success(data, H.body([data.alpha]), [group(data.alpha, allAlpha)]);
    await H.success(data, H.body([data.alpha], ['WeightRecord']), [group(data.alpha, [])]);
    await H.ackVariant(data, data.alpha, 'future', 2, 3);
    const ids = [...allAlpha, [F.TYPE, E.inputs.variants.future.nativeRecordId]];
    const result = await H.success(data, H.body([data.alpha]), [group(data.alpha, ids, footprint('future'))]);
    assert.equal(result.json.effects.removedRecords, 3, 'known future history is not cutoff-clipped');
  }));

test('S03 null source/type resolves all retained owned namespaces without collapsing equal native IDs',
  options, async () => owned(async data => {
    const result = await H.success(data, H.body(null), all(data));
    assert.equal(result.json.effects.removedRecords, 3);
    assert.equal(result.json.resolvedSourceStoreIds.length, 2);
    assert.equal(result.json.selector.sourceStoreIds, null);
    assert.equal(result.json.selector.recordTypes, null);
  }));

test('S04 a one-nanosecond window includes its lower instant and whole overlapping ordered cadence',
  options, async () => owned(async data => {
    const result = await H.success(data, H.body([data.alpha], null, oneNs), [group(data.alpha, allAlpha)]);
    assert.equal(result.json.effects.removedRecords, 2);
    const raw = F.identityRows(F.coldRead(data.home), 'health_records', F.identity(data.alpha, F.TYPES[1]))[0];
    assert.equal(raw.record_json, E.bank.originalRecordsVerbatim[2].recordJson);
    assert.equal(Buffer.byteLength(raw.record_json), 557);
  }));

test('S05 exact instant endpoints preserve independent original offsets and use no millisecond approximation',
  options, async () => owned(async data => {
    for (const [index, name] of ['lower', 'at', 'upper'].entries()) {
      await H.ackVariant(data, data.alpha, name, index + 2, index + 3);
    }
    const alphaIds = [...shared, [F.TYPE, E.inputs.variants.at.nativeRecordId]];
    const result = await H.success(data, H.body(null, [F.TYPE], oneNs),
      [group(data.alpha, alphaIds, footprint('at')), group(data.beta, shared)]);
    assert.equal(result.json.effects.removedRecords, 3);
    const ids = result.json.selection.flatMap(item => item.identities.map(value => value.nativeRecordId));
    assert.equal(ids.includes('selection-lower'), false); assert.equal(ids.includes('selection-upper'), false);
    const offsets = result.json.selection.flatMap(item => item.identities
      .filter(value => value.nativeRecordId === F.ID).map(value => value.footprint.zoneOffset));
    assert.equal(offsets.length, 2); assert.ok(offsets.includes('+11:00')); assert.ok(offsets.includes(null));
  }));

test('S06 interval touching endpoints select nothing while final one-nanosecond overlap selects whole identity',
  options, async () => owned(async data => {
    for (const [start, end, included] of E.bank.cases.find(item => item.id === 'S06').intervalWindowControls) {
      const ids = included ? [[F.TYPES[1], F.ID]] : [];
      const result = await H.success(data, H.body([data.alpha], [F.TYPES[1]], [start, end]), [group(data.alpha, ids)]);
      assert.equal(result.json.effects.removedRecords, included ? 1 : 0);
    }
  }));

test('S07 missing raw, staged-only and unknown tomb periods refuse whole date scope and never infer nested dates',
  options, async () => {
    await owned(async data => {
      await H.ackVariant(data, data.beta, 'missing', 2, 2);
      const missing = [F.TYPE, E.inputs.variants.missing.nativeRecordId];
      await H.success(data, H.body([data.beta], [F.TYPE]),
        [group(data.beta, [...shared, missing], footprint('missing'))]);
      await H.refuse(data, H.body([data.beta], [F.TYPE], oneNs), 409, 'scope-incomplete');
      await H.success(data, H.body([data.alpha], [F.TYPES[1]], oneNs), [group(data.alpha, [[F.TYPES[1], F.ID]])]);
    });
    await owned(async data => {
      const item = F.object(data.alpha, { type: 'StepsRecord', nativeRecordId: 'selection-staged-only',
        sequence: '1', batchId: 'selection-staged-only' });
      await F.stage(data, data.alpha, item, [0]);
      const declaration = F.rows(F.coldRead(data.home), 'health_object_staging');
      assert.equal(declaration.length, 1);
      assert.equal(JSON.parse(declaration[0].declaration_json).identity.nativeRecordId, 'selection-staged-only');
      await H.success(data, H.body([data.alpha], ['StepsRecord']),
        [group(data.alpha, [['StepsRecord', 'selection-staged-only']])]);
      await H.refuse(data, H.body([data.alpha], ['StepsRecord'], oneNs), 409, 'scope-incomplete');
    });
    await owned(async data => {
      await F.ack(data, data.beta, F.batch(data.beta, '2', [F.deletion(data.beta, F.TYPE, 'selection-unknown')],
        { id: 'selection-unknown-tomb' }));
      await O.waitOwnedCurrent(data, data.beta, 1, 1);
      await H.success(data, H.body([data.beta], [F.TYPE]),
        [group(data.beta, [...shared, [F.TYPE, 'selection-unknown']])]);
      await H.refuse(data, H.body([data.beta], [F.TYPE], oneNs), 409, 'scope-incomplete');
    });
  });

test('S08 malformed present time, duplicate members, reversed intervals, streams and partial schema refuse storage',
  options, async () => {
    await owned(async data => {
      const cold = F.coldRead(data.home);
      assert.equal(F.rows(cold, 'health_schema_version')[0].version, '1');
      assert.equal(cold.native.schema.some(item => item.name === 'health_deletion_guards'), false);
      assert.equal(Object.hasOwn(cold.native.tables, 'health_deletion_guards'), false);
      assert.deepEqual(F.copies(data), []);
      assert.equal(F.rows(cold, 'health_records').length, 3);
      assert.equal(data.original.length, 3, 'all three real native ACK controls precede V1 selector');
      for (const [index, source] of [[0, data.alpha], [1, data.beta], [2, data.alpha]]) {
        const original = F.bank.recordInventory[index];
        const saved = F.identityRows(cold, 'health_records', F.identity(source, original.identity[2]));
        assert.equal(saved.length, 1); assert.equal(saved[0].record_json, original.recordJson);
        assert.equal(Buffer.byteLength(saved[0].record_json), original.expectedUtf8Bytes);
        assert.equal(I.sha(Buffer.from(saved[0].record_json)), original.expectedRecordDigest);
      }
      const receipt = vector => {
        const b = vector.payload.binding;
        return { stream_key: JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId,
          b.installationId, vector.payload.recordType, b.generation, b.restoreEpoch]), sequence: '1',
        batch_id: vector.payload.batchId, payload_digest: vector.wire.payloadDigest,
        receipt_json: JSON.stringify(vector.receipt) };
      };
      const ordered = rows => rows.map(value => JSON.stringify(value)).sort(I.ordinal);
      assert.deepEqual(ordered(F.rows(cold, 'health_batch_receipts')), ordered(data.original.map(receipt)));
      const current = await O.waitCurrent(data);
      assert.equal(current.json.sources.length, 2);
      assert.ok(current.json.sources.every(source => source.state === 'current'));
      assert.equal(O.context(data, data.beta).nativeSchemaVersion, 1);
      const result = await H.success(data, H.body([data.beta], [F.TYPE]), [group(data.beta, shared)]);
      assert.equal(result.json.kind, 'deletion-selection-preview');
      assert.deepEqual(result.json.effects, { newlyUserSuppressed: 1, removedRecords: 1,
        removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 });
      const after = F.coldRead(data.home);
      assert.equal(F.rows(after, 'health_schema_version')[0].version, '1');
      assert.equal(after.native.schema.some(item => item.name === 'health_deletion_guards'), false);
      assert.equal(Object.hasOwn(after.native.tables, 'health_deletion_guards'), false);
      assert.deepEqual(F.copies(data), []);
    }, { v2: false });
    for (const defect of ['invalid-present-time', 'duplicate-time', 'cadence-reversed',
      'malformed-stream', 'partial-native', 'partial-derived', 'complete-derived-absent']) {
      await owned(async data => {
        let operations;
        if (Object.hasOwn(E.inputs.invalidPresentRaw, defect)) {
          operations = [H.rawUpdate(data.beta, F.TYPE, F.ID, E.inputs.invalidPresentRaw[defect])];
        } else if (defect === 'cadence-reversed') {
          operations = [H.rawUpdate(data.alpha, F.TYPES[1], F.ID, E.inputs.variants[defect].recordJson)];
        } else if (defect === 'malformed-stream') {
          operations = [{ sql: 'UPDATE health_streams SET stream_key=? WHERE stream_key=?',
            params: ['not-a-stream', F.streamKey(data.beta)] }];
        } else if (defect === 'partial-native') operations = [{ sql: 'DROP TABLE health_projection_outbox' }];
        else if (defect === 'partial-derived') operations = [{ sql: 'DROP TABLE health_source_index_frontiers' }];
        else operations = ['health_source_index', 'health_source_index_frontiers', 'health_source_index_state']
          .map(name => ({ sql: `DROP TABLE ${name}` }));
        await H.sql(data, operations);
        const before = F.coldRead(data.home);
        if (defect === 'complete-derived-absent') {
          assert.equal(Object.keys(before.derived.tables).length, 0);
          await H.success(data, H.body([data.beta], [F.TYPE]), [group(data.beta, shared)]);
          assert.equal(Object.keys(F.coldRead(data.home).derived.tables).length, 0);
        } else {
          const types = defect === 'cadence-reversed' ? [F.TYPES[1]] : [F.TYPE];
          const source = defect === 'cadence-reversed' ? data.alpha : data.beta;
          await H.refuse(data, H.body([source], types, oneNs), 503, 'storage-unavailable');
        }
      });
    }
  });

test('S09 fixed selected/candidate/raw/request bounds refuse whole scope rather than truncate or materialize overflow',
  options, async () => {
    for (const count of [100, 101]) await owned(async data => {
      const ids = await H.capacity(data, count);
      const footprints = Object.fromEntries(ids.map(([type, id]) => [`${type}\0${id}`,
        E.original('alpha')[`${F.TYPE}\0${F.ID}`]]));
      if (count === 100) {
        const result = await H.success(data, H.body([data.alpha], [F.TYPE]), [group(data.alpha, ids, footprints)]);
        assert.equal(result.json.selection[0].identities.length, 100);
      } else await H.refuse(data, H.body([data.alpha], [F.TYPE]), 413, 'limit-exceeded');
    });
    await owned(async data => {
      await H.capacity(data, 1001, { splitWindow: true });
      const rows = F.rows(F.coldRead(data.home), 'health_records')
        .filter(row => row.source_store_id === data.alpha.binding.sourceStoreId);
      assert.equal(rows.filter(row => JSON.parse(row.record_json).time === '2026-01-02T03:04:05.123456789Z').length, 100);
      await H.refuse(data, H.body([data.alpha], [F.TYPE], oneNs), 413, 'limit-exceeded');
    });
    await owned(async data => {
      const ids = Array.from({ length: 100 }, (_, index) => ({ recordType: F.TYPE,
        nativeRecordId: `selection-raw-${String(index).padStart(3, '0')}` }));
      await F.stop(data);
      const result = await O.control(data, { command: 'raw-bytes', binding: data.beta.binding,
        recordType: F.TYPE, identities: ids, totalBytes: 67108865,
        record: JSON.parse(E.bank.originalRecordsVerbatim[1].recordJson) });
      assert.deepEqual(result, { records: 100, bytes: 67108865 });
      await H.restartControlled(data);
      const rows = F.coldRead(data.home).native.tables.health_records
        .filter(row => row.source_store_id.value === data.beta.binding.sourceStoreId);
      assert.equal(rows.length, 100);
      assert.equal(rows.reduce((sum, row) => sum + row.record_json.bytes, 0), 67108865);
      await H.refuse(data, H.body([data.beta], [F.TYPE]), 413, 'limit-exceeded');
    });
    await owned(async data => {
      const wire = ' '.repeat(65537); assert.equal(Buffer.byteLength(wire), 65537);
      await H.refuse(data, wire, 413, 'limit-exceeded');
    });
  });

test('S10 actual retained owners, revoked connectors, browser origin/session and catalogue refuse without mint or leaks',
  options, async () => {
    await owned(async data => {
      const requested = H.body([data.beta], [F.TYPE]);
      await H.refuse(data, requested, 401, 'unauthorised', { browser: false, headers: F.headers(data.beta) });
      await H.refuse(data, requested, 403, 'scope-mismatch', { browser: false,
        headers: { Cookie: data.owner.cookie, Origin: 'https://unapproved-selection.example.test' } });
      const foreign = await H.otherOwner(data);
      await H.refuse(data, H.body([foreign], [F.TYPE]), 403, 'scope-mismatch');
      const revoked = await F.request(data, `${F.BASE}/${data.beta.paired.connectorId}`,
        { method: 'DELETE', browser: true });
      assert.equal(revoked.status, 200); assert.deepEqual(revoked.json, { revoked: true });
      await H.success(data, requested, [group(data.beta, shared)]);
      const previous = H.events(data).filter(event => event.kind === 'actual-first-selection-body-chunk').length;
      const pending = O.held(data, H.ROUTE, requested);
      try {
        const first = await H.witnessAfter(data, 'actual-first-selection-body-chunk', previous);
        assert.ok(first.bytes > 0 && first.bytes < pending.bytes);
        const logout = await F.request(data, '/auth/logout', { method: 'POST', browser: true, body: {} });
        assert.equal(logout.status, 200); assert.deepEqual(logout.json, { ok: true });
        await H.refuse(data, requested, 401, 'unauthorised', {}, () => { pending.finish(); return pending.response; });
      } finally { pending.destroy(); }
    });
    for (const defect of ['missing', 'ambiguous']) await owned(async data => {
      const filename = path.join(data.home, 'credentials', 'health-connect.json');
      if (defect === 'ambiguous') {
        const foreign = await H.otherOwner(data);
        await F.stop(data);
        const catalogue = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const connector = catalogue.connectors.find(item => item.id === foreign.paired.connectorId);
        assert.equal(connector.ownerId, 'selection-other-owner');
        connector.sourceStoreId = data.beta.binding.sourceStoreId;
        fs.writeFileSync(filename, JSON.stringify(catalogue), { mode: 0o600 });
      } else { await F.stop(data); fs.unlinkSync(filename); }
      await H.restartControlled(data);
      await H.refuse(data, H.body([data.beta], [F.TYPE]), 503, 'storage-unavailable');
    });
  });

test('S11 one captured cutoff is stable across actual clock advance while native vector and corrected interval resnapshot',
  options, async () => owned(async data => {
    H.clock(data, E.inputs.fixedClock.initialAfterHealthySetup);
    const captured = await H.success(data, H.body([data.alpha], [F.TYPE], null, null),
      [group(data.alpha, shared)], { effectiveCutoff: E.inputs.fixedClock.initialAfterHealthySetup });
    assert.equal(captured.json.selector.cutoff, '2026-01-02T04:00:00Z');
    const requested = H.body([data.alpha], [F.TYPE]);
    const first = await H.success(data, requested, [group(data.alpha, shared)]);
    H.clock(data, E.inputs.fixedClock.later);
    const later = await H.success(data, requested, [group(data.alpha, shared)]);
    assert.equal(later.json.revision, first.json.revision);
    // Restore parent-era clock before native publish controls/expiries.
    fs.unlinkSync(path.join(data.observer, 'clock'));
    await H.ackVariant(data, data.alpha, 'future', 2, 3);
    const changed = await H.success(data, requested,
      [group(data.alpha, [...shared, [F.TYPE, 'selection-future']], footprint('future'))]);
    assert.notEqual(changed.json.revision, first.json.revision);
    await H.ackVariant(data, data.alpha, 'cadence-outside', 2, 3);
    const window = ['2026-01-02T03:09:59.999999999Z', '2026-01-02T03:10:00Z'];
    const before = await H.success(data, H.body([data.alpha], [F.TYPES[1]], window), [group(data.alpha, [])]);
    await F.ack(data, data.alpha, F.batch(data.alpha, '3', [F.upsert(data.alpha, F.bank.recordInventory[2])],
      { type: F.TYPES[1], id: 'selection-corrected-interval' }));
    await O.waitOwnedCurrent(data, data.alpha, 3);
    const after = await H.success(data, H.body([data.alpha], [F.TYPES[1]], window),
      [group(data.alpha, [[F.TYPES[1], F.ID]])]);
    assert.notEqual(after.json.revision, before.json.revision);
  }));

test('S12 scalar UTF-8 identity ordering and independently fixed Sydney UTC DST windows preserve raw offsets',
  options, async () => owned(async data => {
    for (const [index, name] of ['unicode-e000', 'unicode-10000'].entries()) {
      await H.ackVariant(data, data.beta, name, index + 2, index + 2);
    }
    const unicode = E.bank.cases.find(item => item.id === 'S12');
    assert.deepEqual(unicode.utf8Order.map(value => Buffer.from(value).toString('hex')), unicode.expectedUtf8Hex);
    const ids = [...shared, ...unicode.utf8Order.map(value => [F.TYPE, value])];
    const fixed = { ...footprint('unicode-e000'), ...footprint('unicode-10000') };
    const result = await H.success(data, H.body([data.beta], [F.TYPE]), [group(data.beta, ids, fixed)]);
    const ordered = result.json.selection[0].identities.map(value => value.nativeRecordId);
    assert.ok(ordered.indexOf(unicode.utf8Order[0]) < ordered.indexOf(unicode.utf8Order[1]));
    for (const control of unicode.timezoneControls) {
      // These frozen UTC arithmetic values are not an IANA/provider runtime claim.
      assert.equal((Date.parse(control.utcEnd) - Date.parse(control.utcStart)) / 3600000, control.hours);
      await H.success(data, H.body([data.beta], [F.TYPE], [control.utcStart, control.utcEnd]), [group(data.beta, [])]);
    }
  }));


test('S14 independent healthy child clock advance preserves exact actual source publication state',
  options, async () => {
    const fixedClock = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json');
    for (const input of [fixedClock.base, fixedClock.advanced]) {
      await owned(async data => {
        assert.equal(fs.existsSync(path.join(data.observer, 'clock')), false,
          'healthy clock is removed before ordinary requests and S11 controls');
        const cold = F.coldRead(data.home);
        O.assertBase(data, cold);
        const states = F.rows({ native: cold.derived }, 'health_source_index_state');
        assert.equal(states.length, 2);
        assert.deepEqual(states.map(row => Number(row.published_at)),
          [input.milliseconds, input.milliseconds], 'actual publications follow each independently fixed input');
      }, { healthyClock: input });
    }
  });
