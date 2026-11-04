// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Child-only faults on real SQLite and catalogue rename in an invented home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
  path.basename(home).startsWith('eh-test-'), 'owned synthetic home only');
assert.equal(fs.realpathSync(home), home);
const policy = path.join(home, 'credentials', 'health-connect-policy.json');
const database = path.join(home, 'db', 'klebb.db');
const marker = path.resolve(process.env.INDEPENDENT_BIRTH_FAULT_MARKER || '');
assert.equal(path.dirname(marker), home);
const operation = process.env.INDEPENDENT_BIRTH_FAULT;
assert.ok(['callback-rename-after', 'commit-after'].includes(operation));
const member = JSON.parse(process.env.INDEPENDENT_BIRTH_MEMBER || 'null');
assert.ok(member && typeof member.userId === 'string' && typeof member.credentialId === 'string' &&
  /^sha256:[a-f0-9]{64}$/.test(member.publicKeySha256));
const original = { read: fs.readFileSync, rename: fs.renameSync, write: fs.writeFileSync };
const OriginalDatabase = sqlite.DatabaseSync;
const handles = new Set();
let fired = false;
function record(event) {
  original.write.call(fs, marker, JSON.stringify(event), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
function fail() {
  const error = new Error('synthetic first-family durability fault');
  error.code = 'EIO';
  throw error;
}
function born(handle) {
  if (!handle.active) return null;
  try {
    const rows = table => handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      .map(row => ({ ...row }));
    const state = rows('health_source_policy_state'), sources = rows('health_source_policy_sources');
    const categories = rows('health_source_policy_categories');
    if (state.length !== 1 || sources.length !== 1 || categories.length !== 1) return null;
    const s = state[0], source = sources[0], category = categories[0];
    if (s.revision !== '1' || s.source_count !== 1 || source.tenant_id !== s.tenant_id ||
        source.owner_id !== s.owner_id || category.tenant_id !== s.tenant_id ||
        category.source_store_id !== source.source_store_id || source.lifecycle !== 'active' ||
        source.reconciled_epoch !== null || category.record_type !== 'BodyWaterMassRecord' ||
        category.sharing !== 'stopped' || category.generation !== '1') return null;
    return { state, sources, categories };
  } catch { return null; }
}
function boundGate(gate, sql) {
  if (!gate || gate.version !== 2 || gate.recoveryRequired !== true ||
      !Array.isArray(gate.principals) || !Array.isArray(gate.namespaces)) return false;
  const s = sql.state[0];
  const principal = gate.principals.find(p => p.ownerId === s.owner_id);
  const namespace = gate.namespaces.find(n => n.ownerId === s.owner_id && n.state.tenantId === s.tenant_id);
  return !!principal && principal.members.some(m => m.userId === member.userId &&
    m.credentialId === member.credentialId && m.publicKeySha256 === member.publicKeySha256) &&
    !!namespace && namespace.state.restoreEpoch === s.epoch;
}
fs.renameSync = function (from, to) {
  if (!fired && operation === 'callback-rename-after' && typeof from === 'string' &&
      typeof to === 'string' && path.resolve(to) === policy &&
      path.resolve(from).startsWith(policy + '.') && from.endsWith('.tmp')) {
    const gate = JSON.parse(original.read.call(fs, from, 'utf8'));
    for (const handle of handles) {
      const sql = born(handle);
      if (!sql || !boundGate(gate, sql)) continue;
      const result = original.rename.call(fs, from, to); // Actual durable-file boundary first.
      fired = true;
      record({ operation, phase: 'updated-born-gate-renamed-before-COMMIT',
        realRenameReturned: true, realCommitReturned: false, gateBeforeCOMMIT: gate, sqlBeforeCOMMIT: sql });
      fail();
      return result;
    }
  }
  return original.rename.call(fs, from, to);
};
sqlite.DatabaseSync = new Proxy(OriginalDatabase, {
  construct(target, args) {
    const db = Reflect.construct(target, args, target);
    if (typeof args[0] !== 'string' || path.resolve(args[0]) !== database) return db;
    const handle = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), active: false };
    handles.add(handle);
    db.exec = function (sql) {
      if (!fired && operation === 'commit-after' && /^\s*COMMIT\s*;?\s*$/i.test(sql)) {
        const snapshot = born(handle);
        if (snapshot) {
          // Capture the real semantic catalogue before COMMIT. The inverse may lack its new members.
          const gate = JSON.parse(original.read.call(fs, policy, 'utf8'));
          const result = handle.exec(sql); // Genuine native SQLite COMMIT must return successfully.
          handle.active = false;
          fired = true;
          record({ operation, phase: 'native-COMMIT-returned-before-injected-throw',
            realCommitReturned: true, gateBeforeCOMMIT: gate, sqlBeforeCOMMIT: snapshot });
          fail();
          return result;
        }
      }
      const result = handle.exec(sql);
      if (/^\s*BEGIN\s+IMMEDIATE\s*;?\s*$/i.test(sql)) handle.active = true;
      if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) handle.active = false;
      return result;
    };
    return db;
  },
});
