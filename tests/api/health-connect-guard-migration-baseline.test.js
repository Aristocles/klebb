// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { fixture, close, first, postBatch, ENV, product } =
  require('../helpers/health-connect-source-index-test-fixture.cjs');

test('explicit deletion-schema opt-in migrates real committed V1 history before its callback',
  { timeout: 20000 }, async () => {
    const data = await fixture();
    try {
      const vector = first(data);
      const saved = await postBatch(data, vector);
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.json, vector.receipt);
      await data.server.kill();
      data.server = null;
      const filename = path.join(data.home, 'db', 'klebb.db');
      const before = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.equal(before.prepare('SELECT version FROM health_schema_version').get().version, 1);
        assert.equal(before.prepare('SELECT count(*) AS n FROM health_records').get().n, 2);
        assert.equal(before.prepare('SELECT count(*) AS n FROM health_tombstones').get().n, 1);
      } finally { before.close(); }
      const script = `
        const history = require('./lib/health-connect/history');
        const options = { deletionSchema: true };
        if (process.platform === 'win32') options.windowsDevelopment = true;
        const result = history.withHistoryTransaction(db => ({
          version: db.prepare('SELECT version FROM health_schema_version').get().version,
          guards: !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='health_deletion_guards'").get(),
          records: db.prepare('SELECT count(*) AS n FROM health_records').get().n,
          tombstones: db.prepare('SELECT count(*) AS n FROM health_tombstones').get().n,
        }), options);
        process.stdout.write(JSON.stringify(result));
      `;
      const run = spawnSync(process.execPath, ['-e', script], {
        cwd: product, env: { ...process.env, ...ENV, HEALTH_HOME: data.home },
        encoding: 'utf8', timeout: 10000,
      });
      assert.equal(run.status, 0, 'existing transaction must execute; a missing module is not the baseline');
      assert.deepEqual(JSON.parse(run.stdout), { version: 2, guards: true, records: 2, tombstones: 1 });
      const copies = fs.readdirSync(path.dirname(filename))
        .filter(name => /^klebb\.db\.pre-health-deletion-v2-[0-9]+-[a-f0-9-]+\.db$/.test(name));
      assert.equal(copies.length, 1);
      const copy = new DatabaseSync(path.join(path.dirname(filename), copies[0]), { readOnly: true });
      try {
        assert.equal(copy.prepare('SELECT version FROM health_schema_version').get().version, 1);
        assert.equal(copy.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='health_deletion_guards'").get().n, 0);
        assert.equal(copy.prepare('SELECT count(*) AS n FROM health_records').get().n, 2);
        assert.equal(copy.prepare('SELECT receipt_json FROM health_batch_receipts').get().receipt_json,
          JSON.stringify(vector.receipt));
      } finally { copy.close(); }
    } finally { await close(data); }
  });
