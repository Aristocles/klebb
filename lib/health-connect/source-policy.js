// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { CREDENTIALS_DIR, DB_FILE } = require('../../config/paths');
const schema = require('./schema');
const { decodeJson, decodeMessage, validateObjectDeclaration, HARD_LIMITS, payloadDigest } = require('./protocol');
const { HistoryError } = require('./history');
const CATEGORIES = new Set(require('../../config/health-connect-categories.json'));
const FILE = path.join(CREDENTIALS_DIR, 'health-connect-policy.json');
const LEGACY = path.join(CREDENTIALS_DIR, 'health-connect.json');
const LOCK = FILE + '.lock';
const MAX = 9223372036854775807n;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const actors = new WeakMap(), registrations = new WeakMap(), custodians = new WeakMap();
const scopes = new WeakMap(), admissions = new WeakMap();
let journal = null;
let serializerActive = false, preserveLock = false;

class PolicyError extends HistoryError {}
const deny = (code = 'IMPORT_SOURCE_POLICY_UNKNOWN', status = 409) => {
  throw new PolicyError(status, code);
};
const storage = () => deny('storage-unavailable', 503);
const recovery = () => deny('IMPORT_SOURCE_POLICY_RECOVERY_REQUIRED', 503);
const capability = () => deny('IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED');
const exact = (o, fields) => o && typeof o === 'object' && !Array.isArray(o) &&
  Object.keys(o).length === fields.length && fields.every(k => Object.hasOwn(o, k));
const uuid = v => typeof v === 'string' && UUID.test(v);
const uint = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= MAX;
const id = v => typeof v === 'string' && v.length > 0 && [...v].length <= 256 &&
  !/[\uD800-\uDFFF]/u.test(v);
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const nullableTime = v => v === null || time(v);
const categoryList = v => Array.isArray(v) && v.length > 0 && v.length <= 128 &&
  v.every(t => CATEGORIES.has(t)) && new Set(v).size === v.length;
const name = v => typeof v === 'string' && v === v.trim() && [...v].length > 0 &&
  [...v].length <= 80 && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
const legacyName = v => typeof v === 'string' && v.trim().length > 0 &&
  [...v].length <= 80 && !/[\u0000-\u001f\u007f]/u.test(v);
const clone = v => JSON.parse(JSON.stringify(v));
const opaque = (map, value) => { const token = Object.freeze({}); map.set(token, value); return token; };
const synchronous = v => { if (v && typeof v.then === 'function') storage(); return v; };
const auth = () => require('../../auth/webauthn');
const authority = () => require('./authority');
const history = () => require('./history');

function boundedBytes(filename) {
  let fd;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > HARD_LIMITS.maxBytes) storage();
    fd = fs.openSync(filename, 'r');
    const bytes = Buffer.alloc(HARD_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > HARD_LIMITS.maxBytes) storage();
    return bytes.subarray(0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof HistoryError) throw error;
    storage();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parse(bytes) {
  try { return decodeJson(bytes); } catch { storage(); }
}
function validState(s, nameValidator = name) {
  if (!exact(s, ['version', 'tenantId', 'instanceId', 'restoreEpoch', 'grants', 'connectors']) ||
      s.version !== 1 || ![s.tenantId, s.instanceId, s.restoreEpoch].every(uuid) ||
      !Array.isArray(s.grants) || !Array.isArray(s.connectors) ||
      s.grants.length > 128 || s.connectors.length > 128) return false;
  for (const g of s.grants) {
    if (!exact(g, ['verifier', 'ownerId', 'instanceId', 'sourceStoreId', 'restoreEpoch',
      'categories', 'name', 'expiresAt', 'consumedAt']) || typeof g.verifier !== 'string' || !DIGEST.test(g.verifier) ||
      !id(g.ownerId) || !uuid(g.instanceId) || !uuid(g.sourceStoreId) || !uuid(g.restoreEpoch) ||
      !categoryList(g.categories) || !nameValidator(g.name) || !time(g.expiresAt) ||
      !nullableTime(g.consumedAt)) return false;
  }
  for (const c of s.connectors) {
    if (!exact(c, ['id', 'credentialVerifier', 'ownerId', 'installationId', 'sourceStoreId',
      'restoreEpoch', 'categories', 'generations', 'name', 'createdAt', 'revokedAt']) ||
      !uuid(c.id) || typeof c.credentialVerifier !== 'string' || !DIGEST.test(c.credentialVerifier) || !id(c.ownerId) ||
      !id(c.installationId) || !uuid(c.sourceStoreId) || !uuid(c.restoreEpoch) ||
      !categoryList(c.categories) || !exact(c.generations, c.categories) ||
      !Object.values(c.generations).every(uint) || !nameValidator(c.name) || !time(c.createdAt) ||
      !nullableTime(c.revokedAt)) return false;
  }
  return new Set(s.grants.map(g => g.verifier)).size === s.grants.length &&
    new Set(s.connectors.map(c => c.credentialVerifier)).size === s.connectors.length &&
    new Set(s.connectors.map(c => c.id)).size === s.connectors.length;
}
function validateCatalogue(cat) {
  if (!exact(cat, ['version', 'recoveryRequired', 'principals', 'namespaces']) ||
      cat.version !== 2 || typeof cat.recoveryRequired !== 'boolean' ||
      !Array.isArray(cat.principals) || !Array.isArray(cat.namespaces) ||
      cat.principals.length > 128 || cat.namespaces.length > 128) storage();
  const owners = new Set(), members = new Set(), tenants = new Set(), verifiers = new Set();
  let memberCount = 0, grants = 0, connectors = 0;
  for (const p of cat.principals) {
    if (!exact(p, ['ownerId', 'members']) || !uuid(p.ownerId) || owners.has(p.ownerId) ||
        !Array.isArray(p.members) || !p.members.length || p.members.length > 128) storage();
    owners.add(p.ownerId);
    for (const m of p.members) {
      if (!exact(m, ['userId', 'credentialId', 'publicKeySha256']) ||
          !id(m.userId) || !id(m.credentialId) || !DIGEST.test(m.publicKeySha256)) storage();
      const key = JSON.stringify([m.userId, m.credentialId, m.publicKeySha256]);
      if (members.has(key) || ++memberCount > 128) storage();
      members.add(key);
    }
  }
  for (const n of cat.namespaces) {
    if (!exact(n, ['ownerId', 'state']) || !owners.has(n.ownerId) || !validState(n.state) ||
        tenants.has(n.state.tenantId)) storage();
    tenants.add(n.state.tenantId);
    for (const entry of [...n.state.grants, ...n.state.connectors]) {
      if (entry.ownerId !== n.ownerId || entry.restoreEpoch !== n.state.restoreEpoch ||
          (entry.instanceId !== undefined && entry.instanceId !== n.state.instanceId)) storage();
      const verifier = entry.verifier || entry.credentialVerifier;
      if (verifiers.has(verifier)) storage();
      verifiers.add(verifier);
    }
    grants += n.state.grants.length; connectors += n.state.connectors.length;
  }
  if (grants > 128 || connectors > 128) storage();
  return cat;
}
function readCatalogue(allowRecovery = false) {
  if (!serializerActive && fs.existsSync(LOCK)) recovery();
  const bytes = boundedBytes(FILE);
  if (!bytes) return null;
  const cat = validateCatalogue(clone(parse(bytes)));
  if (cat.recoveryRequired && !allowRecovery) recovery();
  return cat;
}
function legacyState() {
  const bytes = boundedBytes(LEGACY);
  if (!bytes) return null;
  const state = parse(bytes);
  if (!validState(state, legacyName)) storage();
  return state;
}
function currentCatalogue() { return journal ? journal.cat : readCatalogue(); }
function atomicBytes(bytes) {
  const temp = FILE + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, FILE);
    if (process.platform !== 'win32') {
      const dir = fs.openSync(CREDENTIALS_DIR, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') storage(); }
  }
}
function persist(cat) {
  validateCatalogue(cat);
  const bytes = Buffer.from(JSON.stringify(cat));
  if (bytes.length > HARD_LIMITS.maxBytes) storage();
  atomicBytes(bytes);
}
function serialized(work) {
  let fd;
  try {
    fd = fs.openSync(LOCK, 'wx', 0o600);
    fs.fsyncSync(fd);
    serializerActive = true;
    preserveLock = false;
    return synchronous(work());
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    storage();
  } finally {
    if (fd !== undefined) {
      serializerActive = false;
      try { fs.closeSync(fd); }
      catch { preserveLock = true; recovery(); }
      if (!preserveLock) fs.unlinkSync(LOCK);
    }
  }
}
function publicKey(value) {
  let bytes;
  if (value instanceof Uint8Array) bytes = Buffer.from(value);
  else if (typeof value === 'string') {
    bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) storage();
  } else storage();
  if (!bytes.length || bytes.length > 8192) storage();
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
function savedMembers() {
  const data = auth().loadCredentials();
  if (!data || !data.users || typeof data.users !== 'object' || Array.isArray(data.users)) storage();
  const result = [], seen = new Set();
  for (const [userId, user] of Object.entries(data.users)) {
    if (!id(userId) || !user || !Array.isArray(user.credentials)) storage();
    for (const c of user.credentials) {
      if (!id(c.id) || seen.has(c.id)) storage();
      seen.add(c.id);
      result.push({ userId, credentialId: c.id, publicKeySha256: publicKey(c.publicKey) });
    }
  }
  return result;
}
const sameMember = (a, b) => a.userId === b.userId && a.credentialId === b.credentialId &&
  a.publicKeySha256 === b.publicKeySha256;
function principalFor(member, cat) {
  const found = (cat?.principals || []).filter(p => p.members.some(m => sameMember(m, member)));
  if (found.length > 1) storage();
  return found[0] || null;
}
function livePrincipal(ownerId, cat) {
  const principal = cat?.principals.find(p => p.ownerId === ownerId);
  if (!principal || !principal.members.some(m => savedMembers().some(c => sameMember(c, m)))) {
    deny('unauthorised', 401);
  }
  return principal;
}
function identity(req) {
  const cookie = /(?:^|;\s*)klebb_session=([^;]+)/.exec(req?.headers?.cookie || '')?.[1];
  const session = auth().getSessionRecord(req);
  if (!cookie || !session || !id(session.userId) || !id(session.credentialId) ||
      !Number.isFinite(session.created)) deny('unauthorised', 401);
  const member = savedMembers().find(m => m.userId === session.userId &&
    m.credentialId === session.credentialId);
  if (!member) deny('unauthorised', 401);
  return { cookie, created: session.created, member };
}
function selectedDatabaseIdentity() {
  try {
    const stat = fs.lstatSync(DB_FILE, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) storage();
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof HistoryError) throw error;
    storage();
  }
}
function checkIdentity(meta, hc = meta.hc) {
  if (hc) authority().checkPolicyLifecycle(meta.req);
  const fresh = identity(meta.req);
  if (fresh.cookie !== meta.identity.cookie || fresh.created !== meta.identity.created ||
      !sameMember(fresh.member, meta.identity.member)) deny('scope-mismatch', 403);
  if (hc && meta.databaseRequired) {
    if (!meta.databaseIdentity) storage();
    const current = selectedDatabaseIdentity();
    if (!current) storage();
    if (current.dev !== meta.databaseIdentity.dev || current.ino !== meta.databaseIdentity.ino) {
      deny('binding-mismatch');
    }
  }
  return fresh.member;
}
function checkActor(meta) {
  checkIdentity(meta);
  const owner = principalFor(meta.identity.member, currentCatalogue())?.ownerId || null;
  if (owner !== meta.ownerId) deny('scope-mismatch', 403);
  return meta;
}
function captureActor(req) {
  authority().checkPolicyLifecycle(req);
  const captured = identity(req), cat = readCatalogue();
  return opaque(actors, { req, identity: captured, hc: true,
    databaseRequired: cat !== null,
    databaseIdentity: cat ? selectedDatabaseIdentity() : null,
    ownerId: principalFor(captured.member, cat)?.ownerId || null });
}
function resolveBrowser(req) {
  const actor = captureActor(req), meta = actors.get(actor);
  return { actor, established: meta.ownerId !== null,
    ownerId: meta.ownerId || meta.identity.member.userId, check: () => checkActor(meta) };
}
function captureRegistrationActor(req) {
  let captured;
  try { captured = identity(req); } catch (e) {
    if (e instanceof HistoryError && e.status === 401) return null;
    throw e;
  }
  const cat = readCatalogue();
  return opaque(registrations, { req, identity: captured, hc: false,
    ownerId: principalFor(captured.member, cat)?.ownerId || null });
}
function verifyRegistrationActor(custody, req) {
  if (custody === null) return;
  const meta = registrations.get(custody);
  if (!meta) deny('scope-mismatch', 403);
  checkActor({ ...meta, req });
}
function bindRegisteredCredential(custody, req, credential) {
  if (custody === null) return;
  verifyRegistrationActor(custody, req);
  const meta = { ...registrations.get(custody), req };
  if (!meta.ownerId) return;
  if (!credential || !id(credential.id)) deny('scope-mismatch', 403);
  const expected = { userId: meta.identity.member.userId, credentialId: credential.id,
    publicKeySha256: publicKey(credential.publicKey) };
  if (!savedMembers().some(m => sameMember(m, expected))) deny('scope-mismatch', 403);
  return serialized(() => {
    checkActor(meta);
    const cat = readCatalogue(), principal = livePrincipal(meta.ownerId, cat);
    const previous = principalFor(expected, cat);
    if (previous && previous.ownerId !== meta.ownerId) deny('scope-mismatch', 403);
    history().readHistorySnapshot(db => catalogueClosure(db, cat));
    if (previous) return;
    const gate = clone(cat); gate.recoveryRequired = true;
    try {
      persist(gate);
      principal.members.push(expected);
      persist(cat);
    } catch {
      // A rename may already have published the association. Do not claim
      // rollback or allow the uncertain member to acquire policy custody.
      try { persist(gate); } catch { preserveLock = true; }
      recovery();
    }
  });
}
function family(db) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE lower(name) GLOB 'health_source_policy_*' "
    + "OR lower(tbl_name) GLOB 'health_source_policy_*' LIMIT 1").get() !== undefined;
}
function validFamily(db) {
  if (!family(db)) deny();
  schema.validateSourcePolicySchema(db, () => deny());
}
function hasPolicyFamily() {
  let db;
  try {
    if (!fs.existsSync(DB_FILE)) return false;
    const stat = fs.lstatSync(DB_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) storage();
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    return family(db);
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    storage();
  } finally { if (db) db.close(); }
}

// A UUID candidate must exclude every retained SQL/file identity. This is a
// collision check inside the owning writer, never evidence of principal birth.
function retainedIds(db, cat) {
  const ids = new Set();
  const collect = (value, key = '', depth = 0) => {
    if (depth > HARD_LIMITS.maxDepth) deny();
    if (Array.isArray(value)) { value.forEach(v => collect(v, key, depth + 1)); return; }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) collect(v, k, depth + 1);
      return;
    }
    if (typeof value === 'string' && uuid(value)) ids.add(value);
    if (/^(tenantId|logicalTenantId|instanceId|sourceStoreId|restoreEpoch|ownerId|policyId)$/.test(key) &&
        !id(value)) deny();
  };
  collect(cat);
  const legacy = legacyState();
  if (legacy) collect(legacy);
  const known = { ...schema.nativeTables, ...schema.objectTables, ...schema.sourceIndexTables,
    ...schema.restorePublicationTables, ...schema.sourcePolicyTables,
    health_deletion_guards: schema.guardV2 };
  const found = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE "
    + "lower(name) GLOB 'health_*' OR lower(tbl_name) GLOB 'health_*'").all();
  const tables = found.filter(row => row.type === 'table');
  for (const row of tables) {
    let expected = known[row.name];
    if (Object.hasOwn(schema.sourcePolicyTables, row.name) &&
        schema.sourcePolicySchemaVersion(db, () => deny()) === 2) {
      expected = schema.sourcePolicyTablesV2[row.name];
    }
    if (row.name === 'health_schema_version' && row.sql === schema.markerV2) expected = schema.markerV2;
    if (!expected || row.sql !== expected) deny();
    const rows = db.prepare(`SELECT * FROM "${row.name}"`).all();
    for (const saved of rows) {
      for (const [column, value] of Object.entries(saved)) {
        if (value === null) continue;
        if (column === 'stream_key' || column === 'source_stream_key') {
          const fields = parse(Buffer.from(value));
          if (!Array.isArray(fields) || fields.length !== 7 || !fields.every(v => typeof v === 'string') ||
              !uuid(fields[0]) || !uuid(fields[1]) || !uuid(fields[2]) || !id(fields[3]) ||
              !CATEGORIES.has(fields[4]) || !uint(fields[5]) || !uuid(fields[6])) deny();
          collect(fields);
        } else if (column.endsWith('_json')) {
          if (typeof value !== 'string') deny();
          const decoded = parse(Buffer.from(value));
          if (!decoded || typeof decoded !== 'object') deny();
          collect(decoded);
        } else if (/^(tenant_id|instance_id|source_store_id|restore_epoch|owner_id|policy_id|epoch)$/.test(column)) {
          if (!id(value)) deny();
          if (uuid(value)) ids.add(value);
        }
        // Native IDs, batch IDs and other scalar retained identity columns can
        // be UUIDs even when no raw record or declaration JSON is present.
        if (typeof value === 'string' && uuid(value)) ids.add(value);
      }
    }
  }
  for (const group of [schema.objectTables, schema.sourceIndexTables, schema.restorePublicationTables]) {
    const present = Object.keys(group).filter(n => tables.some(t => t.name === n));
    if (present.length && present.length !== Object.keys(group).length) deny();
  }
  // Accept only the exact indexes owned by the existing history/object writers.
  const indexes = {
    health_receipt_sequence_order: {
      table: 'health_batch_receipts',
      sql: 'CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)',
    },
    health_object_expiry: {
      table: 'health_object_staging',
      sql: 'CREATE INDEX health_object_expiry ON health_object_staging (expires_at)',
    },
  };
  for (const row of found) {
    if (row.type === 'table') continue;
    if (row.type === 'index' && row.sql === null && row.name.startsWith('sqlite_autoindex_')) continue;
    const index = indexes[row.name];
    if (row.type === 'index' && index && row.tbl_name === index.table && row.sql === index.sql) continue;
    deny();
  }
  return ids;
}
function allocate(ids) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = crypto.randomUUID();
    if (!uuid(candidate)) storage();
    if (!ids.has(candidate)) { ids.add(candidate); return candidate; }
  }
  deny('limit-exceeded');
}
function policyRows(db) {
  return Object.fromEntries(Object.keys(schema.sourcePolicyTables).map(n =>
    [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all().map(r => ({ ...r }))]));
}
function rollbackObserved(before, expectedDatabase) {
  let db;
  try {
    const current = selectedDatabaseIdentity();
    if (!current || !expectedDatabase || current.dev !== expectedDatabase.dev ||
        current.ino !== expectedDatabase.ino) return false;
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    db.exec('BEGIN');
    // A rolled-back initial family is absent, never an empty COMPLETE scope.
    if (before === null) return !family(db);
    validFamily(db);
    return JSON.stringify(policyRows(db)) === JSON.stringify(before);
  } catch { return false; }
  finally { if (db) { try { db.close(); } catch {} } }
}
function projectedTransaction(cat, work, recheck, initialiseFamily = false) {
  const original = boundedBytes(FILE);
  const databaseIdentity = selectedDatabaseIdentity();
  const gate = clone(cat); gate.recoveryRequired = true;
  let returned = false, published = false, before, result;
  journal = { cat };
  try {
    result = history().withHistoryTransaction(db => {
      const createdFamily = initialiseFamily && !family(db);
      if (createdFamily) {
        // Only genuine forward enrolment may introduce the exact family.
        // Retained catalogue loss and partial schemas remain fail closed.
        if (original || cat.principals.length || cat.namespaces.length) deny();
        for (const sql of Object.values(schema.sourcePolicyTables)) db.exec(sql);
      }
      validFamily(db);
      catalogueClosure(db, cat);
      // A V2 family without its private catalogue cannot establish a new logical scope.
      if (schema.sourcePolicySchemaVersion(db, () => deny()) === 2 && !original) deny();
      before = createdFamily ? null : policyRows(db);
      persist(gate);
      published = true;
      const value = synchronous(work(db));
      if (initialiseFamily) {
        Object.assign(gate, clone(cat));
        gate.recoveryRequired = true;
        persist(gate);
      }
      recheck();
      returned = true;
      return value;
    });
    cat.recoveryRequired = false;
    persist(cat);
    return result;
  } catch (error) {
    if (!published) throw error;
    if (!returned && before !== undefined && rollbackObserved(before, databaseIdentity)) {
      try {
        if (original) atomicBytes(original);
        else fs.unlinkSync(FILE);
      } catch { preserveLock = true; recovery(); }
      throw error;
    }
    // Once the callback returned, COMMIT or a later close can have succeeded.
    // Keep the durable denial gate; do not claim rollback or repeat the work.
    try { persist(gate); }
    catch {
      // The original mutex was created before the durable gate and SQL work.
      // Retain it as a cross-process quarantine if gate publication is uncertain.
      preserveLock = true;
    }
    recovery();
  } finally { journal = null; }
}
function mintScope(db, mode, meta, namespace, work) {
  const scope = opaque(scopes, { db, mode, actor: meta, namespace, live: true });
  try { return synchronous(work(scope)); }
  finally { scopes.get(scope).live = false; scopes.delete(scope); }
}
function checkedScope(scope, mode) {
  const meta = scopes.get(scope);
  if (!meta || !meta.live || (mode && meta.mode !== mode)) capability();
  if (meta.actor) checkActor(meta.actor);
  validFamily(meta.db);
  return meta;
}
function namespaceFor(cat, ownerId, tenantId) {
  const entry = cat?.namespaces.find(n => n.ownerId === ownerId && n.state.tenantId === tenantId);
  if (!entry) deny('scope-mismatch', 403);
  return entry;
}
function namespaceAuthority(actor, tenantId) {
  const meta = actors.get(actor);
  if (!meta) capability();
  checkActor(meta);
  if (!meta.ownerId) deny('scope-mismatch', 403);
  const entry = namespaceFor(readCatalogue(), meta.ownerId, tenantId);
  return opaque(custodians, { kind: 'actor', actor: meta, ownerId: meta.ownerId,
    tenantId: entry.state.tenantId });
}
function readNamespaces() {
  const cat = readCatalogue();
  if (!cat) {
    if (hasPolicyFamily()) history().readHistorySnapshot(db => catalogueClosure(db,
      { version: 2, recoveryRequired: false, principals: [], namespaces: [] }));
    return null;
  }
  history().readHistorySnapshot(db => catalogueClosure(db, cat));
  return clone(cat.namespaces);
}
function readSourceBoundaries() {
  const cat = readCatalogue();
  if (!cat) {
    if (hasPolicyFamily()) history().readHistorySnapshot(db => catalogueClosure(db,
      { version: 2, recoveryRequired: false, principals: [], namespaces: [] }));
    return null;
  }
  return history().readHistorySnapshot(db => catalogueClosure(db, cat).map(current => ({
    tenantId: current.tenantId, restoreEpoch: current.epoch,
    sources: current.sources.map(source => ({ sourceStoreId: source.sourceStoreId,
      ownerId: current.ownerId })),
  })).sort((a, b) => a.tenantId.localeCompare(b.tenantId)));
}
function catalogueClosure(db, cat) {
  validFamily(db);
  validateCatalogue(cat);
  // The SQL-to-catalogue join includes retained and retired scopes. Missing
  // custody must refuse; it cannot be reconstructed from the retained rows.
  const retained = db.prepare('SELECT tenant_id,owner_id FROM health_source_policy_state').all();
  if (retained.length !== cat.namespaces.length || retained.some(row =>
    !cat.namespaces.some(n => n.state.tenantId === row.tenant_id && n.ownerId === row.owner_id))) deny();
  for (const table of ['health_source_policy_sources', 'health_source_policy_categories']) {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      const entry = cat.namespaces.find(n => n.state.tenantId === row.tenant_id);
      if (!entry || (row.owner_id !== undefined && row.owner_id !== entry.ownerId)) deny();
    }
  }
  // Historical principal members stay represented after credential deletion.
  // Structural retention is separate from authenticating a selected member.
  return cat.namespaces.map(entry => closedSnapshot(db, entry));
}
function checkCustody(meta, cat) {
  const entry = namespaceFor(cat, meta.ownerId, meta.tenantId);
  livePrincipal(meta.ownerId, cat);
  if (meta.actor) checkActor(meta.actor);
  if (meta.kind === 'grant') {
    const g = entry.state.grants.find(item => item.verifier === meta.verifier);
    if (!g) deny('unauthorised', 401);
    if (g.consumedAt !== null) deny('conflict', 409);
    if (Date.parse(g.expiresAt) <= Date.now()) deny('expired-grant', 410);
  }
  return entry;
}
function captureGrant(secret) {
  if (typeof secret !== 'string') deny('unauthorised', 401);
  const verifier = payloadDigest(secret), cat = readCatalogue();
  const matches = (cat?.namespaces || []).filter(n => n.state.grants.some(g => g.verifier === verifier));
  if (matches.length !== 1) deny('unauthorised', 401);
  const n = matches[0], meta = { kind: 'grant', ownerId: n.ownerId, tenantId: n.state.tenantId, verifier };
  checkCustody(meta, cat);
  return opaque(custodians, meta);
}
function updateNamespace(custody, work) {
  const meta = custodians.get(custody);
  if (!meta) capability();
  return serialized(() => {
    const cat = readCatalogue(), entry = checkCustody(meta, cat);
    history().readHistorySnapshot(db => catalogueClosure(db, cat));
    const state = clone(entry.state), value = synchronous(work(state));
    if (state.tenantId !== entry.state.tenantId || state.instanceId !== entry.state.instanceId ||
        state.restoreEpoch !== entry.state.restoreEpoch) deny('binding-mismatch');
    // Recheck against the retained state before publishing a consumed grant.
    checkCustody(meta, cat);
    entry.state = state;
    history().readHistorySnapshot(db => catalogueClosure(db, cat));
    persist(cat);
    return value === undefined ? clone(state) : value;
  });
}
function assertNamespaceCredential(state, connector) {
  const cat = readCatalogue();
  const entry = cat?.namespaces.find(n => n.state.tenantId === state?.tenantId);
  if (!entry || JSON.stringify(entry.state) !== JSON.stringify(state) ||
      !entry.state.connectors.some(c => JSON.stringify(c) === JSON.stringify(connector)) ||
      connector.revokedAt !== null) deny('unauthorised', 401);
  livePrincipal(entry.ownerId, cat);
}
function enrolStopped(req, categories, options, capturedActor) {
  if (!categoryList(categories)) deny('invalid-message', 400);
  const actor = capturedActor === undefined ? captureActor(req) : capturedActor;
  const meta = actors.get(actor);
  if (!meta || meta.req !== req) capability();
  let custody;
  if (options !== undefined) {
    if (!exact(options, ['namespaceAuthority', 'expected'])) capability();
    custody = custodians.get(options.namespaceAuthority);
    if (!custody || custody.kind !== 'actor' || !custody.actor) capability();
    checkActor(custody.actor);
    if (custody.actor.req !== req || custody.ownerId !== meta.ownerId) deny('scope-mismatch', 403);
    if (!exact(options.expected, ['epoch', 'revision']) ||
        !uuid(options.expected.epoch) || !uint(options.expected.revision)) deny('binding-mismatch');
  }
  return serialized(() => {
    checkActor(meta);
    const cat = readCatalogue() || { version: 2, recoveryRequired: false, principals: [], namespaces: [] };
    if (!custody && cat.namespaces.length >= 128) deny('limit-exceeded');
    if (!meta.databaseRequired) {
      meta.databaseIdentity = selectedDatabaseIdentity();
      if (!meta.databaseIdentity) storage();
      meta.databaseRequired = true;
    }
    let enrolled;
    projectedTransaction(cat, db => {
      checkIdentity(meta);
      catalogueClosure(db, cat);
      let principal, tenantId, instanceId, restoreEpoch, sourceCount, revision;
      if (custody) {
        const entry = checkCustody(custody, cat), current = closedSnapshot(db, entry);
        if (options.expected.epoch !== current.epoch || options.expected.revision !== current.revision) {
          deny('binding-mismatch');
        }
        if (current.sourceCount >= 128 ||
            current.sources.reduce((count, source) => count + source.categoryCount, 0) + categories.length > 128 ||
            BigInt(current.revision) === MAX) deny('limit-exceeded');
        principal = livePrincipal(custody.ownerId, cat);
        ({ tenantId, instanceId, restoreEpoch } = entry.state);
        sourceCount = current.sourceCount + 1;
        revision = String(BigInt(current.revision) + 1n);
      } else {
        sourceCount = 1;
        revision = '1';
      }
      const ids = retainedIds(db, cat);
      if (!custody) {
        principal = principalFor(meta.identity.member, cat);
        if (!principal) {
          if (cat.principals.length >= 128) deny('limit-exceeded');
          principal = { ownerId: allocate(ids), members: [clone(meta.identity.member)] };
          cat.principals.push(principal);
        }
        tenantId = allocate(ids); instanceId = allocate(ids); restoreEpoch = allocate(ids);
        const state = { version: 1, tenantId, instanceId, restoreEpoch, grants: [], connectors: [] };
        cat.namespaces.push({ ownerId: principal.ownerId, state });
        db.prepare('INSERT INTO health_source_policy_state '
          + '(version,tenant_id,owner_id,epoch,revision,knowledge,source_count) VALUES (?,?,?,?,?,?,0)')
          .run(schema.sourcePolicySchemaVersion(db, () => deny()), tenantId, principal.ownerId,
            restoreEpoch, '0', 'COMPLETE');
      }
      const sourceStoreId = allocate(ids), policyId = allocate(ids);
      db.prepare('INSERT INTO health_source_policy_sources '
        + '(tenant_id,source_store_id,owner_id,policy_id,lifecycle,knowledge,retain_committed_history,category_count,reconciled_epoch) '
        + "VALUES (?,?,?,?, 'active','COMPLETE',1,?,NULL)")
        .run(tenantId, sourceStoreId, principal.ownerId, policyId, categories.length);
      const insert = db.prepare('INSERT INTO health_source_policy_categories '
        + "(tenant_id,source_store_id,record_type,sharing,generation) VALUES (?,?,?,'stopped','1')");
      for (const type of categories) insert.run(tenantId, sourceStoreId, type);
      db.prepare('UPDATE health_source_policy_state SET source_count=?,revision=? WHERE tenant_id=? AND owner_id=?')
        .run(sourceCount, revision, tenantId, principal.ownerId);
      enrolled = { ownerId: principal.ownerId, tenantId, instanceId, restoreEpoch, sourceStoreId,
        generations: Object.fromEntries(categories.map(t => [t, '1'])) };
    }, () => checkIdentity(meta), true);
    meta.ownerId = enrolled.ownerId;
    enrolled.namespaceAuthority = namespaceAuthority(actor, enrolled.tenantId);
    return enrolled;
  });
}
function withWriteAuthority(actor, work, options = {}) {
  const meta = actors.get(actor);
  if (!meta) capability();
  checkActor(meta);
  return serialized(() => {
    checkActor(meta);
    const cat = readCatalogue(), entry = namespaceFor(cat, meta.ownerId, options.tenantId);
    return projectedTransaction(cat, db => {
      catalogueClosure(db, cat);
      return mintScope(db, 'write', meta, entry, scope => {
      // Validate the closed source registry before exposing any mutation API.
      snapshot(scope);
      const result = synchronous(work(scope));
      const current = snapshot(scope);
      for (const c of entry.state.connectors) {
        const s = current.sources.find(v => v.sourceStoreId === c.sourceStoreId);
        if (!s) deny();
        for (const type of c.categories) {
          const category = s.categories.find(v => v.recordType === type);
          if (!category) deny();
          c.generations[type] = category.generation;
        }
      }
      return result;
      });
    }, () => checkActor(meta));
  });
}
function withReadAuthority(actor, work, options = {}) {
  if (options.ownerWide === true) {
    const meta = actors.get(actor);
    if (!meta) capability();
    checkActor(meta);
    return serialized(() => {
      checkActor(meta);
      const catalogueBytes = boundedBytes(FILE);
      if (!catalogueBytes) storage();
      const cat = validateCatalogue(clone(parse(catalogueBytes)));
      if (cat.recoveryRequired) recovery();
      const owned = cat.namespaces.filter(n => n.ownerId === meta.ownerId)
        .sort((a, b) => a.state.tenantId < b.state.tenantId ? -1 : a.state.tenantId > b.state.tenantId ? 1 : 0);
      if (!owned.length || owned.length > 128) deny('limit-exceeded');
      const entry = namespaceFor(cat, meta.ownerId, options.tenantId === undefined
        ? owned[0].state.tenantId : options.tenantId);
      return history().readHistorySnapshot(db => {
        // Versioned policy closure is history, never an activation grant.
        // Every foreign row is bounded before global closure materializes it.
        const policyVersion = schema.sourcePolicySchemaVersion(db, () => deny());
        if (![1, 2].includes(policyVersion)) deny();
        const marker = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='health_schema_version'").get()?.sql;
        const nativeVersion = marker === schema.nativeTables.health_schema_version ? 1 : marker === schema.markerV2 ? 2 : 0;
        if (!nativeVersion) deny();
        const policyTables = policyVersion === 2 ? schema.sourcePolicyTablesV2 : schema.sourcePolicyTables;
        const declared = { ...schema.nativeTables, ...policyTables };
        declared.health_schema_version = nativeVersion === 2 ? schema.markerV2 : schema.nativeTables.health_schema_version;
        if (nativeVersion === 2) declared.health_deletion_guards = schema.guardV2;
        const objects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema').all();
        const present = new Set(objects.filter(row => row.type === 'table').map(row => row.name));
        for (const family of [schema.objectTables, schema.sourceIndexTables, schema.restorePublicationTables]) {
          const names = Object.keys(family), found = names.filter(name => present.has(name));
          if (found.length && found.length !== names.length) deny();
          if (found.length) Object.assign(declared, family);
        }
        const legacyNames = new Set(['schema_version', 'cards', 'rows', 'hae_pushes', 'hae_samples']);
        if ([...present].some(name => !name.startsWith('sqlite_') &&
            !Object.hasOwn(declared, name) && !legacyNames.has(name))) deny();
        const indexes = {
          health_receipt_sequence_order: ['health_batch_receipts',
            'CREATE INDEX health_receipt_sequence_order ON health_batch_receipts (stream_key, length(sequence), sequence)'],
          health_object_expiry: ['health_object_staging',
            'CREATE INDEX health_object_expiry ON health_object_staging (expires_at)'],
        };
        for (const row of objects) {
          if (!row.name.toLowerCase().startsWith('health_') && !row.tbl_name.toLowerCase().startsWith('health_')) continue;
          if (row.type === 'table' && row.name === row.tbl_name && declared[row.name] === row.sql) continue;
          if (row.type === 'index' && row.sql === null && Object.hasOwn(declared, row.tbl_name) &&
              row.name.startsWith(`sqlite_autoindex_${row.tbl_name}_`)) continue;
          const index = indexes[row.name];
          if (row.type === 'index' && index && row.tbl_name === index[0] && row.sql === index[1]) continue;
          deny();
        }
        // Refuse an unrepresented nonempty object family, never omit it.
        for (const table of Object.keys(schema.objectTables)) if (present.has(table) &&
            db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) deny();
        const maxRetainedRows = Math.floor((HARD_LIMITS.maxBytes - 4096) / 512);
        let auxiliaryRows = 0, auxiliaryTextBytes = 0;
        const auxiliary = new Map();
        for (const table of [...Object.keys(schema.sourceIndexTables), ...Object.keys(schema.restorePublicationTables)]) {
          if (!present.has(table)) continue;
          const count = db.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM "${table}" LIMIT ?)`).get(maxRetainedRows + 1).count;
          if (!Number.isSafeInteger(count) || count < 0 || count > maxRetainedRows) deny('limit-exceeded');
          auxiliaryRows += count;
          const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
          const fields = columns.filter(column => column.type === 'TEXT');
          const invalid = columns.map(column => {
            const value = `"${column.name}"`;
            const test = column.type === 'TEXT'
              ? `(typeof(${value}) != 'text' OR length(CAST(${value} AS BLOB)) > ${HARD_LIMITS.maxBytes})`
              : `(typeof(${value}) != 'integer' OR abs(${value}) > 9007199254740991)`;
            return column.notnull ? test : `(${value} IS NOT NULL AND ${test})`;
          }).join(' OR ');
          if (db.prepare(`SELECT 1 AS invalid FROM "${table}" WHERE ${invalid} LIMIT 1`).get()) deny();
          const lengths = fields.map(column => `COALESCE(length(CAST("${column.name}" AS BLOB)),0)`).join(' + ');
          const bytes = db.prepare(`SELECT COALESCE(SUM(${lengths}),0) AS bytes FROM "${table}"`).get().bytes;
          if (!Number.isSafeInteger(bytes) || bytes < 0) deny('limit-exceeded');
          auxiliaryTextBytes += bytes;
          if (4096 + 512 * auxiliaryRows + 12 * auxiliaryTextBytes > HARD_LIMITS.maxBytes) deny('limit-exceeded');
          const raw = fields.map(column => `CAST("${column.name}" AS BLOB) AS "__raw_${column.name}"`).join(', ');
          const rows = db.prepare(`SELECT *, ${raw} FROM "${table}"`).all();
          for (const row of rows) for (const column of fields) {
            const value = row[column.name], bytes = row[`__raw_${column.name}`];
            if (value === null) { if (bytes !== null) deny(); }
            else if (!(bytes instanceof Uint8Array) || !Buffer.from(value, 'utf8').equals(Buffer.from(bytes))) deny();
            delete row[`__raw_${column.name}`];
          }
          auxiliary.set(table, rows);
        }
        for (const [table, sql] of Object.entries(schema.nativeTables)) {
          const expected = table === 'health_schema_version' && nativeVersion === 2 ? schema.markerV2 : sql;
          if (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql !== expected) deny();
        }
        const versions = db.prepare('SELECT version FROM health_schema_version').all();
        if (versions.length !== 1 || versions[0].version !== nativeVersion) deny();
        if (nativeVersion === 2 && db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='health_deletion_guards'").get()?.sql !== schema.guardV2) deny();
        const retainedFields = [
          ['health_records', ['tenant_id', 'source_store_id', 'record_type', 'native_record_id',
            'serializer_id', 'data_family', 'projection', 'record_json']],
          ['health_streams', ['stream_key', 'record_type', 'acknowledged_sequence']],
          ['health_batch_receipts', ['stream_key', 'sequence', 'batch_id', 'payload_digest', 'receipt_json']],
          ['health_projection_outbox', ['stream_key', 'sequence', 'batch_id', 'payload_digest', 'state']],
          ['health_tombstones', ['tenant_id', 'source_store_id', 'record_type', 'native_record_id', 'stream_key', 'sequence']],
        ];
        if (nativeVersion === 2) retainedFields.push(['health_deletion_guards',
          ['tenant_id', 'source_store_id', 'record_type', 'native_record_id', 'source_stream_key', 'source_sequence', 'footprint_json']]);
        let retainedRows = 0, retainedTextBytes = 0;
        for (const [table, fields] of retainedFields) {
          const count = db.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM "${table}" LIMIT ?)`).get(maxRetainedRows + 1).count;
          if (!Number.isSafeInteger(count) || count < 0 || count > maxRetainedRows) deny('limit-exceeded');
          retainedRows += count;
          if (table === 'health_deletion_guards' && db.prepare(
            `SELECT 1 AS invalid FROM health_deletion_guards WHERE
             typeof(source_deleted) != 'integer' OR typeof(user_suppressed) != 'integer' OR
             NOT (
               (source_deleted = 1 AND user_suppressed IN (0,1) AND source_stream_key IS NOT NULL AND source_sequence IS NOT NULL) OR
               (source_deleted = 0 AND user_suppressed = 1 AND source_stream_key IS NULL AND source_sequence IS NULL)
             ) OR (source_deleted = 1 AND NOT EXISTS (
               SELECT 1 FROM health_tombstones AS tombstone WHERE
                 tombstone.tenant_id = health_deletion_guards.tenant_id AND
                 tombstone.source_store_id = health_deletion_guards.source_store_id AND
                 tombstone.record_type = health_deletion_guards.record_type AND
                 tombstone.native_record_id = health_deletion_guards.native_record_id AND
                 tombstone.stream_key = health_deletion_guards.source_stream_key AND
                 tombstone.sequence = health_deletion_guards.source_sequence
             )) LIMIT 1`
          ).get()) deny();
          const invalid = fields.map(column => {
            const cap = column === 'record_json' ? 16384 : column === 'footprint_json' ? 2048 :
              ['stream_key', 'source_stream_key', 'receipt_json'].includes(column) ? 8192 : 1024;
            const invalidText = `(typeof("${column}") != 'text' OR length(CAST("${column}" AS BLOB)) > ${cap})`;
            return table === 'health_deletion_guards' && ['source_stream_key', 'source_sequence', 'footprint_json'].includes(column)
              ? `("${column}" IS NOT NULL AND ${invalidText})` : invalidText;
          }).join(' OR ');
          if (db.prepare(`SELECT 1 AS invalid FROM "${table}" WHERE ${invalid} LIMIT 1`).get()) deny();
          const lengths = fields.map(column => {
            const length = `length(CAST("${column}" AS BLOB))`;
            return table === 'health_deletion_guards' && ['source_stream_key', 'source_sequence', 'footprint_json'].includes(column)
              ? `COALESCE(${length}, 0)` : length;
          }).join(' + ');
          const bytes = db.prepare(`SELECT COALESCE(SUM(${lengths}), 0) AS bytes FROM "${table}"`).get().bytes;
          if (!Number.isSafeInteger(bytes) || bytes < 0) deny('limit-exceeded');
          retainedTextBytes += bytes;
        }
        if (retainedTextBytes > 65536 || db.prepare("SELECT 1 AS invalid FROM health_records WHERE "
          + "typeof(serializer_version) != 'integer' OR serializer_version != 1 OR "
          + "serializer_id != 'health-connect-record' OR data_family != 'ordinary' OR projection != 'raw-only' LIMIT 1").get()) deny();
        // Scalar guards bound every global row consumed by catalogueClosure,
        // including foreign principals, before any persisted policy TEXT or
        // policy/source/category arrays are materialized.
        const policyFields = [
          ['health_source_policy_state', ['tenant_id', 'owner_id', 'epoch', 'revision', 'knowledge']],
          ['health_source_policy_sources', ['tenant_id', 'source_store_id', 'owner_id', 'policy_id',
            'lifecycle', 'knowledge', 'reconciled_epoch']],
          ['health_source_policy_categories', ['tenant_id', 'source_store_id', 'record_type',
            'sharing', 'generation']],
        ];
        if (policyVersion === 2) policyFields[2][1].push(...readinessFields);
        let policyRows = 0, policyTextBytes = 0;
        for (const [table] of policyFields) {
          const count = db.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM "${table}" LIMIT 129)`).get().count;
          if (!Number.isSafeInteger(count) || count < 0 || count > 128) deny('limit-exceeded');
          policyRows += count;
        }
        for (const [table, fields] of policyFields) {
          const invalid = fields.map(column => {
            const test = `typeof("${column}") != 'text' OR length(CAST("${column}" AS BLOB)) > 1024`;
            return column === 'reconciled_epoch' || readinessFields.includes(column)
              ? `("${column}" IS NOT NULL AND (${test}))` : `(${test})`;
          }).join(' OR ');
          if (db.prepare(`SELECT 1 AS invalid FROM "${table}" WHERE ${invalid} LIMIT 1`).get()) deny();
          const lengths = fields.map(column => `COALESCE(length(CAST("${column}" AS BLOB)), 0)`).join(' + ');
          const bytes = db.prepare(`SELECT COALESCE(SUM(${lengths}), 0) AS bytes FROM "${table}"`).get().bytes;
          if (!Number.isSafeInteger(bytes) || bytes < 0) deny('limit-exceeded');
          policyTextBytes += bytes;
        }
        if (policyTextBytes > 131072 ||
            4096 + 512 * (policyRows + retainedRows + auxiliaryRows) + 12 * (policyTextBytes + retainedTextBytes + auxiliaryTextBytes) > HARD_LIMITS.maxBytes) deny('limit-exceeded');
        // All persisted strings are now bounded. Reject lossy SQLite TEXT
        // decoding before closure parses any retained transport/receipt JSON.
        const retained = new Map();
        for (const [table, fields] of retainedFields) {
          const raw = fields.map(column => `CAST("${column}" AS BLOB) AS "__raw_${column}"`).join(', ');
          const order = ['health_records', 'health_tombstones', 'health_deletion_guards'].includes(table) ? 'tenant_id,source_store_id,record_type,native_record_id' :
            table === 'health_streams' ? 'stream_key' : 'stream_key,sequence';
          const rows = db.prepare(`SELECT *, ${raw} FROM "${table}" ORDER BY ${order}`).all();
          for (const row of rows) for (const column of fields) {
            if (table === 'health_deletion_guards' && ['source_stream_key', 'source_sequence', 'footprint_json'].includes(column) && row[column] === null) {
              if (row[`__raw_${column}`] !== null) deny();
              delete row[`__raw_${column}`];
              continue;
            }
            if (!(row[`__raw_${column}`] instanceof Uint8Array) ||
                !Buffer.from(row[column], 'utf8').equals(Buffer.from(row[`__raw_${column}`]))) deny();
            delete row[`__raw_${column}`];
          }
          retained.set(table, rows);
        }
        catalogueClosure(db, cat);
        const allPolicies = cat.namespaces.map(n => closedSnapshot(db, n));
        // Closure includes every auxiliary identity, including foreign tenants.
        for (const rows of auxiliary.values()) for (const row of rows) {
          const policy = allPolicies.find(value => value.tenantId === row.tenant_id);
          if (!policy || (row.owner_id !== undefined && row.owner_id !== policy.ownerId)) deny();
          const source = row.source_store_id === undefined ? null :
            policy.sources.find(value => value.sourceStoreId === row.source_store_id);
          if (row.source_store_id !== undefined && !source) deny();
          if (row.record_type !== undefined &&
              !source?.categories.some(value => value.recordType === row.record_type)) deny();
          if (row.stream_key !== undefined) {
            const fields = transportTuple(row.stream_key);
            if (fields[0] !== row.tenant_id || fields[2] !== row.source_store_id ||
                fields[4] !== row.record_type) deny();
          }
        }
        // A native row cannot be omitted merely because its principal is not
        // selected. Prove every registered join from this same SQL cut first.
        for (const [table, rows] of retained) for (const row of rows) {
          const fields = table === 'health_records' ||
            (table === 'health_deletion_guards' && row.source_deleted === 0)
            ? [row.tenant_id, null, row.source_store_id, null, row.record_type]
            : transportTuple(row.stream_key ?? row.source_stream_key);
          const policy = allPolicies.find(value => value.tenantId === fields[0]);
          const source = policy?.sources.find(value => value.sourceStoreId === fields[2]);
          if (!source || !source.categories.some(value => value.recordType === fields[4])) deny();
          if (row.record_type !== undefined && row.record_type !== fields[4]) deny();
          // Retained generation, instance and epoch are historical provenance;
          // they are not required to equal current transport/readiness values.
        }
        // Foreign DTOs are validation-only and use each genuine catalogue
        // owner. Validate them first and retain only the requested owner DTO.
        const ownerIds = [...new Set(cat.namespaces.map(n => n.ownerId))]
          .filter(ownerId => ownerId !== meta.ownerId).sort();
        ownerIds.push(meta.ownerId);
        let capture;
        for (const ownerId of ownerIds) {
          const policies = allPolicies.filter(policy => policy.ownerId === ownerId)
            .sort((a, b) => a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
          // This controlled V1 slice requires the existing profile-3 policy
          // shape. Empty sources/categories and revision zero remain unsupported.
          if (!policies.length || policies.some(policy => policy.revision === '0' ||
              !policy.sources.length || policy.sources.some(source => !source.categories.length))) deny();
          let sourceCount = 0, categoryCount = 0;
          for (const policy of policies) {
            sourceCount += policy.sourceCount;
            for (const source of policy.sources) {
              categoryCount += source.categoryCount;
              if (source.categories.some(category => category.generation === '0')) deny();
            }
          }
          if (sourceCount > 128 || categoryCount > 128) deny('limit-exceeded');
          const ownerCapture = {
            catalog: { version: 3, ownerRef: ownerId,
              namespaces: policies.map(policy => ({
                tenantId: policy.tenantId, ownerRef: ownerId, sourceCount: policy.sourceCount,
                sources: policy.sources.map(source => ({ sourceStoreId: source.sourceStoreId,
                  provider: 'health-connect-native', policyRef: source.policyId })),
              })) },
            records: [],
            sourcePolicies: policies.map(policy => ({
              tenantId: policy.tenantId, ownerRef: ownerId, revision: policy.revision,
              sourceCount: policy.sourceCount,
              sources: policy.sources.map(source => ({ sourceStoreId: source.sourceStoreId,
                policyId: source.policyId, lifecycle: source.lifecycle,
                retainCommittedHistory: source.retainCommittedHistory === 1,
                categoryCount: source.categoryCount, categories: clone(source.categories) })),
            })),
            streams: [], receipts: [], projectionOutbox: [], tombstones: [],
            deletionGuards: [], suppressions: [],
          };
          // Projection uses the existing SQL cut; publication readers require
          // different tables and must not open another snapshot here.
          for (const row of retained.get('health_records')) {
            if (!policies.some(policy => policy.tenantId === row.tenant_id)) continue;
            const identity = [row.tenant_id, row.source_store_id, row.record_type, row.native_record_id];
            ownerCapture.records.push({ identity, nativeKeyJson: JSON.stringify(identity),
              serializerId: row.serializer_id, serializerVersion: row.serializer_version,
              dataFamily: row.data_family, projection: row.projection,
              expectedUtf8Bytes: Buffer.byteLength(row.record_json, 'utf8'),
              expectedRecordDigest: 'sha256:' + crypto.createHash('sha256').update(row.record_json, 'utf8').digest('hex'),
              recordJson: row.record_json });
          }
          for (const row of retained.get('health_tombstones')) {
            if (!policies.some(policy => policy.tenantId === row.tenant_id)) continue;
            ownerCapture.tombstones.push({
              identity: [row.tenant_id, row.source_store_id, row.record_type, row.native_record_id],
              sourceStreamKey: row.stream_key, sourceSequence: row.sequence,
            });
          }
          for (const row of retained.get('health_deletion_guards') || []) {
            if (!policies.some(policy => policy.tenantId === row.tenant_id)) continue;
            ownerCapture.deletionGuards.push({
              identity: [row.tenant_id, row.source_store_id, row.record_type, row.native_record_id],
              sourceDeleted: row.source_deleted, userSuppressed: row.user_suppressed,
              sourceStreamKey: row.source_stream_key, sourceSequence: row.source_sequence, footprintJson: row.footprint_json,
            });
          }
          for (const [table, family] of [['health_streams', 'streams'],
            ['health_batch_receipts', 'receipts'], ['health_projection_outbox', 'projectionOutbox']]) {
            for (const row of retained.get(table)) {
              const fields = transportTuple(row.stream_key);
              if (!policies.some(policy => policy.tenantId === fields[0])) continue;
              const value = { streamKey: row.stream_key };
              if (family === 'streams') {
                value.recordType = row.record_type; value.acknowledgedSequence = row.acknowledged_sequence;
              } else {
                value.sequence = row.sequence; value.batchId = row.batch_id; value.payloadDigest = row.payload_digest;
                if (family === 'receipts') value.receiptJson = row.receipt_json;
                else value.state = row.state;
              }
              ownerCapture[family].push(value);
            }
          }
          if (Buffer.byteLength(JSON.stringify(ownerCapture)) > HARD_LIMITS.maxBytes) deny('limit-exceeded');
          try {
            // Pure profile-3 schema/closure validation; no publication or admission.
            require('../import/native-publication').encodeOrdinaryHistory(ownerCapture, { controlProfileVersion: 3 });
          } catch { deny(); }
          if (ownerId === meta.ownerId) capture = ownerCapture;
        }
        if (!capture) deny();
        return mintScope(db, 'read', meta, entry, scope => {
          scopes.get(scope).ownerWideSnapshot = capture;
          snapshot(scope);
          const result = synchronous(work(scope, db));
          checkActor(meta);
          const currentBytes = boundedBytes(FILE);
          if (!currentBytes) storage();
          const currentCatalogue = validateCatalogue(clone(parse(currentBytes)));
          if (currentCatalogue.recoveryRequired) recovery();
          catalogueClosure(db, currentCatalogue);
          if (!currentBytes.equals(catalogueBytes)) deny();
          return result;
        });
      }, { ownerWide: true });
    });
  }
  const meta = actors.get(actor);
  if (!meta) capability();
  checkActor(meta);
  const cat = readCatalogue(), entry = namespaceFor(cat, meta.ownerId, options.tenantId);
  const catalogueBytes = boundedBytes(FILE);
  if (!catalogueBytes) storage();
  const capturedCatalogue = validateCatalogue(clone(parse(catalogueBytes)));
  if (capturedCatalogue.recoveryRequired) recovery();
  if (JSON.stringify(cat) !== JSON.stringify(capturedCatalogue)) deny();
  return history().readHistorySnapshot(db => {
    catalogueClosure(db, cat);
    return mintScope(db, 'read', meta, entry, scope => {
      snapshot(scope);
      const result = synchronous(work(scope, db));
      checkActor(meta);
      const currentBytes = boundedBytes(FILE);
      if (!currentBytes) storage();
      const currentCatalogue = validateCatalogue(clone(parse(currentBytes)));
      if (currentCatalogue.recoveryRequired) recovery();
      catalogueClosure(db, currentCatalogue);
      if (!currentBytes.equals(catalogueBytes)) deny();
      return result;
    });
  });
}
function snapshot(scope) {
  const m = checkedScope(scope);
  if (m.ownerWideSnapshot) return clone(m.ownerWideSnapshot);
  return closedSnapshot(m.db, m.namespace);
}
function transportTuple(text) {
  const fields = parse(Buffer.from(text));
  if (!Array.isArray(fields) || fields.length !== 7 || !fields.every(v => typeof v === 'string') ||
      !uuid(fields[0]) || !uuid(fields[1]) || !uuid(fields[2]) || !id(fields[3]) ||
      !CATEGORIES.has(fields[4]) || !uint(fields[5]) || !uuid(fields[6])) deny();
  return fields;
}
function exportSnapshot(scope) {
  const m = checkedScope(scope, 'read');
  if (!m.ownerWideSnapshot) capability();
  const ordinary = require('../export/ordinary-history');
  const encoded = require('../import/native-publication').encodeOrdinaryHistory(
    m.ownerWideSnapshot, { controlProfileVersion: 3 });
  const legacy = ordinary.legacySnapshot(m.db, 'utf-8', { allowHAE: true });
  function* guardedPushes() {
    const iterator = ordinary.readHAEPushesStream(m.db, 'utf-8');
    for (;;) {
      if (checkedScope(scope, 'read').db !== m.db) capability();
      const result = iterator.next();
      if (result.done) return;
      yield result.value;
    }
  }
  return { inputBytes: encoded.inputBytes, footerBytes: encoded.footerBytes,
    controlProfileVersion: 3, legacy, haePushes: guardedPushes() };
}

function closedSnapshot(db, n) {
  const rows = db.prepare('SELECT * FROM health_source_policy_state WHERE tenant_id=?').all(n.state.tenantId);
  if (rows.length !== 1) deny();
  const s = rows[0];
  if (s.version !== schema.sourcePolicySchemaVersion(db, () => deny()) ||
      s.owner_id !== n.ownerId || s.epoch !== n.state.restoreEpoch ||
      !uint(s.revision) || s.knowledge !== 'COMPLETE') deny();
  const sources = db.prepare('SELECT * FROM health_source_policy_sources WHERE tenant_id=? '
    + 'ORDER BY source_store_id').all(s.tenant_id);
  if (sources.length !== s.source_count || sources.length > 128) deny();
  const allCats = db.prepare('SELECT * FROM health_source_policy_categories WHERE tenant_id=? '
    + 'ORDER BY source_store_id,record_type').all(s.tenant_id);
  if (allCats.length > 128 || allCats.some(c => !sources.some(v => v.source_store_id === c.source_store_id))) deny();
  const result = sources.map(source => {
    const categories = allCats.filter(c => c.source_store_id === source.source_store_id);
    if (source.owner_id !== n.ownerId || source.knowledge !== 'COMPLETE' ||
        !uuid(source.source_store_id) || !uuid(source.policy_id) ||
        !['active', 'retired'].includes(source.lifecycle) || source.retain_committed_history !== 1 ||
        categories.length !== source.category_count ||
        (source.reconciled_epoch !== null && source.reconciled_epoch !== s.epoch) ||
        categories.some(c => !CATEGORIES.has(c.record_type) || !uint(c.generation) ||
          !['enabled', 'stopped'].includes(c.sharing))) deny();
    if (s.version === 2) for (const category of categories) {
      const values = readinessFields.map(field => category[field]);
      if (values.every(value => value === null)) continue;
      if (values.some(value => value === null) || category.sharing !== 'enabled' ||
          category.readiness_epoch !== s.epoch || category.readiness_generation !== category.generation ||
          !id(category.readiness_installation_id) || !DIGEST.test(category.readiness_query_digest) ||
          !DIGEST.test(category.readiness_report_digest) ||
          !/^hmac-sha256:[a-f0-9]{64}$/.test(category.readiness_mac)) deny();
    }
    return { sourceStoreId: source.source_store_id, policyId: source.policy_id,
      lifecycle: source.lifecycle, knowledge: source.knowledge,
      retainCommittedHistory: source.retain_committed_history, categoryCount: source.category_count,
      reconciledEpoch: source.reconciled_epoch, categories: categories.map(c =>
        ({ recordType: c.record_type, sharing: c.sharing, generation: c.generation })) };
  });
  // Native/history and control keys cannot conceal an omitted owned source.
  const available = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name));
  for (const table of ['health_records', 'health_tombstones', 'health_deletion_guards',
    ...Object.keys(schema.sourceIndexTables), 'health_restore_source_owners']) {
    if (!available.has(table)) continue;
    for (const row of db.prepare(`SELECT * FROM "${table}" WHERE tenant_id=?`).all(s.tenant_id)) {
      const source = result.find(v => v.sourceStoreId === row.source_store_id);
      if (!source ||
          (row.record_type !== undefined && !source.categories.some(c => c.recordType === row.record_type)) ||
          (row.owner_id !== undefined && row.owner_id !== n.ownerId)) deny();
    }
  }
  const registered = (tenantId, sourceStoreId, type) => {
    if (tenantId !== s.tenant_id) return;
    const source = result.find(v => v.sourceStoreId === sourceStoreId);
    if (!source || !source.categories.some(c => c.recordType === type)) deny();
  };
  for (const table of ['health_streams', 'health_batch_receipts', 'health_projection_outbox',
    ...Object.keys(schema.objectTables), 'health_tombstones', 'health_deletion_guards',
    'health_source_index_frontiers']) {
    if (!available.has(table)) continue;
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      const key = row.stream_key ?? row.source_stream_key;
      if (key === null || key === undefined) continue;
      let fields;
      try { fields = transportTuple(key); }
      catch (error) {
        if (table === 'health_deletion_guards') storage();
        throw error;
      }
      registered(fields[0], fields[2], fields[4]);
      if (row.record_type !== undefined && row.record_type !== fields[4]) deny();
      if (row.tenant_id !== undefined && (row.tenant_id !== fields[0] ||
          row.source_store_id !== fields[2])) deny();
      if (row.declaration_json !== undefined) {
        const declaration = parse(Buffer.from(row.declaration_json));
        try { validateObjectDeclaration(declaration); } catch { storage(); }
        const b = declaration.binding;
        if (JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId, b.installationId,
          declaration.recordType, b.generation, b.restoreEpoch]) !== key) deny();
        registered(b.tenantId, b.sourceStoreId, declaration.recordType);
      }
      if (row.receipt_json !== undefined) {
        let receipt;
        try { receipt = decodeMessage(row.receipt_json); } catch { storage(); }
        const b = receipt.binding;
        if (!b || JSON.stringify([b.tenantId, b.instanceId, b.sourceStoreId, b.installationId,
          receipt.recordType, b.generation, b.restoreEpoch]) !== key) deny();
        registered(b.tenantId, b.sourceStoreId, receipt.recordType);
      }
      // Past transport instance/epoch/generation values remain immutable.
      // Closure checks their registered source/type, not current transport.
    }
  }
  for (const item of [...n.state.grants, ...n.state.connectors]) {
    const source = result.find(v => v.sourceStoreId === item.sourceStoreId);
    if (!source || item.ownerId !== n.ownerId ||
        item.categories.some(t => !source.categories.some(c => c.recordType === t))) deny();
  }
  return { tenantId: s.tenant_id, ownerId: s.owner_id, epoch: s.epoch, revision: s.revision,
    knowledge: s.knowledge, sourceCount: s.source_count, sources: result };
}
function compare(scope, expected, full) {
  const m = checkedScope(scope, 'write'), current = snapshot(scope);
  if (!exact(expected, ['sourceStoreId', 'epoch', 'revision', 'generations']) ||
      expected.epoch !== current.epoch || expected.revision !== current.revision ||
      !uint(expected.revision) || !expected.generations || typeof expected.generations !== 'object' ||
      Array.isArray(expected.generations)) deny('binding-mismatch');
  const source = current.sources.find(s => s.sourceStoreId === expected.sourceStoreId);
  if (!source || !Object.keys(expected.generations).length ||
      (full && !exact(expected.generations, source.categories.map(c => c.recordType)))) deny('binding-mismatch');
  for (const [type, generation] of Object.entries(expected.generations)) {
    if (!uint(generation) || source.categories.find(c => c.recordType === type)?.generation !== generation) {
      deny('binding-mismatch');
    }
  }
  return { m, current, source };
}
function mutate(scope, expected, retiring) {
  const { m, current, source } = compare(scope, expected, retiring);
  const changed = source.categories.filter(c => Object.hasOwn(expected.generations, c.recordType) &&
    (retiring ? source.lifecycle !== 'retired' : c.sharing !== 'stopped'));
  if (!retiring && source.lifecycle !== 'active') deny();
  if (!changed.length && (!retiring || source.lifecycle === 'retired')) return current;
  if (BigInt(current.revision) === MAX || changed.some(c => BigInt(c.generation) === MAX)) deny('limit-exceeded');
  const version = schema.sourcePolicySchemaVersion(m.db, () => deny());
  const clear = version === 2 ? ',' + readinessFields.map(field => `${field}=NULL`).join(',') : '';
  const update = m.db.prepare('UPDATE health_source_policy_categories SET sharing=?,generation=?' + clear + ' '
    + 'WHERE tenant_id=? AND source_store_id=? AND record_type=?');
  for (const c of changed) update.run(retiring ? c.sharing : 'stopped',
    String(BigInt(c.generation) + 1n), current.tenantId, source.sourceStoreId, c.recordType);
  m.db.prepare('UPDATE health_source_policy_sources SET lifecycle=?,reconciled_epoch='
    + (retiring || version === 1 ? 'NULL ' : 'reconciled_epoch ')
    + 'WHERE tenant_id=? AND source_store_id=?')
    .run(retiring ? 'retired' : source.lifecycle, current.tenantId, source.sourceStoreId);
  m.db.prepare('UPDATE health_source_policy_state SET revision=? WHERE tenant_id=? AND owner_id=?')
    .run(String(BigInt(current.revision) + 1n), current.tenantId, current.ownerId);
  return snapshot(scope);
}
const stop = (scope, expected) => mutate(scope, expected, false);
const retire = (scope, expected) => mutate(scope, expected, true);
function enable(scope, expected) { compare(scope, expected, false); deny('IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED'); }
function reconcile(scope, expected) { compare(scope, expected, true); deny('IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED'); }
const readinessCustodies = new WeakMap(), readinessChallenges = new Map();
const readinessFields = ['readiness_epoch', 'readiness_installation_id', 'readiness_generation',
  'readiness_query_digest', 'readiness_report_digest', 'readiness_mac'];
const readinessProof = () => require('./readiness-provenance');
const readinessKey = (tenant, source, type) => JSON.stringify([tenant, source, type]);
const connectorIdentity = connector => JSON.stringify(Object.fromEntries(Object.entries(connector)
  .filter(([key]) => key !== 'generations')));
const equalBinding = (left, right) => exact(left, ['tenantId', 'instanceId', 'sourceStoreId',
  'installationId', 'generation', 'restoreEpoch']) &&
  Object.keys(right).every(key => left[key] === right[key]);

function captureReadiness(req) {
  const saved = authority().readPolicyCredential(req, 2);
  saved.check();
  const databaseIdentity = selectedDatabaseIdentity();
  if (!databaseIdentity) storage();
  return opaque(readinessCustodies, { req, saved, databaseIdentity,
    tenantId: saved.state.tenantId, instanceId: saved.state.instanceId, epoch: saved.state.restoreEpoch,
    ownerId: saved.connector.ownerId, connectorIdentity: connectorIdentity(saved.connector),
    verifier: saved.connector.credentialVerifier });
}
function recheckReadiness(custody) {
  const meta = readinessCustodies.get(custody);
  if (!meta) capability();
  meta.saved.check();
}
function nativeReadiness(meta, cat) {
  authority().checkPolicyLifecycle(meta.req);
  const selected = selectedDatabaseIdentity();
  if (!selected || selected.dev !== meta.databaseIdentity.dev || selected.ino !== meta.databaseIdentity.ino) {
    deny('binding-mismatch');
  }
  const entry = namespaceFor(cat, meta.ownerId, meta.tenantId);
  livePrincipal(meta.ownerId, cat);
  const connector = entry.state.connectors.find(c => c.credentialVerifier === meta.verifier);
  if (!connector || connector.revokedAt !== null || connectorIdentity(connector) !== meta.connectorIdentity ||
      entry.state.instanceId !== meta.instanceId || entry.state.restoreEpoch !== meta.epoch) {
    deny('binding-mismatch');
  }
  return { entry, connector };
}
function withReadiness(custody, write, work) {
  const meta = readinessCustodies.get(custody);
  if (!meta) capability();
  // Revalidate the full captured credential across asynchronous body consumption.
  meta.saved.check();
  const execute = () => {
    const cat = readCatalogue(), initial = nativeReadiness(meta, cat);
    const apply = db => {
      catalogueClosure(db, cat);
      const scope = opaque(scopes, { db, mode: 'readiness', namespace: initial.entry,
        connector: initial.connector, live: true });
      try {
        const result = synchronous(work(scope));
        const current = snapshot(scope);
        if (write) for (const connector of initial.entry.state.connectors) {
          const source = current.sources.find(s => s.sourceStoreId === connector.sourceStoreId);
          if (!source) deny();
          for (const type of connector.categories) {
            const category = source.categories.find(c => c.recordType === type);
            if (!category) deny();
            connector.generations[type] = category.generation;
          }
        }
        nativeReadiness(meta, cat);
        return result;
      } finally { scopes.get(scope).live = false; scopes.delete(scope); }
    };
    return write ? projectedTransaction(cat, apply, () => nativeReadiness(meta, cat)) :
      history().readHistorySnapshot(apply);
  };
  return write ? serialized(execute) : execute();
}
function readinessScope(scope, type) {
  const m = checkedScope(scope), current = snapshot(scope);
  const connector = m.connector;
  const source = current.sources.find(s => s.sourceStoreId === connector?.sourceStoreId);
  const category = source?.categories.find(c => c.recordType === type);
  if (!connector || source?.lifecycle !== 'active' || !category || !connector.categories.includes(type)) {
    deny('scope-mismatch', 403);
  }
  const binding = { tenantId: current.tenantId, instanceId: m.namespace.state.instanceId,
    sourceStoreId: source.sourceStoreId, installationId: connector.installationId,
    generation: category.generation, restoreEpoch: current.epoch };
  return { m, current, source, category, binding };
}
function proofTuple(facts, row) {
  return { tenantId: facts.current.tenantId, ownerId: facts.current.ownerId,
    instanceId: facts.m.namespace.state.instanceId, sourceStoreId: facts.source.sourceStoreId,
    installationId: row.readiness_installation_id, recordType: facts.category.recordType,
    restoreEpoch: row.readiness_epoch, generation: row.readiness_generation,
    queryDigest: row.readiness_query_digest, reportDigest: row.readiness_report_digest };
}
function categoryReadiness(scope, type) {
  const facts = readinessScope(scope, type);
  if (schema.sourcePolicySchemaVersion(facts.m.db, () => deny()) !== 2) return false;
  const row = facts.m.db.prepare('SELECT * FROM health_source_policy_categories '
    + 'WHERE tenant_id=? AND source_store_id=? AND record_type=?')
    .get(facts.current.tenantId, facts.source.sourceStoreId, type);
  return facts.category.sharing === 'enabled' && facts.source.reconciledEpoch === facts.current.epoch &&
    row.readiness_epoch === facts.current.epoch && row.readiness_generation === facts.category.generation &&
    row.readiness_installation_id === facts.binding.installationId &&
    readinessProof().verify(proofTuple(facts, row), row.readiness_mac);
}
function upgradeReadiness(scope) {
  const m = checkedScope(scope, 'readiness');
  if (schema.sourcePolicySchemaVersion(m.db, () => deny()) === 2) return;
  const states = m.db.prepare('SELECT * FROM health_source_policy_state').all();
  const categories = m.db.prepare('SELECT * FROM health_source_policy_categories').all();
  m.db.exec('DROP TABLE health_source_policy_categories; DROP TABLE health_source_policy_state');
  m.db.exec(schema.sourcePolicyTablesV2.health_source_policy_state);
  m.db.exec(schema.sourcePolicyTablesV2.health_source_policy_categories);
  const stateInsert = m.db.prepare('INSERT INTO health_source_policy_state '
    + '(version,tenant_id,owner_id,epoch,revision,knowledge,source_count) VALUES(2,?,?,?,?,?,?)');
  for (const row of states) stateInsert.run(row.tenant_id, row.owner_id, row.epoch,
    row.revision, row.knowledge, row.source_count);
  const categoryInsert = m.db.prepare('INSERT INTO health_source_policy_categories '
    + '(tenant_id,source_store_id,record_type,sharing,generation) VALUES(?,?,?,?,?)');
  for (const row of categories) categoryInsert.run(row.tenant_id, row.source_store_id,
    row.record_type, row.sharing, row.generation);
  // Old enabled intent is retained with NULL provenance, never upgraded into verified readiness.
  validFamily(m.db);
  snapshot(scope);
}
function readinessStatus(custody, input) {
  return withReadiness(custody, false, scope => {
    const facts = readinessScope(scope, input.recordType);
    if (!equalBinding(input.binding, facts.binding)) deny('binding-mismatch');
    return { version: 2, kind: 'readiness-result', recordType: input.recordType,
      binding: facts.binding, policyRevision: facts.current.revision, sharing: facts.category.sharing,
      verification: categoryReadiness(scope, input.recordType) ? 'authenticated-companion-report' : 'unverified' };
  });
}
function beginReadiness(custody, input) {
  const meta = readinessCustodies.get(custody);
  if (!meta) capability();
  const completed = withReadiness(custody, true, scope => {
    let facts = readinessScope(scope, input.recordType);
    if (!equalBinding(input.binding, facts.binding) || input.policyRevision !== facts.current.revision) {
      deny('binding-mismatch');
    }
    if (BigInt(facts.current.revision) === MAX || BigInt(facts.category.generation) === MAX) {
      deny('limit-exceeded');
    }
    upgradeReadiness(scope);
    const generation = String(BigInt(facts.category.generation) + 1n);
    const revision = String(BigInt(facts.current.revision) + 1n);
    const clearing = readinessFields.map(field => `${field}=NULL`).join(',');
    facts.m.db.prepare(`UPDATE health_source_policy_categories SET sharing='stopped',generation=?,${clearing} `
      + 'WHERE tenant_id=? AND source_store_id=? AND record_type=?')
      .run(generation, facts.current.tenantId, facts.source.sourceStoreId, input.recordType);
    facts.m.db.prepare('UPDATE health_source_policy_state SET revision=? WHERE tenant_id=? AND owner_id=?')
      .run(revision, facts.current.tenantId, facts.current.ownerId);
    facts = readinessScope(scope, input.recordType);
    const acknowledgedSequence = history().frontier(facts.m.db,
      history().streamKey(facts.binding, input.recordType), facts.binding, input.recordType);
    const readinessId = 'hc_ready_' + crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const response = { version: 2, kind: 'readiness-challenge', readinessId,
      recordType: input.recordType, binding: facts.binding, policyRevision: revision,
      queryJson: input.queryJson, filterDigest: input.filterDigest, acknowledgedSequence, expiresAt };
    return { response, private: { ...response, ownerId: facts.current.ownerId,
      verifier: meta.verifier, databaseIdentity: meta.databaseIdentity, pageSize: input.query.pageSize } };
  });
  // Only a confirmed coherent SQL/private-projection commit issues a live process-owned challenge.
  for (const [key, value] of readinessChallenges) {
    if (Date.parse(value.expiresAt) <= Date.now()) readinessChallenges.delete(key);
  }
  readinessChallenges.set(readinessKey(meta.tenantId, completed.response.binding.sourceStoreId,
    input.recordType), completed.private);
  return completed.response;
}
/** Authenticated selected-category stop; it never issues an enablement challenge. */
function stopReadiness(custody, input) {
  const meta = readinessCustodies.get(custody);
  if (!meta) capability();
  const result = withReadiness(custody, true, scope => {
    let facts = readinessScope(scope, input.recordType);
    if (!equalBinding(input.binding, facts.binding) || input.policyRevision !== facts.current.revision) {
      deny('binding-mismatch');
    }
    if (BigInt(facts.current.revision) === MAX || BigInt(facts.category.generation) === MAX) {
      deny('limit-exceeded');
    }
    upgradeReadiness(scope);
    const generation = String(BigInt(facts.category.generation) + 1n);
    const revision = String(BigInt(facts.current.revision) + 1n);
    const clearing = readinessFields.map(field => `${field}=NULL`).join(',');
    // Even an already stopped category can have a live BEGIN. Fence it by generation.
    const changed = facts.m.db.prepare(`UPDATE health_source_policy_categories SET sharing='stopped',generation=?,${clearing} `
      + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? AND generation=?')
      .run(generation, facts.current.tenantId, facts.source.sourceStoreId,
        input.recordType, facts.category.generation);
    if (changed.changes !== 1) deny('binding-mismatch');
    const advanced = facts.m.db.prepare('UPDATE health_source_policy_state SET revision=? '
      + 'WHERE tenant_id=? AND owner_id=? AND revision=?')
      .run(revision, facts.current.tenantId, facts.current.ownerId, facts.current.revision);
    if (advanced.changes !== 1) deny('binding-mismatch');
    facts = readinessScope(scope, input.recordType);
    return { version: 2, kind: 'readiness-result', recordType: input.recordType,
      binding: facts.binding, policyRevision: revision, sharing: 'stopped', verification: 'unverified' };
  });
  // Cache retirement follows a confirmed SQL/private-projection commit; never precedes it.
  readinessChallenges.delete(readinessKey(meta.tenantId, result.binding.sourceStoreId, input.recordType));
  return result;
}
function completeReadiness(custody, input) {
  const meta = readinessCustodies.get(custody);
  if (!meta) capability();
  const key = readinessKey(meta.tenantId, input.binding.sourceStoreId, input.recordType);
  const challenge = readinessChallenges.get(key);
  if (!challenge || challenge.readinessId !== input.readinessId ||
      Date.parse(challenge.expiresAt) <= Date.now() || challenge.ownerId !== meta.ownerId ||
      challenge.verifier !== meta.verifier || challenge.databaseIdentity.dev !== meta.databaseIdentity.dev ||
      challenge.databaseIdentity.ino !== meta.databaseIdentity.ino ||
      !equalBinding(input.binding, challenge.binding) || input.policyRevision !== challenge.policyRevision ||
      input.filterDigest !== challenge.filterDigest || BigInt(input.firstPage.recordCount) > BigInt(challenge.pageSize)) {
    deny('readiness-unverified');
  }
  const result = withReadiness(custody, true, scope => {
    const facts = readinessScope(scope, input.recordType);
    if (!equalBinding(input.binding, facts.binding) || input.policyRevision !== facts.current.revision ||
        facts.category.sharing !== 'stopped' || Date.parse(challenge.expiresAt) <= Date.now() ||
        history().frontier(facts.m.db, history().streamKey(facts.binding, input.recordType),
          facts.binding, input.recordType) !== challenge.acknowledgedSequence) deny('binding-mismatch');
    if (BigInt(facts.current.revision) === MAX) deny('limit-exceeded');
    const reportDigest = payloadDigest(JSON.stringify(input));
    const row = { readiness_epoch: facts.current.epoch,
      readiness_installation_id: facts.binding.installationId,
      readiness_generation: facts.category.generation, readiness_query_digest: input.filterDigest,
      readiness_report_digest: reportDigest };
    const mac = readinessProof().mac(proofTuple(facts, row));
    const changed = facts.m.db.prepare("UPDATE health_source_policy_categories SET sharing='enabled',"
      + 'readiness_epoch=?,readiness_installation_id=?,readiness_generation=?,readiness_query_digest=?,'
      + 'readiness_report_digest=?,readiness_mac=? WHERE tenant_id=? AND source_store_id=? '
      + "AND record_type=? AND sharing='stopped' AND generation=?")
      .run(row.readiness_epoch, row.readiness_installation_id, row.readiness_generation,
        row.readiness_query_digest, row.readiness_report_digest, mac, facts.current.tenantId,
        facts.source.sourceStoreId, input.recordType, facts.category.generation);
    if (changed.changes !== 1) deny('binding-mismatch');
    facts.m.db.prepare('UPDATE health_source_policy_sources SET reconciled_epoch=? '
      + 'WHERE tenant_id=? AND source_store_id=?')
      .run(facts.current.epoch, facts.current.tenantId, facts.source.sourceStoreId);
    const revision = String(BigInt(facts.current.revision) + 1n);
    const stateChanged = facts.m.db.prepare('UPDATE health_source_policy_state SET revision=? '
      + 'WHERE tenant_id=? AND owner_id=? AND revision=?')
      .run(revision, facts.current.tenantId, facts.current.ownerId, facts.current.revision);
    if (stateChanged.changes !== 1 || !categoryReadiness(scope, input.recordType)) deny('binding-mismatch');
    return { version: 2, kind: 'readiness-result', recordType: input.recordType, binding: facts.binding,
      policyRevision: revision, sharing: 'enabled', verification: 'authenticated-companion-report' };
  });
  readinessChallenges.delete(key);
  return result;
}

function captureAdmission(req) {
  const saved = authority().readPolicyCredential(req);
  saved.check();
  return opaque(admissions, { req, saved });
}
function runAdmissionTransaction(custody, work) {
  const meta = custody === undefined ? null : admissions.get(custody);
  if (custody !== undefined && !meta) capability();
  return history().withHistoryTransaction(db => {
    if (!family(db)) {
      if (meta) { meta.saved.check(); authority().readPolicyCredential(meta.req).check(); }
      return synchronous(work(db, undefined));
    }
    validFamily(db);
    if (!meta) deny();
    meta.saved.check();
    const fresh = authority().readPolicyCredential(meta.req), cat = readCatalogue();
    fresh.check();
    const entry = cat?.namespaces.find(n => n.ownerId === fresh.connector.ownerId &&
      n.state.tenantId === fresh.state.tenantId);
    if (!entry) deny();
    assertNamespaceCredential(fresh.state, fresh.connector);
    const token = opaque(scopes, { db, mode: 'admission', namespace: entry, live: true,
      native: meta, connector: fresh.connector });
    try {
      const result = synchronous(work(db, token));
      fresh.check(); meta.saved.check();
      return result;
    } finally { scopes.get(token).live = false; scopes.delete(token); }
  });
}
function assertAdmission(db, scope, binding, type) {
  if (scope === undefined) {
    if (!db) capability();
    if (!family(db)) return;
    deny();
  }
  const m = scopes.get(scope);
  if (!m || !m.live || m.mode !== 'admission' || m.db !== db) capability();
  checkedScope(scope, 'admission');
  m.native.saved.check();
  const current = snapshot(scope), connector = m.connector;
  const source = current.sources.find(s => s.sourceStoreId === connector.sourceStoreId);
  const category = source?.categories.find(c => c.recordType === type);
  if (!binding || binding.tenantId !== current.tenantId ||
      binding.instanceId !== m.namespace.state.instanceId ||
      binding.sourceStoreId !== connector.sourceStoreId ||
      binding.installationId !== connector.installationId || binding.restoreEpoch !== current.epoch ||
      !category || binding.generation !== category.generation || !connector.categories.includes(type)) {
    deny('binding-mismatch');
  }
  if (source.lifecycle !== 'active' || category.sharing !== 'enabled' ||
      source.reconciledEpoch !== current.epoch) deny();
  // A scoped authenticated first-page report enables collection, never complete native coverage.
  if (!categoryReadiness(scope, type)) deny('IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED');
}

module.exports = { PolicyError, captureActor, resolveBrowser, captureRegistrationActor,
  verifyRegistrationActor, bindRegisteredCredential, hasPolicyFamily, enrolStopped,
  readNamespaces, readSourceBoundaries, namespaceAuthority, captureGrant, updateNamespace, assertNamespaceCredential,
  captureAdmission, runAdmissionTransaction, assertAdmission, withWriteAuthority,
  withReadAuthority, exportSnapshot, snapshot, stop, retire, enable, reconcile,
  captureReadiness, recheckReadiness, readinessStatus, beginReadiness, stopReadiness, completeReadiness };
