// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../../tests/helpers/health-connect-selection-preview-fixture.cjs');
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

test('S03 null source/type resolves all retained owned namespaces without collapsing equal native IDs',
  options, async () => owned(async data => {
    const result = await H.success(data, H.body(null), all(data));
    assert.equal(result.json.effects.removedRecords, 3);
    assert.equal(result.json.resolvedSourceStoreIds.length, 2);
    assert.equal(result.json.selector.sourceStoreIds, null);
    assert.equal(result.json.selector.recordTypes, null);
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
