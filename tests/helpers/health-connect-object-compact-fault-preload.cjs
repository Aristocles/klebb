// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Layered after the existing native observer, in one invented child only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
  path.basename(home).startsWith('eh-test-'));
const database = path.join(home, 'db', 'klebb.db');
const observations = path.resolve(process.env.INDEPENDENT_INGEST_OBSERVATIONS || '');
assert.equal(path.dirname(observations), home);
const prior = sqlite.DatabaseSync;
let fired = false;
const insert = table => new RegExp('^\\s*INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+'
  + '["`\\[]?' + table + '(?:["`\\]]|\\b)', 'i');
const raw = insert('health_records');
const receipt = insert('health_batch_receipts');
const compact = insert('health_object_receipts');
sqlite.DatabaseSync = new Proxy(prior, {
  construct(target, args) {
    const db = Reflect.construct(target, args, target);
    if (typeof args[0] !== 'string' || path.resolve(args[0]) !== database) return db;
    const prepare = db.prepare.bind(db);
    let rawWrites = 0;
    let receiptWritten = false;
    db.prepare = function (sql, ...rest) {
      const statement = prepare(sql, ...rest);
      const run = statement.run.bind(statement);
      statement.run = (...values) => {
        if (!fired && compact.test(sql)) {
          assert.ok(rawWrites > 0 && receiptWritten,
            'compact late refusal must follow actual raw and ordinary receipt writes');
          fired = true;
          fs.appendFileSync(observations, JSON.stringify({
            kind: 'object-compact-fault-fired', rawWrites, receiptWritten,
          }) + '\n', { encoding: 'utf8', mode: 0o600 });
          const error = new Error('synthetic compact statement refusal');
          error.code = 'ERR_SQLITE_ERROR';
          error.errcode = 13;
          throw error;
        }
        const result = run(...values);
        if (raw.test(sql)) rawWrites++;
        if (receipt.test(sql)) receiptWritten = true;
        return result;
      };
      return statement;
    };
    return db;
  },
});
