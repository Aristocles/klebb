// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fixture, close, req, BASE, TYPE, noAuthority, coldReadSourceState } =
  require('../helpers/health-connect-source-index-test-fixture.cjs');
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function claim(binding) {
  const window = { start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z' };
  const queryJson = JSON.stringify({ recordType: TYPE, window, dataOrigins: [],
    historyStart: '2026-01-01T00:00:00Z', features: { history: true, backgroundRead: false } });
  const fingerprint = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
  return JSON.stringify({ version: 1, kind: 'coverage', binding, recordType: TYPE,
    window, filterDigest: sha(queryJson), rawFrontier: '0', status: 'partial',
    pagesFinished: true, permissionsStable: true, tokenValid: true,
    permissionFingerprintStart: fingerprint, permissionFingerprintEnd: fingerprint,
    historyIncludesScope: true, changesBarrierDrained: true, queryJson });
}
function journalMode(home) {
  const db = new DatabaseSync(path.join(home, 'db', 'klebb.db'), { readOnly: true });
  try { return db.prepare('PRAGMA journal_mode').get().journal_mode; }
  finally { db.close(); }
}
test('paired ordinary census refuses absent native history without initializing it',
  { timeout: 20000 }, async () => {
    const data = await fixture();
    try {
      // Pairing is real existing setup, with no native ingestion or dummy batch.
      const authorityFile = path.join(data.home, 'credentials', 'health-connect.json');
      const beforeAuthority = fs.readFileSync(authorityFile);
      const before = coldReadSourceState(data.home);
      assert.deepEqual(before.native.nativeSchema, []);
      assert.deepEqual(before.native.records, []);
      assert.deepEqual(before.native.receipts, []);
      assert.deepEqual(before.native.frontiers, []);
      assert.deepEqual(before.native.jobs, []);
      assert.equal(before.index.schemaPresent, false);
      assert.ok(before.native.legacyRows.length > 0);
      const beforeJournal = journalMode(data.home);
      const response = await req(data.server.baseUrl, `${BASE}/v1/censuses/begin`, {
        method: 'POST', headers: data.headers, body: { coverageJson: claim(data.binding) },
      });
      assert.equal(response.status, 503);
      assert.equal(response.json.kind, 'error');
      assert.equal(response.json.code, 'storage-unavailable');
      assert.equal(response.json.retryable, true);
      noAuthority(response.body, data);
      assert.deepEqual(coldReadSourceState(data.home), before,
        'no native/index schema, receipts, history or legacy rows are initialized or changed');
      assert.equal(journalMode(data.home), beforeJournal, 'census selects no new journal mode');
      assert.deepEqual(fs.readFileSync(authorityFile), beforeAuthority,
        'existing paired catalogue remains byte exact');
    } finally { await close(data); }
  });
