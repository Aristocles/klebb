// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../helpers/health-connect-owner-deletion-fixture.cjs');
const { F, I } = O;
const known = { kind: 'instant', time: '2026-01-02T03:04:05.123456789Z', zoneOffset: null };

test('U06 independently fixed revision and browser encoding bytes remain exact', () => {
  assert.equal(I.bank.revisionVectors.length, 10);
  assert.equal(I.bank.responseExamples.length, 4);
  for (const vector of I.bank.revisionVectors) {
    const array = vector.revisionArray;
    const context = { tenantId: array[2], sourceStoreId: array[3],
      restoreEpoch: array[4], nativeSchemaVersion: array[5] };
    const identities = array[6].map(([recordType, nativeRecordId]) =>
      ({ recordType, nativeRecordId }));
    const actual = I.revision(context, identities, array[7], array[8]);
    assert.equal(actual.json, vector.revisionJsonUtf8, vector.id);
    assert.equal(actual.bytes, vector.utf8Bytes, vector.id);
    assert.equal(actual.digest, vector.expectedRevision, vector.id);
    const permuted = I.revision(context, [...identities].reverse(),
      [...array[7]].reverse(), [...array[8]].reverse());
    assert.deepEqual(permuted, actual, 'canonical selection uses original UTF8 byte ordering');
  }
  for (const example of I.bank.responseExamples) {
    for (const kind of ['preview', 'apply']) {
      const bytes = Buffer.from(JSON.stringify(example[kind]));
      assert.equal(bytes.toString(), example.literalCompactResponseUtf8[kind], example.id);
      assert.equal(I.sha(bytes), example.literalByteDigests[kind], example.id);
    }
  }
  assert.ok(I.ordinal('\ue000', '\ud800\udc00') < 0, 'UTF8 scalar order differs from UTF16');
  assert.throws(() => I.ordinal('\ud800', 'x'), 'unpaired Unicode is refused');
  assert.throws(() => I.ordinal('\udc00', 'x'), 'unpaired Unicode is refused');
});

test('U01 original D07 owner preview is read-only and apply retains exact siblings and native references',
  { timeout: 60000 }, async () => {
    const data = await O.fixture();
    try {
      const source = data.beta;
      const identities = [{ recordType: F.TYPE, nativeRecordId: F.ID }];
      const before = F.coldRead(data.home), authority = O.catalogueDigest(data);
      O.assertBase(data, before);
      const expected = O.expectations(data, source, identities, before);
      assert.equal(expected.content.array[8][0][2][4], 357);
      assert.equal(expected.content.array[8][0][2][5],
        'sha256:c75f9ec48ec178af6f10bfa22907417e79b0e45bb4cd4ac00e50b16a248d41e1');
      assert.deepEqual(expected.preview.identities, [{ recordType: F.TYPE, nativeRecordId: F.ID,
        sourceDeleted: false, userSuppressed: false, currentRecord: true, footprint: known }]);
      assert.deepEqual(expected.preview.effects, { newlyUserSuppressed: 1, removedRecords: 1,
        removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 });
      const copies = F.copies(data);
      const preview = await O.preview(data, source, identities);
      O.assertPreview(preview, expected, data);
      assert.deepEqual(F.coldRead(data.home), before, 'each read-only preview has complete zero effects');
      assert.equal(O.catalogueDigest(data), authority);
      assert.deepEqual(F.copies(data), copies, 'preview cannot migrate or publish a safety copy');

      const applied = await O.apply(data, source, identities, expected.content.digest);
      O.assertApply(applied, expected, data, true);
      await O.waitCurrent(data, 0);
      const after = F.coldRead(data.home);
      O.assertUserEffect(before, after, source, F.TYPE, F.ID, known);
      assert.equal(O.catalogueDigest(data), authority);
      assert.deepEqual(F.copies(data), copies, 'apply requires V2 and cannot auto-migrate');
      const betaIndex = O.derivedRows(after, 'health_source_index')
        .filter(row => row.source_store_id === source.binding.sourceStoreId);
      assert.deepEqual(betaIndex, [], 'actual worker publishes the remaining empty beta source');
      F.noAuthority(JSON.stringify(after), data);
    } finally { await F.close(data); }
  });

test('U02 original D08 unseen beta Weight is user-suppressed before a real scoped first upsert',
  { timeout: 60000 }, async () => {
    const data = await O.fixture();
    try {
      const source = data.beta, type = 'WeightRecord', id = I.bank.unseenWeightId;
      // This grant/exchange really includes Weight from setup. No generation,
      // installation, catalogue or fake credential control substitutes for it.
      assert.ok(source.paired.streams[type]);
      const capabilities = await F.capabilities(data, source);
      assert.equal(capabilities.status, 200);
      const identities = [{ recordType: type, nativeRecordId: id }];
      const before = F.coldRead(data.home), authority = O.catalogueDigest(data);
      O.assertBase(data, before);
      const expected = O.expectations(data, source, identities, before);
      assert.deepEqual(expected.preview.identities, [{ recordType: type, nativeRecordId: id,
        sourceDeleted: false, userSuppressed: false, currentRecord: false, footprint: null }]);
      assert.deepEqual(expected.preview.effects, { newlyUserSuppressed: 1, removedRecords: 0,
        removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 });
      const copies = F.copies(data);
      O.assertPreview(await O.preview(data, source, identities), expected, data);
      assert.deepEqual(F.coldRead(data.home), before, 'unseen-ID preview is fully read-only');
      assert.equal(O.catalogueDigest(data), authority);
      O.assertApply(await O.apply(data, source, identities, expected.content.digest), expected, data, true);
      await O.waitCurrent(data);
      const after = F.coldRead(data.home);
      O.assertUserEffect(before, after, source, type, id, null);
      assert.equal(O.catalogueDigest(data), authority);
      assert.deepEqual(F.copies(data), copies);

      const deniedBefore = F.coldRead(data.home);
      const vector = O.unseenWeight(source);
      const denied = await F.post(data, source, F.BATCH, vector.wire);
      F.failure(denied, 409, 'deletion-suppressed', data);
      assert.deepEqual(denied.json, { version: 1, kind: 'error',
        code: 'deletion-suppressed', retryable: false });
      assert.deepEqual(F.coldRead(data.home), deniedBefore,
        'each valid current Weight refusal preserves complete native/staging/index state');
      assert.equal(O.catalogueDigest(data), authority);
      assert.deepEqual(F.copies(data), copies);
    } finally { await F.close(data); }
  });

// Original U03-U16 risk groups; fixed prior U01/U02 assertions remain above.
const fs = require('node:fs');
const path = require('node:path');
const { fakeAuthState } = require('../helpers/sandbox');
const ids = O.selected;
const baselineOptions = { timeout: 60000 };

test('U03 legal same-source same-type mixed batch is wholly suppressed; unchanged next sequence remains usable',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      await O.suppress(data); await O.waitOwnedCurrent(data, data.beta, 0);
      const mixed = F.batch(data.beta, '2', [F.upsert(data.beta, F.bank.recordInventory[1]),
        F.upsert(data.beta, F.bank.recordInventory[1], 'owner-independent-next')], { id: 'owner-mixed-2' });
      await O.stableFailure(data, () => F.post(data, data.beta, F.BATCH, mixed.wire),
        409, 'deletion-suppressed');
      const eligible = F.batch(data.beta, '2',
        [F.upsert(data.beta, F.bank.recordInventory[1], 'owner-independent-next')],
        { id: 'owner-independent-2' });
      const before = F.coldRead(data.home);
      await F.ack(data, data.beta, eligible);
      await O.waitOwnedCurrent(data, data.beta, 1);
      const after = F.coldRead(data.home);
      assert.equal(F.identityRows(after, 'health_records', F.identity(data.beta)).length, 0);
      assert.equal(F.identityRows(after, 'health_records',
        F.identity(data.beta, F.TYPE, 'owner-independent-next')).length, 1);
      assert.deepEqual(F.identityRows(after, 'health_records', F.identity(data.alpha)),
        F.identityRows(before, 'health_records', F.identity(data.alpha)));
      assert.deepEqual(F.identityRows(after, 'health_records', F.identity(data.alpha, F.TYPES[1])),
        F.identityRows(before, 'health_records', F.identity(data.alpha, F.TYPES[1])));
    } finally { await F.close(data); }
  });

test('U04 sparse matching actual BLOBs and reservation purge atomically; unrelated staging and compact receipts survive',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const matching = F.object(data.beta);
      const otherSource = F.object(data.alpha, { objectId: 'owner-alpha-staged', batchId: 'owner-alpha-staged' });
      const otherType = F.object(data.alpha, { type: F.TYPES[1], sequence: '2',
        objectId: 'owner-cadence-staged', batchId: 'owner-cadence-staged' });
      for (const [source, item] of [[data.beta, matching], [data.alpha, otherSource], [data.alpha, otherType]]) {
        await F.stage(data, source, item, [0, 2]);
      }
      const before = F.coldRead(data.home), expected = O.expected(data, data.beta, ids(), before);
      assert.equal(before.physical.length, 6);
      const bytes = matching.pieces[0].length + matching.pieces[2].length;
      assert.deepEqual(expected.preview.effects, { newlyUserSuppressed: 1, removedRecords: 1,
        removedStagedObjects: 1, removedParts: 2, removedPartBytes: bytes });
      O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      O.assertApply(await O.apply(data, data.beta, ids(), expected.content.digest), expected, data);
      await O.waitOwnedCurrent(data, data.beta, 0);
      const after = F.coldRead(data.home);
      O.assertReferences(before, after);
      const retain = rows => rows.filter(row => row.stream_key !== F.streamKey(data.beta));
      assert.deepEqual(F.rows(after, 'health_object_staging'), retain(F.rows(before, 'health_object_staging')));
      assert.deepEqual(after.physical, before.physical.filter(part => part.streamKey.value !== F.streamKey(data.beta)));
      assert.equal(F.rows(after, 'health_object_staging').reduce((sum, row) =>
        sum + Number(row.reservation_bytes), 0), otherSource.header.totalBytes + otherType.header.totalBytes);
      await O.stableFailure(data, () => F.post(data, data.beta, F.PART, matching.partFrames[1]),
        409, 'deletion-suppressed');
      await O.stableFailure(data, () => F.post(data, data.beta, F.FINAL, matching.finalise),
        409, 'deletion-suppressed');
    } finally { await F.close(data); }
  });

for (const retry of ['ordinary', 'PART', 'FINALISE']) {
  test(`U05 separate ${retry} exact committed retry remains receipt-only after owner suppression`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        let route = F.BATCH, frame = data.original[1].wire, receipt = data.original[1].receipt;
        let footprints = {};
        if (retry !== 'ordinary') {
          const item = F.object(data.beta);
          await F.stage(data, data.beta, item);
          const committed = await F.post(data, data.beta, F.FINAL, item.finalise);
          assert.equal(committed.status, 200); assert.deepEqual(committed.json, item.receipt);
          await O.waitOwnedCurrent(data, data.beta, 1);
          assert.equal(F.rows(F.coldRead(data.home), 'health_object_receipts').length, 1);
          route = retry === 'PART' ? F.PART : F.FINAL;
          frame = retry === 'PART' ? item.partFrames[0] : item.finalise;
          receipt = retry === 'PART' ? item.partReceipts[0] : item.receipt;
          footprints = { [F.ID]: O.objectFootprint };
        }
        await O.suppress(data, data.beta, ids(), footprints);
        await O.waitOwnedCurrent(data, data.beta, 0);
        await O.stableReceipt(data, () => F.post(data, data.beta, route, frame), receipt);
        const next = retry === 'ordinary' ? F.batch(data.beta, '2',
          [F.upsert(data.beta, F.bank.recordInventory[1])], { id: 'new-suppressed-ordinary' }).wire :
          F.object(data.beta, { sequence: '3', batchId: 'new-suppressed-object',
            objectId: 'new-suppressed-object' })[retry === 'PART' ? 'partFrames' : 'finalise'];
        await O.stableFailure(data, () => F.post(data, data.beta, route,
          retry === 'PART' ? next[0] : next), 409, 'deletion-suppressed');
        const changed = structuredClone(frame);
        if (retry === 'ordinary') changed.payloadDigest = 'sha256:' + '0'.repeat(64);
        else changed.objectId = 'changed-original-object';
        await O.stableFailure(data, () => F.post(data, data.beta, route, changed),
          retry === 'ordinary' ? 400 : 409, retry === 'ordinary' ? 'digest-mismatch' : 'conflict');
      } finally { await F.close(data); }
    });
}

test('U06 selection order is canonical; valid correction and full saved vector invalidate the old revision',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const identities = [...ids(), ...ids('\ue000'), ...ids('\ud800\udc00')];
      const before = F.coldRead(data.home), expected = O.expected(data, data.beta, identities, before);
      const first = await O.preview(data, data.beta, identities);
      O.assertPreview(first, expected, data);
      O.assertPreview(await O.preview(data, data.beta, [...identities].reverse()), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      const correction = F.batch(data.beta, '2', [F.upsert(data.beta, F.bank.recordInventory[1],
        F.ID, { mass: { value: '44.125', unit: 'kg' } })], { id: 'owner-real-correction-2' });
      await F.ack(data, data.beta, correction); await O.waitOwnedCurrent(data, data.beta, 1);
      const corrected = F.coldRead(data.home), updated = O.expected(data, data.beta, identities, corrected);
      assert.notEqual(updated.content.digest, expected.content.digest);
      O.assertPreview(await O.preview(data, data.beta, identities), updated, data);
      assert.deepEqual(F.coldRead(data.home), corrected);
      await O.stableFailure(data, () => O.apply(data, data.beta, identities, expected.content.digest),
        409, 'conflict');
    } finally { await F.close(data); }
  });

test('U06 newly received matching physical part changes revision without advancing native references',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const item = F.object(data.beta);
      await F.stage(data, data.beta, item, [0]);
      const before = F.coldRead(data.home), expected = O.expected(data, data.beta, ids(), before);
      O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
      await F.stage(data, data.beta, item, [2]);
      const after = F.coldRead(data.home), changed = O.expected(data, data.beta, ids(), after);
      O.assertReferences(before, after);
      assert.notEqual(changed.content.digest, expected.content.digest);
      assert.equal(changed.preview.effects.removedParts, 2);
      assert.equal(changed.preview.effects.removedPartBytes, item.pieces[0].length + item.pieces[2].length);
      O.assertPreview(await O.preview(data, data.beta, ids()), changed, data);
      await O.stableFailure(data, () => O.apply(data, data.beta, ids(), expected.content.digest),
        409, 'conflict');
    } finally { await F.close(data); }
  });

test('U07 source deletion provenance and known period remain; fresh terminal owner apply is a complete no-op',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const sourceDelete = F.batch(data.beta, '2', [F.deletion(data.beta)], { id: 'owner-source-delete-2' });
      await F.ack(data, data.beta, sourceDelete);
      await O.waitOwnedCurrent(data, data.beta, 0, 1);
      const before = F.coldRead(data.home);
      const oldGuard = F.identityRows(before, 'health_deletion_guards', F.identity(data.beta))[0];
      assert.equal(oldGuard.source_deleted, '1'); assert.equal(oldGuard.user_suppressed, '0');
      assert.equal(oldGuard.source_stream_key, F.streamKey(data.beta)); assert.equal(oldGuard.source_sequence, '2');
      assert.deepEqual(JSON.parse(oldGuard.footprint_json), known);
      const expected = O.expected(data, data.beta, ids(), before);
      assert.deepEqual(expected.preview.identities[0], { recordType: F.TYPE, nativeRecordId: F.ID,
        sourceDeleted: true, userSuppressed: false, currentRecord: false, footprint: known });
      O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
      O.assertApply(await O.apply(data, data.beta, ids(), expected.content.digest), expected, data);
      await O.waitOwnedCurrent(data, data.beta, 0, 1);
      const after = F.coldRead(data.home);
      O.assertReferences(before, after);
      assert.deepEqual(F.identityRows(after, 'health_deletion_guards', F.identity(data.beta))[0],
        { ...oldGuard, user_suppressed: '1' });
      const terminal = O.expected(data, data.beta, ids(), after);
      assert.deepEqual(terminal.preview.effects, { newlyUserSuppressed: 0, removedRecords: 0,
        removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 });
      O.assertPreview(await O.preview(data, data.beta, ids()), terminal, data);
      O.assertApply(await O.apply(data, data.beta, ids(), terminal.content.digest), terminal, data, false);
      assert.deepEqual(F.coldRead(data.home), after, 'no retry-budget reset or schedule for terminal no-op');
    } finally { await F.close(data); }
  });

test('U07 retained legacy tombstone remains separate authority without synthesized guard provenance or period',
  baselineOptions, async () => {
    const data = await O.fixture({ v2: false });
    try {
      await F.ack(data, data.beta, F.batch(data.beta, '2', [F.deletion(data.beta)],
        { id: 'owner-V1-source-delete-2' }));
      await O.waitOwnedCurrent(data, data.beta, 0, 1);
      assert.deepEqual(F.rows(F.coldRead(data.home), 'health_deletion_guards'), []);
      await F.migrate(data); await O.waitOwnedCurrent(data, data.beta, 0, 1);
      const before = F.coldRead(data.home), expected = O.expected(data, data.beta, ids(), before);
      assert.deepEqual(F.rows(before, 'health_deletion_guards'), [], 'migration has no eager guard backfill');
      assert.deepEqual(expected.preview.identities[0], { recordType: F.TYPE, nativeRecordId: F.ID,
        sourceDeleted: true, userSuppressed: false, currentRecord: false, footprint: null });
      O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      O.assertApply(await O.apply(data, data.beta, ids(), expected.content.digest), expected, data);
      await O.waitOwnedCurrent(data, data.beta, 0, 1);
      const after = F.coldRead(data.home); O.assertReferences(before, after);
      assert.deepEqual(F.identityRows(after, 'health_deletion_guards', F.identity(data.beta)),
        [{ tenant_id: data.beta.binding.tenantId, source_store_id: data.beta.binding.sourceStoreId,
          record_type: F.TYPE, native_record_id: F.ID, source_deleted: '0', user_suppressed: '1',
          source_stream_key: null, source_sequence: null, footprint_json: null }]);
    } finally { await F.close(data); }
  });

test('U08 each foreign authority, wrong origin and injected authority member refuses with complete zero effects',
  baselineOptions, async () => {
    const admin = 'synthetic-owner-admin-' + 'a'.repeat(40);
    const agent = 'synthetic-owner-chat-' + 'b'.repeat(40);
    const data = await O.fixture({ extraEnv: { KLEBB_ADMIN_TOKEN: admin, AGENT_API_TOKEN: agent } });
    try {
      data.markers.push(admin, agent);
      const before = F.coldRead(data.home), expected = O.expected(data, data.beta, ids(), before);
      const requests = [O.PREVIEW, O.APPLY];
      const other = fakeAuthState('owner-deletion-other-owner');
      await F.stop(data);
      const credentials = path.join(data.home, 'credentials', 'webauthn.json');
      const sessions = path.join(data.home, 'sessions', 'webauthn.json');
      const existingCredentials = JSON.parse(fs.readFileSync(credentials));
      const existingSessions = JSON.parse(fs.readFileSync(sessions));
      existingCredentials.users = { ...existingCredentials.users, ...other.credentials.users };
      fs.writeFileSync(credentials, JSON.stringify(existingCredentials), { mode: 0o600 });
      fs.writeFileSync(sessions, JSON.stringify({ ...existingSessions, ...other.sessions }), { mode: 0o600 });
      data.markers.push(other.token);
      await F.restart(data);
      for (const route of requests) {
        const body = { sourceStoreId: data.beta.binding.sourceStoreId, identities: ids(),
          ...(route === O.APPLY ? { revision: expected.content.digest } : {}) };
        for (const headers of [{}, { Cookie: 'klebb_session=invalid-synthetic-session' },
          F.headers(data.beta), { Authorization: `Bearer ${admin}` },
          { Authorization: `Bearer ${agent}` }]) {
          await O.stableFailure(data, () => F.request(data, route, { method: 'POST', body, headers }),
            401, 'unauthorised');
        }
        await O.stableFailure(data, () => F.request(data, route, { method: 'POST', body,
          headers: { Cookie: `klebb_session=${other.token}`, Origin: F.ENV.HEALTH_ORIGIN } }),
        403, 'scope-mismatch');
        await O.stableFailure(data, () => F.request(data, route, { method: 'POST', body,
          headers: { Cookie: data.owner.cookie, Origin: 'https://unapproved-origin.example.test' } }),
        403, 'scope-mismatch');
        for (const member of ['tenantId', 'ownerId', 'generation', 'restoreEpoch']) {
          await O.stableFailure(data, () => F.request(data, route, { method: 'POST',
            browser: true, body: { ...body, [member]: 'synthetic-injected-authority' } }),
          400, 'invalid-message');
        }
      }
      const revoked = await F.request(data, `${F.BASE}/${data.beta.paired.connectorId}`,
        { method: 'DELETE', browser: true });
      assert.equal(revoked.status, 200); assert.deepEqual(revoked.json, { revoked: true });
      await O.stableFailure(data, () => F.request(data, `${F.BASE}/v1/capabilities`,
        { headers: F.headers(data.beta) }), 401, 'revoked');
      O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
      O.assertApply(await O.apply(data, data.beta, ids(), expected.content.digest), expected, data);
      await O.waitOwnedCurrent(data, data.beta, 0);
    } finally { await F.close(data); }
  });

for (const route of [O.PREVIEW, O.APPLY]) {
  for (const action of ['logout', 'freeze']) {
    test(`U09 ${route.endsWith('preview') ? 'preview' : 'apply'} rechecks real ${action} after a held nonempty body`,
      baselineOptions, async () => {
        const data = await O.fixture();
        let pending;
        try {
          const expected = O.expected(data, data.beta, ids());
          await O.arm(data, action === 'freeze' ? 'held-freeze' : 'held-observe');
          const before = F.coldRead(data.home), copies = F.copies(data), authority = O.catalogueDigest(data);
          const body = { sourceStoreId: data.beta.binding.sourceStoreId, identities: ids(),
            ...(route === O.APPLY ? { revision: expected.content.digest } : {}) };
          pending = O.held(data, route, body);
          const event = await O.observed(data, 'actual-first-body-chunk');
          assert.equal(event.route, route); assert.ok(event.bytes > 0 && event.bytes < pending.bytes);
          if (action === 'logout') {
            const logout = await F.request(data, '/auth/logout', { method: 'POST', browser: true, body: {} });
            assert.equal(logout.status, 200); assert.deepEqual(logout.json, { ok: true });
          }
          pending.finish();
          F.failure(await pending.response, action === 'freeze' ? 503 : 401,
            action === 'freeze' ? 'IMPORT_FROZEN' : 'unauthorised', data);
          assert.deepEqual(F.coldRead(data.home), before);
          assert.equal(O.catalogueDigest(data), authority); assert.deepEqual(F.copies(data), copies);
        } finally { if (pending) pending.destroy(); await F.close(data); }
      });
  }
}

for (const defect of ['missing', 'malformed', 'ambiguous-owner']) {
  test(`U08 retained catalogue ${defect} fails closed without ownership minting or repair`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        const expected = O.expected(data, data.beta, ids());
        const filename = path.join(data.home, 'credentials', 'health-connect.json');
        if (defect === 'ambiguous-owner') {
          const other = fakeAuthState('owner-deletion-ambiguity-owner');
          await F.stop(data);
          const credentials = path.join(data.home, 'credentials', 'webauthn.json');
          const sessions = path.join(data.home, 'sessions', 'webauthn.json');
          const existing = JSON.parse(fs.readFileSync(credentials));
          existing.users = { ...existing.users, ...other.credentials.users };
          fs.writeFileSync(credentials, JSON.stringify(existing), { mode: 0o600 });
          fs.writeFileSync(sessions, JSON.stringify({
            ...JSON.parse(fs.readFileSync(sessions)), ...other.sessions }), { mode: 0o600 });
          data.markers.push(other.token);
          await F.restart(data);
          const owner = data.owner;
          let genuinelyOtherOwned;
          try { data.owner = other; genuinelyOtherOwned = await O.pair(data, 'ambiguous-other', F.TYPES); }
          finally { data.owner = owner; }
          await F.stop(data);
          const catalogue = JSON.parse(fs.readFileSync(filename));
          const otherConnector = catalogue.connectors.find(row => row.id === genuinelyOtherOwned.paired.connectorId);
          assert.equal(otherConnector.ownerId, 'owner-deletion-ambiguity-owner');
          otherConnector.sourceStoreId = data.beta.binding.sourceStoreId;
          fs.writeFileSync(filename, JSON.stringify(catalogue), { mode: 0o600 });
        } else {
          await F.stop(data);
          if (defect === 'missing') fs.unlinkSync(filename);
          else fs.writeFileSync(filename, '{"version":1,"connectors":', { mode: 0o600 });
        }
        await F.restart(data);
        const before = F.coldRead(data.home), copies = F.copies(data);
        const retained = () => fs.existsSync(filename) ? I.sha(fs.readFileSync(filename)) : 'absent';
        const authority = retained();
        for (const action of [() => O.preview(data, data.beta, ids()),
          () => O.apply(data, data.beta, ids(), expected.content.digest)]) {
          F.failure(await action(), 503, 'storage-unavailable', data);
          assert.deepEqual(F.coldRead(data.home), before);
          assert.deepEqual(F.copies(data), copies);
          assert.equal(retained(), authority, 'lost or corrupt ownership is never repaired by deletion');
        }
      } finally { await F.close(data); }
    });
}

test('U10 real retained-fence rotation after guard raw sparse part and index writes rolls back the complete transaction',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      await F.stage(data, data.beta, F.object(data.beta), [0, 2]);
      const expected = O.expected(data, data.beta, ids());
      await O.arm(data, 'final-fence');
      const before = F.coldRead(data.home), authority = O.catalogueDigest(data), copies = F.copies(data);
      F.failure(await O.apply(data, data.beta, ids(), expected.content.digest), 503, 'storage-unavailable', data);
      const events = O.witness(data);
      const rotated = events.find(row => row.kind === 'actual-retained-fence-rotated');
      assert.ok(rotated); assert.equal(rotated.transactionActive, true);
      for (const name of ['guards', 'raw', 'parts', 'index']) assert.ok(rotated[name] > 0);
      assert.ok(events.some(row => row.kind === 'actual-ROLLBACK-returned'));
      assert.deepEqual(F.coldRead(data.home), before);
      assert.notEqual(O.catalogueDigest(data), authority, 'intentional current-catalogue control survives rollback');
      assert.deepEqual(F.copies(data), copies);
      F.failure(await F.request(data, `${F.BASE}/v1/capabilities`, { headers: F.headers(data.beta) }),
        401, 'revoked', data);
      assert.deepEqual(F.coldRead(data.home), before);
    } finally { await F.close(data); }
  });

for (const state of ['current', 'exhausted']) {
  test(`U11 actual ${state} same-vector cycle resets in the deletion transaction before the actual worker`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        await F.stage(data, data.beta, F.object(data.beta), [0, 2]);
        if (state === 'exhausted') await O.exhaust(data);
        const expected = O.expected(data, data.beta, ids());
        await O.arm(data, 'hold-after-COMMIT');
        const before = F.coldRead(data.home);
        const prior = O.derivedRows(before, 'health_source_index_state')
          .find(row => row.source_store_id === data.beta.binding.sourceStoreId);
        assert.equal(prior.state, state === 'current' ? 'current' : 'failed');
        assert.equal(prior.attempt_count, state === 'current' ? '1' : '3');
        assert.equal(prior.next_attempt_at, null);
        const pending = O.apply(data, data.beta, ids(), expected.content.digest);
        void pending.catch(() => {});
        try {
          await O.observed(data, 'actual-COMMIT-returned');
          await O.observed(data, 'actual-post-COMMIT-schedule-deferred');
          O.witness(data, { committed: true });
          const queued = F.coldRead(data.home);
          O.assertCommittedDeletion(before, queued, data.beta);
          const response = await O.status(data);
          assert.equal(response.status, 200);
          const actual = response.json.sources.find(row => row.sourceStoreId === data.beta.binding.sourceStoreId);
          assert.equal(actual.state, 'queued'); assert.equal(actual.saved.records, 0);
          assert.equal(actual.published.records, 1); assert.equal(actual.attempts.count, 0);
          assert.equal(actual.attempts.nextAt, null); assert.equal(actual.errorCode, null);
          assert.equal(actual.published.publishedAt, new Date(Number(prior.published_at)).toISOString());
          assert.equal(actual.published.restoreEpoch, prior.published_restore_epoch);
          assert.deepEqual(F.coldRead(data.home), queued, 'actual queued status remains read-only');
          fs.writeFileSync(path.join(data.home, 'owner-delete-release'), 'release', { flag: 'wx', mode: 0o600 });
          O.assertApply(await pending, expected, data);
          await O.observed(data, 'actual-post-COMMIT-schedule-released');
          await O.waitOwnedCurrent(data, data.beta, 0);
          const after = F.coldRead(data.home); O.assertReferences(before, after);
          assert.deepEqual(O.derivedRows(after, 'health_source_index')
            .filter(row => row.source_store_id === data.beta.binding.sourceStoreId), []);
        } finally {
          if (!fs.existsSync(path.join(data.home, 'owner-delete-release'))) {
            fs.writeFileSync(path.join(data.home, 'owner-delete-release'), 'release', { mode: 0o600 });
          }
        }
      } finally { await F.close(data); }
    });
}

test('U12 owned paired zero-stream source receives guard only without inventing publication or native references',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const zero = await O.pair(data, 'zero', F.TYPES);
      const identity = ids('owner-zero-unseen');
      const before = F.coldRead(data.home), expected = O.expected(data, zero, identity, before);
      assert.deepEqual(expected.preview.identities[0], { ...identity[0], sourceDeleted: false,
        userSuppressed: false, currentRecord: false, footprint: null });
      O.assertPreview(await O.preview(data, zero, identity), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      O.assertApply(await O.apply(data, zero, identity, expected.content.digest), expected, data, false);
      const after = F.coldRead(data.home);
      O.assertUserEffect(before, after, zero, F.TYPE, 'owner-zero-unseen', null);
      assert.deepEqual(after.derived, before.derived);
      O.assertReferences(before, after);
      const key = row => JSON.parse(row.stream_key)[2] === zero.binding.sourceStoreId;
      assert.deepEqual(F.rows(after, 'health_streams').filter(key), []);
      assert.deepEqual(F.rows(after, 'health_batch_receipts').filter(key), []);
      assert.deepEqual(F.rows(after, 'health_projection_outbox').filter(key), []);
    } finally { await F.close(data); }
  });

test('U13 selection100 and received UTF8 body65536 are inclusive;101 duplicate and65537 refuse before effects',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const identities = Array.from({ length: 100 }, (_, index) =>
        ({ recordType: F.TYPE, nativeRecordId: `owner-bound-${String(index).padStart(3, '0')}-\u03a9` }));
      const before = F.coldRead(data.home), expected = O.expected(data, data.beta, identities, before);
      O.assertPreview(await O.preview(data, data.beta, identities), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      const boundaryId = '\ud83d\ude00'.repeat(256);
      const boundarySelection = ids(boundaryId);
      assert.equal([...boundaryId].length, 256); assert.equal(boundaryId.length, 512);
      O.assertPreview(await O.preview(data, data.beta, boundarySelection),
        O.expected(data, data.beta, boundarySelection, before), data);
      assert.deepEqual(F.coldRead(data.home), before);
      for (const invalid of [[], [...identities, ...ids('owner-bound-101')], [identities[0], identities[0]],
        ids(''), ids(boundaryId + '\ud83d\ude00'), ids('\ud800'), ids('\udc00'),
        ids('owner-invalid-type', 'not-a-record-type')]) {
        await O.stableFailure(data, () => O.preview(data, data.beta, invalid), 400, 'invalid-message');
      }
      const compact = JSON.stringify({ sourceStoreId: data.beta.binding.sourceStoreId, identities });
      const wire = compact + ' '.repeat(65536 - Buffer.byteLength(compact));
      assert.equal(Buffer.byteLength(wire), 65536);
      assert.ok(Buffer.byteLength(wire) > wire.length, 'original Unicode UTF8 measurement');
      O.assertPreview(await F.request(data, O.PREVIEW, { method: 'POST', browser: true, body: wire }), expected, data);
      assert.deepEqual(F.coldRead(data.home), before);
      await O.stableFailure(data, () => F.request(data, O.PREVIEW,
        { method: 'POST', browser: true, body: wire + ' ' }), 413, 'limit-exceeded');
    } finally { await F.close(data); }
  });

for (const totalBytes of [67108864, 67108865]) {
  test(`U13 stopped selected raw inventory${totalBytes} bytes preserves the64MiB inclusive boundary`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        const identities = Array.from({ length: 100 }, (_, index) =>
          ({ recordType: F.TYPE, nativeRecordId: `owner-raw-bound-${String(index).padStart(3, '0')}` }));
        await F.stop(data);
        const result = await O.control(data, { command: 'raw-bytes', binding: data.beta.binding,
          recordType: F.TYPE, identities, totalBytes, record: JSON.parse(F.bank.recordInventory[1].recordJson) });
        assert.equal(result.records, 100); assert.equal(result.bytes, totalBytes);
        await F.restart(data); await F.capabilities(data);
        const before = F.coldRead(data.home);
        const raw = F.rows(before, 'health_records').filter(row => row.source_store_id === data.beta.binding.sourceStoreId);
        assert.equal(raw.length, 100);
        const typed = before.native.tables.health_records
          .filter(row => row.source_store_id.value === data.beta.binding.sourceStoreId);
        assert.equal(typed.reduce((sum, row) => sum + row.record_json.bytes, 0), totalBytes);
        if (totalBytes === 67108864) {
          const expected = O.expected(data, data.beta, identities, before);
          O.assertPreview(await O.preview(data, data.beta, identities), expected, data);
          assert.deepEqual(F.coldRead(data.home), before);
        } else await O.stableFailure(data, () => O.preview(data, data.beta, identities), 413, 'limit-exceeded');
      } finally { await F.close(data); }
    });
}

for (const count of [1000, 1001]) {
  test(`U13 stopped internally consistent saved vector${count} checks every native reference at the inclusive cap`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        await F.stop(data);
        const result = await O.control(data, { command: 'vector', binding: data.beta.binding,
          recordType: F.TYPE, count });
        assert.equal(result.streams, count);
        const stopped = F.coldRead(data.home);
        const ownsBeta = row => row.tenant_id === data.beta.binding.tenantId
          && row.source_store_id === data.beta.binding.sourceStoreId;
        const states = O.derivedRows(stopped, 'health_source_index_state').filter(ownsBeta);
        assert.equal(states.length, 1);
        const state = states[0];
        for (const [field, value] of Object.entries({
          target_id: 'source-index-v1', state: 'failed',
          requested_restore_epoch: data.beta.binding.restoreEpoch,
          attempt_count: '3', next_attempt_at: null, error_code: 'storage-unavailable'
        })) assert.equal(state[field], value, `stopped exhausted fixture ${field}`);
        const stoppedScope = row => JSON.parse(row.stream_key)[2] === data.beta.binding.sourceStoreId;
        for (const table of ['health_streams', 'health_batch_receipts', 'health_projection_outbox']) {
          assert.equal(F.rows(stopped, table).filter(stoppedScope).length, count);
        }
        const components = F.rows(stopped, 'health_streams').filter(stoppedScope)
          .map(row => [row.stream_key, row.acknowledged_sequence])
          .sort((a, b) => I.ordinal(a[0], b[0]));
        const requestedDigest = count === 1001 ? null : I.sha(Buffer.from(JSON.stringify(components)));
        assert.equal(state.requested_vector_digest, requestedDigest,
          'stopped exhausted fixture uses NULL for an incomplete above-cap vector');
        if (count === 1001) {
          const typedState = stopped.derived.tables.health_source_index_state
            .filter(row => row.tenant_id.value === data.beta.binding.tenantId
              && row.source_store_id.value === data.beta.binding.sourceStoreId);
          assert.deepEqual(typedState[0].requested_vector_digest, { type: 'null' });
        }
        await F.restart(data); await F.capabilities(data);
        const before = F.coldRead(data.home);
        const scope = row => JSON.parse(row.stream_key)[2] === data.beta.binding.sourceStoreId;
        for (const table of ['health_streams', 'health_batch_receipts', 'health_projection_outbox']) {
          assert.equal(F.rows(before, table).filter(scope).length, count);
        }
        if (count === 1000) {
          const expected = O.expected(data, data.beta, ids(), before);
          assert.equal(expected.content.array[7].length, 1000);
          O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
          assert.deepEqual(F.coldRead(data.home), before);
        } else await O.stableFailure(data, () => O.preview(data, data.beta, ids()), 413, 'limit-exceeded');
      } finally { await F.close(data); }
    });
}

const stagingBounds = [
  { id: 'objects1000', objectCount: 1000, partsPerObject: 1, accepted: true },
  { id: 'objects1001', objectCount: 1001, partsPerObject: 1, accepted: false },
  { id: 'parts128000', objectCount: 1000, partsPerObject: 128, accepted: true },
  { id: 'parts128001', objectCount: 1000, partsPerObject: 128, extraPart: true, accepted: false },
  { id: 'actualBytes4096', objectCount: 2, objectPartSizes: [[2048], [2048]], cap: 4096, accepted: true },
  { id: 'actualBytes4097', objectCount: 2, objectPartSizes: [[2048], [2049]], cap: 4096, accepted: false },
];
for (const input of stagingBounds) {
  test(`U13 original stopped staging inventory ${input.id} checks actual BLOB counts and bytes`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        // Real routed PART obtains the existing schema before disclosed stopped
        // replacement. No fabricated native ACK or invalid connector catalogue.
        const template = F.object(data.beta, { paddingCount: 0 });
        await F.stage(data, data.beta, template, [0]);
        await F.stop(data);
        await F.control(data, { command: 'bulk-stage', header: template.header, ...input });
        // Saved4097 is deliberately above the NEW configured4096 cap; initial
        // native admission does not become the owner-deletion test's refusal.
        await F.restart(data, { ...data.extraEnv, ...(input.cap ?
          { HEALTH_CONNECT_STAGING_MAX_BYTES: String(input.cap) } : {}) });
        await F.capabilities(data);
        const before = F.coldRead(data.home);
        assert.equal(F.rows(before, 'health_object_staging').length, input.objectCount);
        const parts = input.objectPartSizes ? 2 : input.objectCount * input.partsPerObject + (input.extraPart ? 1 : 0);
        assert.equal(before.physical.length, parts);
        for (const part of before.physical) {
          assert.equal(part.actual.type, 'blob'); assert.equal(part.actual.digest, part.savedDigest.value);
        }
        if (input.cap) assert.equal(before.physical.reduce((sum, row) => sum + row.actual.bytes, 0),
          input.accepted ? 4096 : 4097);
        if (input.accepted) {
          const expected = O.expected(data, data.beta, ids(), before);
          assert.equal(expected.preview.effects.removedStagedObjects, input.objectCount);
          assert.equal(expected.preview.effects.removedParts, parts);
          O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
          assert.deepEqual(F.coldRead(data.home), before);
          O.assertApply(await O.apply(data, data.beta, ids(), expected.content.digest), expected, data);
          await O.waitOwnedCurrent(data, data.beta, 0);
          const after = F.coldRead(data.home);
          assert.equal(after.physical.length, 0); assert.deepEqual(F.rows(after, 'health_object_staging'), []);
          O.assertReferences(before, after);
        } else await O.stableFailure(data, () => O.preview(data, data.beta, ids()), 413, 'limit-exceeded');
      } finally { await F.close(data); }
    });
}

test('U14 validV1 preview is read-only; owner apply refuses without automatic migration or safety copy',
  baselineOptions, async () => {
    const data = await O.fixture({ v2: false });
    try {
      const before = F.coldRead(data.home), copies = F.copies(data);
      assert.equal(F.rows(before, 'health_schema_version')[0].version, '1');
      assert.deepEqual(F.rows(before, 'health_deletion_guards'), []);
      const expected = O.expected(data, data.beta, ids(), before);
      O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
      assert.deepEqual(F.coldRead(data.home), before); assert.deepEqual(F.copies(data), copies);
      await O.stableFailure(data, () => O.apply(data, data.beta, ids(), expected.content.digest),
        503, 'storage-unavailable');
    } finally { await F.close(data); }
  });

const corruptStoredState = [
  { id: 'absent-initialized-native', absent: true },
  { id: 'missing-native-base', sql: 'DROP TABLE health_records' },
  { id: 'partial-native-base', sql: 'DROP TABLE health_projection_outbox' },
  { id: 'missing-V2-guard', sql: 'DROP TABLE health_deletion_guards' },
  { id: 'partial-index', sql: 'DROP TABLE health_source_index_frontiers' },
  { id: 'partial-object', sql: 'DROP TABLE health_object_receipts', staging: true },
  { id: 'malformed-time', recordJson: '{"metadata":{"id":"r0-shared-id"},"time":"not-an-instant"}' },
  { id: 'impossible-time', recordJson: '{"metadata":{"id":"r0-shared-id"},"time":"2026-02-30T03:04:05Z"}' },
  { id: 'duplicate-time', recordJson: '{"metadata":{"id":"r0-shared-id"},"time":"2026-01-02T03:04:05Z","time":"2026-01-03T03:04:05Z"}' },
  { id: 'receipt-reference', sql: 'UPDATE health_batch_receipts SET payload_digest=? WHERE stream_key=?',
    values: ['sha256:' + '0'.repeat(64)] },
  { id: 'outbox-reference', sql: 'UPDATE health_projection_outbox SET batch_id=? WHERE stream_key=?',
    values: ['corrupt-stored-reference'] },
  { id: 'source-guard-provenance', guard: true },
  { id: 'actual-BLOB-digest', staging: true, blob: true },
];
for (const defect of corruptStoredState) {
  test(`U14 actual present corruption ${defect.id} fails closed and never repairs the stored input`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        if (defect.staging) await F.stage(data, data.beta, F.object(data.beta), [0, 2]);
        const scope = [data.beta.binding.tenantId, data.beta.binding.sourceStoreId, F.TYPE, F.ID];
        let operations;
        if (defect.absent) operations = ['health_deletion_guards', 'health_tombstones',
          'health_projection_outbox', 'health_batch_receipts', 'health_streams',
          'health_records', 'health_schema_version', 'health_source_index',
          'health_source_index_frontiers', 'health_source_index_state']
          .map(name => ({ sql: `DROP TABLE ${name}` }));
        else if (defect.recordJson) operations = [{ sql: 'UPDATE health_records SET record_json=? '
          + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?',
        params: [defect.recordJson, ...scope] }];
        else if (defect.blob) operations = [{ sql: 'UPDATE health_object_parts SET part_bytes=? '
          + 'WHERE stream_key=? AND part_index=0',
        params: [{ blobHex: '51'.repeat(524288) }, F.streamKey(data.beta)] }];
        else if (defect.guard) operations = [{ sql: 'INSERT INTO health_deletion_guards VALUES '
          + "(?,?,?,?,1,0,?,?,?)", params: [...scope, 'not-a-stream-key', '2', JSON.stringify(known)] }];
        else operations = [{ sql: defect.sql, params: defect.values ?
          [...defect.values, F.streamKey(data.beta)] : [] }];
        await F.stop(data); await F.control(data, { command: 'sql', operations });
        await F.restart(data);
        const before = F.coldRead(data.home);
        if (defect.blob) {
          const actual = before.physical.find(row => row.index.decimal === '0');
          assert.equal(actual.actual.bytes, 524288); assert.notEqual(actual.actual.digest, actual.savedDigest.value);
        }
        if (defect.recordJson) assert.equal(F.identityRows(before, 'health_records',
          F.identity(data.beta))[0].record_json, defect.recordJson);
        // The current-input reader must refuse before trying to invent an old
        // revision for corrupt storage. No automatic migration/healing follows.
        await O.stableFailure(data, () => O.preview(data, data.beta, ids()), 503, 'storage-unavailable');
        await O.stableFailure(data, () => O.apply(data, data.beta, ids(), 'sha256:' + '1'.repeat(64)),
          503, 'storage-unavailable');
      } finally { await F.close(data); }
    });
}

test('U14 genuinely absent common time has unknown SQLNULL footprint rather than an invented date',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const raw = JSON.parse(F.bank.recordInventory[1].recordJson);
      delete raw.time; delete raw.zoneOffset;
      await F.mutate(data, [{ sql: 'UPDATE health_records SET record_json=? '
        + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND native_record_id=?',
      params: [JSON.stringify(raw), data.beta.binding.tenantId, data.beta.binding.sourceStoreId, F.TYPE, F.ID] }]);
      const before = F.coldRead(data.home);
      const expected = I.expected(O.context(data, data.beta), ids(), O.tables(before), {});
      assert.equal(expected.preview.identities[0].footprint, null);
      O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
      O.assertApply(await O.apply(data, data.beta, ids(), expected.content.digest), expected, data);
      await O.waitOwnedCurrent(data, data.beta, 0);
      assert.equal(F.identityRows(F.coldRead(data.home), 'health_deletion_guards',
        F.identity(data.beta))[0].footprint_json, null);
    } finally { await F.close(data); }
  });

for (const mode of ['sqlite-full', 'sqlite-busy', 'late-refusal', 'before-COMMIT-death', 'after-COMMIT-death']) {
  test(`U15 actual owner writer ${mode} retains real durability and cold-read transaction boundaries`,
    baselineOptions, async () => {
      const data = await O.fixture();
      try {
        await F.stage(data, data.beta, F.object(data.beta), [0, 2]);
        if (mode === 'sqlite-full' || mode === 'late-refusal') {
          await F.stop(data);
          await O.control(data, { command: 'pressure', refusal: mode === 'late-refusal', vacuum: true });
          await F.restart(data); await F.capabilities(data);
        }
        const expected = O.expected(data, data.beta, ids());
        await O.arm(data, mode);
        const before = F.coldRead(data.home), copies = F.copies(data), authority = O.catalogueDigest(data);
        assert.equal(before.physical.length, 2);
        if (mode.includes('death')) {
          await O.lostApply(data, data.beta, ids(), expected.content.digest);
          const cold = F.coldRead(data.home); // BEFORE restart/publisher recovery.
          if (mode === 'before-COMMIT-death') {
            O.witness(data, { prior: true }); assert.deepEqual(cold, before);
          } else {
            O.witness(data, { committed: true }); O.assertCommittedDeletion(before, cold, data.beta);
          }
          assert.equal(O.catalogueDigest(data), authority); assert.deepEqual(F.copies(data), copies);
          // Remove only this fixture's observation arm before genuine restart.
          fs.unlinkSync(path.join(data.home, 'owner-delete-enabled'));
          await F.restart(data, {}); await F.capabilities(data);
          if (mode === 'after-COMMIT-death') {
            await O.waitOwnedCurrent(data, data.beta, 0);
            const terminalState = F.coldRead(data.home);
            const terminal = O.expected(data, data.beta, ids(), terminalState);
            assert.deepEqual(terminal.preview.effects, { newlyUserSuppressed: 0, removedRecords: 0,
              removedStagedObjects: 0, removedParts: 0, removedPartBytes: 0 });
            O.assertPreview(await O.preview(data, data.beta, ids()), terminal, data);
            assert.deepEqual(F.coldRead(data.home), terminalState);
            await O.stableFailure(data, () => O.apply(data, data.beta, ids(), expected.content.digest),
              409, 'conflict');
            O.assertApply(await O.apply(data, data.beta, ids(), terminal.content.digest), terminal, data, false);
            assert.deepEqual(F.coldRead(data.home), terminalState);
          } else {
            assert.deepEqual(F.coldRead(data.home), before);
            O.assertPreview(await O.preview(data, data.beta, ids()), expected, data);
          }
        } else {
          await O.stableFailure(data, () => O.apply(data, data.beta, ids(), expected.content.digest),
            503, 'storage-unavailable');
          O.witness(data, { nativeResult: mode === 'sqlite-full' ? 13 :
            mode === 'sqlite-busy' ? 5 : 1811, prior: mode !== 'sqlite-busy' });
          assert.deepEqual(F.coldRead(data.home), before);
        }
      } finally { await F.close(data); }
    });
}

test('U16 same-final-source existing API dumps and diff retain nonempty35.5 legacy and every unrelated native byte',
  baselineOptions, async () => {
    const data = await O.fixture();
    try {
      const files = ['tests/api/health-connect-owner-deletion.test.js',
        'tests/helpers/health-connect-owner-deletion-fixture.cjs',
        'tests/helpers/health-connect-owner-deletion-independent.cjs',
        'tests/helpers/health-connect-owner-deletion-controlled-state.cjs',
        'tests/helpers/health-connect-owner-deletion-preload.cjs',
        'tests/fixtures/health-connect/owner-deletion-independent-vectors.json'];
      const sourceHashes = () => files.map(name => [name, I.sha(fs.readFileSync(path.join(F.product, name)))]);
      const sourceBefore = sourceHashes(), before = F.coldRead(data.home);
      const dumpBefore = path.join(data.home, 'owner-legacy-before'), dumpAfter = path.join(data.home, 'owner-legacy-after');
      O.dump(data, dumpBefore);
      const cardFilename = path.join(dumpBefore, O.LEGACY.meta.id + '.json');
      const card = JSON.parse(fs.readFileSync(cardFilename));
      assert.ok(JSON.stringify(card).includes('"kg":35.5'), 'actual nonempty independently fixed legacy reading');
      await O.suppress(data); await O.waitOwnedCurrent(data, data.beta, 0);
      O.dump(data, dumpAfter); O.dump(data, dumpAfter, dumpBefore);
      assert.deepEqual(fs.readFileSync(path.join(dumpAfter, O.LEGACY.meta.id + '.json')),
        fs.readFileSync(cardFilename));
      assert.deepEqual(sourceHashes(), sourceBefore, 'exact same final source for all three real operator commands');
      const after = F.coldRead(data.home);
      O.assertReferences(before, after);
      O.assertUserEffect(before, after, data.beta, F.TYPE, F.ID, known);
      F.noAuthority(JSON.stringify(after), data);
    } finally { await F.close(data); }
  });
