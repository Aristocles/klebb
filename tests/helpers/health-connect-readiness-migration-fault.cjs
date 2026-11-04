// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const original = DatabaseSync.prototype.exec;
let tripped = false;
DatabaseSync.prototype.exec = function (sql, ...rest) {
  const result = original.call(this, sql, ...rest);
  if (!tripped && process.env.INDEPENDENT_READINESS_POST_STATE_DDL_FAILURE === '1' &&
      typeof sql === 'string' && sql.startsWith('CREATE TABLE health_source_policy_state (') &&
      sql.includes('CHECK (version=2)')) {
    tripped = true;
    const saved = this.prepare("SELECT sql FROM sqlite_schema WHERE name='health_source_policy_state'").get();
    const category = this.prepare("SELECT 1 FROM sqlite_schema WHERE name='health_source_policy_categories'").get();
    fs.writeFileSync(process.env.INDEPENDENT_READINESS_FAULT_OBSERVATION,
      JSON.stringify({ afterActualStateCreate: saved.sql.includes('CHECK (version=2)'),
        categoriesStillAbsent: category === undefined }), { flag: 'wx', mode: 0o600 });
    throw new Error('invented-post-state-ddl-refusal');
  }
  return result;
};
