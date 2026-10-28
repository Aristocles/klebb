// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { fixture, close, first, postBatch, ENV, product } =
  require('../helpers/health-connect-source-index-test-fixture.cjs');

for (const mutation of ['missing', 'changed']) {
  test(`explicit migration refuses a ${mutation} original receipt-order index without repair`,
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
        const writer = new DatabaseSync(filename);
        let originalSchema;
        try {
          writer.exec('DROP INDEX health_receipt_sequence_order');
          if (mutation === 'changed') {
            writer.exec('CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (batch_id)');
          }
          originalSchema = writer.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
        } finally { writer.close(); }
        const script = `
          const history = require('./lib/health-connect/history');
          const options = { deletionSchema: true };
          if (process.platform === 'win32') options.windowsDevelopment = true;
          let result;
          try { history.withHistoryTransaction(() => null, options); result = { accepted: true }; }
          catch (error) { result = { accepted: false, status: error.status, code: error.code }; }
          process.stdout.write(JSON.stringify(result));
        `;
        const run = spawnSync(process.execPath, ['-e', script], {
          cwd: product, env: { ...process.env, ...ENV, HEALTH_HOME: data.home },
          encoding: 'utf8', timeout: 10000,
        });
        assert.equal(run.status, 0, 'real runtime executes before the rejection assertion');
        assert.deepEqual(JSON.parse(run.stdout), {
          accepted: false, status: 503, code: 'storage-unavailable',
        });
        const cold = new DatabaseSync(filename, { readOnly: true });
        try {
          assert.deepEqual(cold.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
            originalSchema);
          assert.equal(cold.prepare('SELECT version FROM health_schema_version').get().version, 1);
          assert.equal(cold.prepare('SELECT count(*) AS n FROM health_records').get().n, 2);
          assert.equal(cold.prepare('SELECT receipt_json FROM health_batch_receipts').get().receipt_json,
            JSON.stringify(vector.receipt));
        } finally { cold.close(); }
      } finally { await close(data); }
    });
}
