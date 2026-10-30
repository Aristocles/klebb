// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers/health-connect-selection-preview-fixture.cjs');
const { O, F, I, E } = H;

test('S08 unclassifiable present declaration refuses storage after genuine staged selection and unknown-date controls',
  { timeout: 180000 }, async () => {
    const data = await H.fixture();
    try {
      O.assertBase(data, F.coldRead(data.home));
      assert.equal(data.original.length, 3);
      const current = await O.waitCurrent(data);
      assert.ok(current.json.sources.every(source => source.state === 'current'));
      const item = F.object(data.alpha, { type: 'StepsRecord', nativeRecordId: 'selection-staged-only',
        sequence: '1', batchId: 'selection-staged-only' });
      await F.stage(data, data.alpha, item, [0]);
      const before = F.coldRead(data.home), staged = F.rows(before, 'health_object_staging');
      assert.equal(staged.length, 1);
      assert.equal(F.rows(before, 'health_object_parts').length, 1);
      assert.equal(staged[0].stream_key, F.streamKey(data.alpha, 'StepsRecord'));
      assert.deepEqual(JSON.parse(staged[0].declaration_json), item.header);
      const request = H.body([data.alpha], ['StepsRecord']);
      await H.success(data, request,
        [{ source: data.alpha, ids: [['StepsRecord', 'selection-staged-only']] }]);
      await H.refuse(data, H.body([data.alpha], ['StepsRecord'],
        E.bank.cases.find(value => value.id === 'S04').period), 409, 'scope-incomplete');

      // Only this saved metadata field changes on the real stopped owned fixture.
      await H.sql(data, [{ sql: 'UPDATE health_object_staging SET declaration_json=? WHERE stream_key=?',
        params: ['[]', staged[0].stream_key] }]);
      const corrupted = F.coldRead(data.home), changed = F.rows(corrupted, 'health_object_staging');
      assert.equal(changed.length, 1);
      assert.equal(changed[0].stream_key, staged[0].stream_key);
      assert.equal(changed[0].declaration_json, '[]');
      assert.equal(Buffer.from(changed[0].declaration_json).toString('hex'), '5b5d');
      assert.equal(I.sha(Buffer.from(changed[0].declaration_json)),
        'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
      const normalized = structuredClone(corrupted);
      normalized.native.tables.health_object_staging[0].declaration_json =
        before.native.tables.health_object_staging[0].declaration_json;
      assert.deepEqual(normalized, before, 'only the one metadata literal changes; all other cold state is exact');
      await H.refuse(data, request, 503, 'storage-unavailable');
    } finally { await H.close(data); }
  });
