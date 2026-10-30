// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Fixed membership is supplied by tests. No product selector or date-filter import.
const assert = require('node:assert/strict');
const I = require('./health-connect-owner-deletion-independent.cjs');
const bank = require('../fixtures/health-connect/selection-preview-independent-vectors.json');
const inputs = require('../fixtures/health-connect/selection-preview-scenario-inputs.json');
const ordered = values => values === null ? null : [...values].sort(I.ordinal);
const original = sourceName => ({
  [`BodyWaterMassRecord\0r0-shared-id`]: { kind: 'instant',
    time: '2026-01-02T03:04:05.123456789Z', zoneOffset: sourceName === 'alpha' ? '+11:00' : null },
  [`CyclingPedalingCadenceRecord\0r0-shared-id`]: { kind: 'interval',
    startTime: '2026-01-02T03:00:00Z', endTime: '2026-01-02T03:10:00Z',
    startZoneOffset: '+11:00', endZoneOffset: '+11:00' },
});
function literalControls() {
  for (const record of bank.originalRecordsVerbatim) {
    const bytes = Buffer.from(record.recordJson);
    assert.equal(bytes.length, record.expectedUtf8Bytes);
    assert.equal(I.sha(bytes), record.expectedRecordDigest);
  }
  for (const fixed of bank.revisionLiterals) {
    const json = JSON.stringify(fixed.literalArray);
    assert.equal(json, fixed.expectedCompactUtf8);
    assert.equal(Buffer.byteLength(json), fixed.expectedUtf8Bytes);
    assert.equal(I.sha(Buffer.from(json)), fixed.expectedRevision);
  }
  for (const value of Object.values(inputs.variants)) {
    assert.equal(Buffer.byteLength(value.recordJson), value.bytes);
    assert.equal(I.sha(Buffer.from(value.recordJson)), value.digest);
  }
}
function expected(data, requested, membership, snapshot, F, O) {
  const selector = { sourceStoreIds: ordered(requested.sourceStoreIds),
    recordTypes: ordered(requested.recordTypes), period: requested.period, cutoff: requested.cutoff };
  assert.equal(typeof selector.cutoff, 'string', 'effective cutoff independently fixed before revision');
  const groups = [...membership].sort((a, b) => I.ordinal(a.source.binding.sourceStoreId, b.source.binding.sourceStoreId));
  const tables = O.tables(snapshot), sources = [], selection = [];
  const effects = { newlyUserSuppressed: 0, removedRecords: 0,
    removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 };
  for (const group of groups) {
    const context = O.context(data, group.source);
    const identities = group.ids.map(([recordType, nativeRecordId]) => ({ recordType, nativeRecordId }));
    const footprints = { ...original(group.source === data.alpha ? 'alpha' : 'beta'), ...group.footprints };
    // The independent cold reader hashed each actual large TEXT before reducing it.
    const sourceTables = { ...tables, health_records: tables.health_records.map(row => ({
      ...row, record_json: typeof row.record_json === 'string' ? row.record_json : '' })) };
    const states = I.statesFromRows(context, identities, sourceTables, footprints);
    for (const state of states) {
      if (state[2] === null) continue;
      const row = snapshot.native.tables.health_records.find(item =>
        item.tenant_id.value === context.tenantId && item.source_store_id.value === context.sourceStoreId &&
        item.record_type.value === state[0] && item.native_record_id.value === state[1]);
      if (row.record_json.bytes !== undefined) {
        state[2][4] = row.record_json.bytes; state[2][5] = row.record_json.digest;
      }
    }
    const vector = I.verifiedVector(context, tables).sort((a, b) => I.ordinal(a[0], b[0]));
    sources.push([context.sourceStoreId, vector, states]);
    selection.push({ sourceStoreId: context.sourceStoreId, identities: states.map(state => ({
      recordType: state[0], nativeRecordId: state[1], sourceDeleted: state[3] !== null || state[4]?.[0] === 1,
      userSuppressed: state[4]?.[1] === 1, currentRecord: state[2] !== null,
      // New selection authority uses current raw before a retained guard.
      footprint: I.footprintObject(state[2]?.[6] ?? state[4]?.[4] ?? null),
    })) });
    const counts = I.effectCounts(states);
    for (const key of Object.keys(effects)) effects[key] += counts[key];
  }
  const boundary = O.context(data, groups[0].source);
  const owner = data.owner.sessions[data.owner.token].userId;
  const array = ['health-connect-user-delete-selection', 1, boundary.tenantId, owner,
    boundary.restoreEpoch, boundary.nativeSchemaVersion,
    [selector.sourceStoreIds, selector.recordTypes, selector.period === null ? null :
      [selector.period.startTime, selector.period.endTime], selector.cutoff], sources];
  const revision = I.sha(Buffer.from(JSON.stringify(array)));
  return { version: 1, kind: 'deletion-selection-preview', selector,
    resolvedSourceStoreIds: groups.map(group => group.source.binding.sourceStoreId), revision, selection, effects };
}
module.exports = { bank, inputs, I, ordered, original, literalControls, expected };
