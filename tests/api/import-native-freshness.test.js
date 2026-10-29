// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../helpers/import-native-freshness-fixture.cjs');
const NONFRESH = ["records", "tombstones", "guards", "stream", "batch-receipt", "outbox", "staging", "parts", "object-receipt", "index-entry", "index-frontier", "index-state", "authority-grant", "authority-connector", "authority-invalid-entry"];
const STORAGE = ["native-partial", "native-incompatible", "native-unknown", "native-missing-index", "objects-partial", "index-partial", "database-corrupt", "database-directory", "authority-malformed", "authority-duplicate", "authority-extra-key", "authority-wrong-version", "authority-bad-uuid", "authority-wrong-arrays", "authority-too-many", "authority-oversize", "authority-directory", "native-view-only", "native-unknown-view"];
const FRESH = ["absent", "empty-v1", "empty-v2", "empty-v1-optional", "empty-v2-optional", "authority-empty", "generic-credentials"];
const retained = state => state.sql?.tables?.filter(t => t.name.startsWith('health_')) || [];
function same(before, after, wal = false) {
  if (!wal) assert.deepEqual(after,before);
  else {
    assert.deepEqual(after.sql,before.sql);
    assert.deepEqual(after.files.filter(x => !x.path.startsWith('db/')),before.files.filter(x => !x.path.startsWith('db/')));
  }
}
function refuse(f, code, wal = false) {
  const before = F.cold(f.home), archive = F.files(f.tree);
  for (const apply of [false,true]) {
    const r = F.run(f,apply); same(before,F.cold(f.home),wal); assert.deepEqual(F.files(f.tree),archive);
    assert.equal(r.status,1,r.out); assert.match(r.out,new RegExp('\\b'+code+'\\b'));
    for (const secret of F.RETAINED_SECRETS) assert(!r.out.includes(secret),'Refusal exposed native verifier material');
    assert.doesNotMatch(r.out,new RegExp(code === 'VAL_TARGET_STORAGE' ? '\\bVAL_TARGET_NOT_FRESH\\b' : '\\bVAL_TARGET_STORAGE\\b'));
  }
}
test('F01 supported cardless native records refuse before fresh import', () => {
  const control = F.fixture('absent'), f = F.fixture('records');
  try {
    const c = F.run(control); assert.equal(c.status,0,c.out);
    const before = F.cold(f.home), tables = before.sql.tables;
    const records = tables.find(t => t.name === 'health_records').rows; assert.equal(records.length,3);
    assert.equal(tables.find(t => t.name === 'cards').rows.length,0);
    assert.equal(tables.find(t => t.name === 'hae_pushes').rows.length,0);
    assert(!before.files.some(x => x.path === 'credentials/health-connect.json'));
    for (const r of F.RECORDS) assert(records.some(x => x.record_json === r.recordJson &&
      x.tenant_id === r.identity[0] && x.source_store_id === r.identity[1] && x.record_type === r.identity[2] && x.native_record_id === r.identity[3]));
    refuse(f,'VAL_TARGET_NOT_FRESH');
  } finally { F.dispose(control); F.dispose(f); }
});
for (const mode of NONFRESH.filter(x => x !== 'records')) test(`F02 retained ${mode} refuses with complete cold state preserved`, () => {
  const f = F.fixture(mode); try { refuse(f,'VAL_TARGET_NOT_FRESH'); } finally { F.dispose(f); }
});
for (const mode of STORAGE) test(`F03 unavailable ${mode} refuses before any fresh apply`, () => {
  const f = F.fixture(mode); try { refuse(f,'VAL_TARGET_STORAGE'); } finally { F.dispose(f); }
});
for (const mode of FRESH) test(`F04 supported ${mode} stays eligible and imports the valid report`, () => {
  const f = F.fixture(mode);
  try {
    const before = F.cold(f.home), archive = F.files(f.tree), r = F.run(f);
    same(before,F.cold(f.home)); assert.deepEqual(F.files(f.tree),archive); assert.equal(r.status,0,r.out);
    const a = F.run(f,true); assert.equal(a.status,0,a.out);
    assert.equal(fs.readFileSync(path.join(f.home,'reports','synthetic.md'),'utf8'),F.REPORT);
    assert.deepEqual(retained(F.cold(f.home)),retained(before)); assert.deepEqual(F.files(f.tree),archive);
    const credential = x => x.files.find(y => y.path === 'credentials/health-connect.json');
    assert.deepEqual(credential(F.cold(f.home)),credential(before));
  } finally { F.dispose(f); }
});
test('F05 stopped WAL native-only target refuses with durable cold state preserved', t => {
  const f = F.fixture('records',true);
  try {
    const before = F.cold(f.home); refuse(f,'VAL_TARGET_NOT_FRESH',true); const after = F.cold(f.home);
    const internal = x => x.files.filter(y => y.path.startsWith('db/'));
    t.diagnostic(JSON.stringify({ sqliteInternalBefore: internal(before), sqliteInternalAfter: internal(after) }));
  } finally { F.dispose(f); }
});

test('F06 selected target wins over separate global native database and authority paths', () => {
  const fresh = F.fixture('absent'), native = F.fixture('records'), authority = F.fixture('authority-grant');
  try {
    const before = F.cold(native.home), other = F.cold(fresh.home), saved = F.cold(authority.home);
    const refused = F.run(native,false,{ HEALTH_DB_FILE: path.join(fresh.home,'db','klebb.db'),
      HEALTH_CREDENTIALS_DIR: path.join(fresh.home,'credentials') });
    same(before,F.cold(native.home)); same(other,F.cold(fresh.home));
    assert.equal(refused.status,1,refused.out); assert.match(refused.out,/\bVAL_TARGET_NOT_FRESH\b/);
    const accepted = F.run(fresh,false,{ HEALTH_DB_FILE: path.join(native.home,'db','klebb.db'),
      HEALTH_CREDENTIALS_DIR: path.join(authority.home,'credentials') });
    assert.equal(accepted.status,0,accepted.out); same(other,F.cold(fresh.home)); same(saved,F.cold(authority.home));
  } finally { F.dispose(fresh); F.dispose(native); F.dispose(authority); }
});
