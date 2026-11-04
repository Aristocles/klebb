// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { decodeJson, decodeMessage, payloadDigest, HARD_LIMITS, ProtocolError } = require('./protocol');
const { CREDENTIALS_DIR, DB_FILE } = require('../../config/paths');
const { readPublication } = require('../import/native-publication');
const ENV = require('../../config/env');
const { getSessionRecord } = require('../../auth/webauthn');
const { originAllowed } = require('../origin-check');
const { isHealthConnectorBearer } = require('../../auth/bearer-scope');
const { commitBatch, readFrontiers, HistoryError, readHistorySnapshot } = require('./history');
const { OBJECT_LIMITS, stagePart, finaliseObject } = require('./objects');
const sourceIndex = require('./source-index');
const ownerDeletion = require('./owner-deletion');
const ownerSelection = require('./deletion-selection');
const { scheduleSourceIndex } = require('./source-index-worker');
const BASE = '/api/connectors/health-connect';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INT64 = /^(0|[1-9][0-9]{0,18})$/;
// An authority catalogue, not a claim that capture/ingestion adapters exist.
// Keep the runtime independent of the Android development module.
const CATEGORIES = new Set(require('../../config/health-connect-categories.json'));
const FILE = path.join(CREDENTIALS_DIR, 'health-connect.json');
const MAX_GRANTS = 128;
const MAX_CONNECTORS = 128;
const REQUEST_LIFECYCLES = new WeakMap();
const sourcePolicy = () => require('./source-policy');
class AuthorityError extends HistoryError {
  constructor(status, code, body) {
    super(status, code); this.status = status; this.code = code; this.body = body;
  }
}
const refuse = (status, code) => { throw new AuthorityError(status, code); };
const id = value => typeof value === 'string' && value.length > 0 &&
  [...value].length <= 256 && !/[\uD800-\uDFFF]/u.test(value);
const uint = value => typeof value === 'string' && INT64.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const nullableTime = value => value === null || time(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const digest = value => typeof value === 'string' && DIGEST.test(value);
const categories = value => Array.isArray(value) && value.length > 0 && value.length <= 128 &&
  value.every(type => CATEGORIES.has(type)) && new Set(value).size === value.length;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nameValid = value => typeof value === 'string' && value.trim().length > 0 &&
  [...value].length <= 80 && !/[\u0000-\u001f\u007f]/u.test(value);
// Keep the established STATUS/BEGIN/COMPLETE parser and dispatcher intact.
function readinessStopRequest(bytes, type) {
  if (!CATEGORIES.has(type)) refuse(403, 'scope-mismatch');
  const value = decodeJson(bytes);
  if (value?.kind !== 'readiness-stop') return null;
  if (value.version !== 2 || value.recordType !== type ||
      !exact(value, ['version', 'kind', 'recordType', 'binding', 'policyRevision']) ||
      !exact(value.binding, ['tenantId', 'instanceId', 'sourceStoreId', 'installationId',
        'generation', 'restoreEpoch']) || !uint(value.policyRevision)) {
    refuse(400, 'invalid-message');
  }
  return value;
}
function assertUnmanagedEnrollment() {
  let stat;
  try { stat = fs.lstatSync(DB_FILE); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    refuse(503, 'storage-unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) refuse(503, 'storage-unavailable');
  let db, managed;
  try {
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN');
    managed = !!db.prepare('SELECT 1 FROM sqlite_schema WHERE name COLLATE NOCASE IN '
      + "('health_source_policy_state','health_source_policy_sources','health_source_policy_categories') "
      + 'LIMIT 1').get();
    db.exec('COMMIT');
  } catch { refuse(503, 'storage-unavailable'); }
  finally {
    if (db) try { db.close(); } catch { refuse(503, 'storage-unavailable'); }
  }
  if (managed) refuse(409, 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED');
}
function validState(state) {
  if (!exact(state, ['version', 'tenantId', 'instanceId', 'restoreEpoch', 'grants', 'connectors']) ||
      state.version !== 1 || ![state.tenantId, state.instanceId, state.restoreEpoch]
        .every(uuid) ||
      !Array.isArray(state.grants) || state.grants.length > MAX_GRANTS ||
      !Array.isArray(state.connectors) || state.connectors.length > MAX_CONNECTORS) return false;
  for (const grant of state.grants) {
    if (!exact(grant, ['verifier', 'ownerId', 'instanceId', 'sourceStoreId', 'restoreEpoch',
      'categories', 'name', 'expiresAt', 'consumedAt']) ||
        !digest(grant.verifier) || !id(grant.ownerId) || !uuid(grant.instanceId) ||
        !uuid(grant.sourceStoreId) || !uuid(grant.restoreEpoch) ||
        !categories(grant.categories) || !nameValid(grant.name) || !time(grant.expiresAt) ||
        !nullableTime(grant.consumedAt)) return false;
  }
  for (const connector of state.connectors) {
    if (!exact(connector, ['id', 'credentialVerifier', 'ownerId', 'installationId',
      'sourceStoreId', 'restoreEpoch', 'categories', 'generations', 'name', 'createdAt',
      'revokedAt']) || !uuid(connector.id) || !digest(connector.credentialVerifier) ||
        !id(connector.ownerId) || !id(connector.installationId) ||
        !uuid(connector.sourceStoreId) || !uuid(connector.restoreEpoch) ||
        !categories(connector.categories) || !nameValid(connector.name) ||
        !time(connector.createdAt) || !nullableTime(connector.revokedAt) ||
        !exact(connector.generations, connector.categories) ||
        !Object.values(connector.generations).every(uint)) return false;
  }
  return new Set(state.grants.map(item => item.verifier)).size === state.grants.length &&
    new Set(state.connectors.map(item => item.credentialVerifier)).size === state.connectors.length &&
    new Set(state.connectors.map(item => item.id)).size === state.connectors.length;
}
function persist(state) {
  if (!validState(state)) refuse(503, 'storage-unavailable');
  const text = JSON.stringify(state);
  // Verify that a cold read can decode the exact persisted form.
  try { decodeJson(text); } catch { refuse(503, 'storage-unavailable'); }
  const temporary = `${FILE}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, FILE);
    // The production POSIX filesystem must also flush the rename. Windows
    // does not expose a directory descriptor for fsync through this API.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(CREDENTIALS_DIR, 'r');
      try { fs.fsyncSync(directory); }
      finally { fs.closeSync(directory); }
    }
  } catch {
    refuse(503, 'storage-unavailable');
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
  }
}
function restoredAuthority() {
  try { return readPublication(); }
  catch { refuse(503, 'storage-unavailable'); }
}
function authorityState(publication, state) {
  if (!publication) return state;
  if (!state || (state.grants.length === 0 && state.connectors.length === 0)) {
    return { version: 1, tenantId: publication.tenantId, instanceId: publication.instanceId,
      restoreEpoch: publication.restoreEpoch, grants: [], connectors: [] };
  }
  if (state.tenantId !== publication.tenantId || state.instanceId !== publication.instanceId ||
      state.restoreEpoch !== publication.restoreEpoch) refuse(503, 'storage-unavailable');
  const owners = new Map(publication.sources.map(source =>
    [source.sourceStoreId, source.ownerId]));
  for (const source of [...state.grants, ...state.connectors]) {
    if (owners.has(source.sourceStoreId) && owners.get(source.sourceStoreId) !== source.ownerId) {
      refuse(503, 'storage-unavailable');
    }
    owners.set(source.sourceStoreId, source.ownerId);
  }
  return state;
}
function publicationIdentity(publication) {
  return publication === null ? null : JSON.stringify([publication.publicationId,
    publication.instanceId, publication.restoreEpoch, publication.metadataSha256]);
}
function load() {
  const publication = restoredAuthority();
  try {
    if (fs.statSync(FILE).size > HARD_LIMITS.maxBytes) refuse(503, 'storage-unavailable');
    const state = decodeJson(fs.readFileSync(FILE));
    if (!validState(state)) refuse(503, 'storage-unavailable');
    return authorityState(publication, JSON.parse(JSON.stringify(state)));
  } catch (error) {
    if (error.code !== 'ENOENT') refuse(503, 'storage-unavailable');
    if (publication) return authorityState(publication, null);
    const state = { version: 1, tenantId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
      restoreEpoch: crypto.randomUUID(), grants: [], connectors: [] };
    persist(state);
    return state;
  }
}
function destination() {
  let origin;
  try { origin = new URL(ENV.WEBAUTHN_ORIGIN); } catch { refuse(400, 'invalid-destination'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.origin !== ENV.WEBAUTHN_ORIGIN) refuse(400, 'invalid-destination');
  return origin.origin;
}
function streams(state, connector) {
  const frontiers = readFrontiers(connector.categories.map(recordType => ({
    binding: binding(state, connector, recordType), recordType,
  })));
  return Object.fromEntries(connector.categories.map((type, index) => [type, {
    generation: connector.generations[type], acknowledgedSequence: frontiers[index],
  }]));
}
function binding(state, connector, type) {
  return { tenantId: state.tenantId, instanceId: state.instanceId,
    sourceStoreId: connector.sourceStoreId, installationId: connector.installationId,
    generation: connector.generations[type], restoreEpoch: state.restoreEpoch };
}
function safeEqual(a, b) {
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
function credential(state, req, protocolVersion = 1) {
  const value = /^Bearer (klebb_hc1_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
  if (!value) refuse(401, 'unauthorised');
  const verifier = payloadDigest(value);
  const connector = state.connectors.find(item => safeEqual(item.credentialVerifier, verifier));
  if (!connector) refuse(401, 'unauthorised');
  if (connector.revokedAt || connector.restoreEpoch !== state.restoreEpoch) refuse(401, 'revoked');
  if (req.headers['klebb-health-protocol'] !== String(protocolVersion)) refuse(400, 'unsupported-version');
  return connector;
}

function checkPolicyLifecycle(req) {
  const check = REQUEST_LIFECYCLES.get(req);
  if (!check) refuse(401, 'unauthorised');
  check();
}
function bindBrowserRead(req, res, unavailable = () => null) {
  let live = true;
  const check = () => {
    if (!live || req.aborted || res.destroyed || res.writableFinished) refuse(401, 'unauthorised');
    const blocked = unavailable();
    if (blocked) throw new AuthorityError(503, blocked.code, blocked);
    browser(req);
  };
  const release = () => {
    live = false;
    if (REQUEST_LIFECYCLES.get(req) === check) REQUEST_LIFECYCLES.delete(req);
    req.removeListener('aborted', release);
    res.removeListener('finish', release);
    res.removeListener('close', release);
  };
  REQUEST_LIFECYCLES.set(req, check);
  req.once('aborted', release);
  res.once('finish', release);
  res.once('close', release);
}
function namespaces() {
  return sourcePolicy().readNamespaces() || [];
}
function resolveNativeCredential(req, protocolVersion = 1) {
  checkPolicyLifecycle(req);
  const value = /^Bearer (klebb_hc1_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
  if (!value) refuse(401, 'unauthorised');
  const verifier = payloadDigest(value), legacy = load();
  const matches = [{ state: legacy, managed: false },
    ...namespaces().map(entry => ({ state: entry.state, managed: true }))]
    .filter(entry => entry.state.connectors.some(item => safeEqual(item.credentialVerifier, verifier)));
  if (matches.length > 1) refuse(503, 'storage-unavailable');
  if (matches.length !== 1) refuse(401, 'unauthorised');
  const { state, managed } = matches[0];
  const connector = credential(state, req, protocolVersion);
  if (managed) sourcePolicy().assertNamespaceCredential(state, connector);
  checkPolicyLifecycle(req);
  return { state, connector };
}
function readPolicyCredential(req, protocolVersion = 1) {
  const current = resolveNativeCredential(req, protocolVersion);
  const identity = value => JSON.stringify([value.state.tenantId, value.state.instanceId,
    value.state.restoreEpoch, value.connector]);
  const captured = identity(current);
  return { ...current, check() {
    const fresh = resolveNativeCredential(req, protocolVersion);
    if (identity(fresh) !== captured) refuse(409, 'binding-mismatch');
  } };
}
function findGrantState(legacy, secret) {
  const verifier = payloadDigest(secret);
  const matches = [{ state: legacy, managed: false },
    ...namespaces().map(entry => ({ state: entry.state, managed: true }))]
    .filter(entry => entry.state.grants.some(item => safeEqual(item.verifier, verifier)));
  if (matches.length > 1) refuse(503, 'storage-unavailable');
  if (matches.length !== 1) refuse(401, 'unauthorised');
  return matches[0];
}
function consumeGrant(state, frame) {
  const approved = state.grants.find(item => safeEqual(item.verifier, payloadDigest(frame.grant)));
  if (!approved) refuse(401, 'unauthorised');
  if (approved.consumedAt) refuse(409, 'conflict');
  if (Date.parse(approved.expiresAt) <= Date.now()) refuse(410, 'expired-grant');
  if (frame.tenantId !== state.tenantId || frame.instanceId !== state.instanceId ||
      approved.instanceId !== state.instanceId || approved.restoreEpoch !== state.restoreEpoch ||
      frame.sourceStoreId !== approved.sourceStoreId) refuse(403, 'binding-mismatch');
  if (frame.categories.some(type => !approved.categories.includes(type))) refuse(403, 'scope-mismatch');
  if (state.connectors.length >= MAX_CONNECTORS) refuse(400, 'limit-exceeded');
  const secret = 'klebb_hc1_' + crypto.randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const connector = { id: crypto.randomUUID(), credentialVerifier: payloadDigest(secret),
    ownerId: approved.ownerId, installationId: frame.installationId,
    sourceStoreId: approved.sourceStoreId, restoreEpoch: state.restoreEpoch,
    categories: frame.categories, generations: Object.fromEntries(frame.categories.map(type => [type, '1'])),
    name: approved.name, createdAt: now, revokedAt: null };
  const result = { version: 1, kind: 'paired', destination: destination(), tenantId: state.tenantId,
    instanceId: state.instanceId, connectorId: connector.id, sourceStoreId: connector.sourceStoreId,
    installationId: connector.installationId, restoreEpoch: state.restoreEpoch,
    categories: connector.categories, streams: streams(state, connector), credential: secret };
  decodeMessage(JSON.stringify(result));
  approved.consumedAt = now;
  state.connectors.push(connector);
  return result;
}

function browser(req) {
  if (isHealthConnectorBearer(req)) refuse(401, 'unauthorised');
  const session = getSessionRecord(req);
  if (!session || !id(session.userId)) refuse(401, 'unauthorised');
  if (!originAllowed(req)) refuse(403, 'scope-mismatch');
  return session.userId;
}
function refuseRetainedLegacyOwner(ownerId, state = null, retained = null) {
  // V1 catalogues and publications retain labels, not original credential bindings.
  // Current membership cannot prove ownership of those retained identities.
  const owners = [...(state?.grants || []), ...(state?.connectors || []),
    ...(retained?.legacySources ?? retained?.sources ?? [])];
  if (owners.some(item => item.ownerId === ownerId)) {
    refuse(409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
  }
}
function sourceBoundary(checkLifecycle = () => {}) {
  const legacy = sourceBoundaryFromPublication(restoredAuthority(), checkLifecycle);
  const managed = sourcePolicy().readSourceBoundaries();
  if (managed === null) return legacy;
  const registered = [...managed];
  if (legacy && legacy.sources.length) registered.push({ tenantId: legacy.tenantId,
    restoreEpoch: legacy.restoreEpoch, sources: legacy.sources });
  const tenants = new Set(), sourceIds = new Set();
  for (const namespace of registered) {
    if (tenants.has(namespace.tenantId)) refuse(503, 'storage-unavailable');
    tenants.add(namespace.tenantId);
    for (const source of namespace.sources) {
      if (sourceIds.has(source.sourceStoreId)) refuse(503, 'storage-unavailable');
      sourceIds.add(source.sourceStoreId);
    }
  }
  registered.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  const result = { ...(registered.length === 1 ? registered[0] : {}),
    namespaces: registered, legacySources: legacy?.sources || [],
    sources: registered.flatMap(namespace => namespace.sources)
      .sort((a, b) => a.sourceStoreId.localeCompare(b.sourceStoreId)) };
  const identity = JSON.stringify(result);
  result.check = () => {
    checkLifecycle();
    legacy?.check();
    const current = sourceBoundary();
    if (!current || JSON.stringify(current) !== identity) refuse(503, 'storage-unavailable');
  };
  return result;
}
function sourceNamespace(boundary, sourceStoreId, missingStatus = 403, missingCode = 'scope-mismatch') {
  if (!uuid(sourceStoreId)) refuse(400, 'invalid-message');
  if (!boundary) refuse(503, 'storage-unavailable');
  const registered = boundary.namespaces || [boundary];
  const matches = registered.filter(namespace =>
    namespace.sources.some(source => source.sourceStoreId === sourceStoreId));
  if (matches.length > 1) refuse(503, 'storage-unavailable');
  if (matches.length !== 1) refuse(missingStatus, missingCode);
  const selected = matches[0];
  return { ...boundary, ...selected, namespaces: registered,
    legacySources: (boundary.legacySources ?? boundary.sources).filter(source =>
      selected.sources.some(item => item.sourceStoreId === source.sourceStoreId)) };
}
function sourceBoundaryFromPublication(publication, checkLifecycle = () => {}) {
  let state;
  try {
    if (fs.statSync(FILE).size > HARD_LIMITS.maxBytes) refuse(503, 'storage-unavailable');
    state = decodeJson(fs.readFileSync(FILE));
    if (!validState(state)) refuse(503, 'storage-unavailable');
  } catch (error) {
    if (error.code !== 'ENOENT') refuse(503, 'storage-unavailable');
    if (!publication) return null;
  }
  state = authorityState(publication, state);
  const owners = new Map((publication?.sources || []).map(source =>
    [source.sourceStoreId, source.ownerId]));
  for (const connector of state.connectors) {
    if (owners.has(connector.sourceStoreId) && owners.get(connector.sourceStoreId) !== connector.ownerId) {
      refuse(503, 'storage-unavailable');
    }
    owners.set(connector.sourceStoreId, connector.ownerId);
  }
  const result = { tenantId: state.tenantId, restoreEpoch: state.restoreEpoch,
    sources: [...owners].map(([sourceStoreId, ownerId]) => ({ sourceStoreId, ownerId }))
      .sort((a, b) => a.sourceStoreId.localeCompare(b.sourceStoreId)) };
  const identity = JSON.stringify(result);
  const committedIdentity = publicationIdentity(publication);
  result.check = () => {
    checkLifecycle();
    const currentPublication = restoredAuthority();
    if (publicationIdentity(currentPublication) !== committedIdentity) {
      refuse(503, 'storage-unavailable');
    }
    const current = sourceBoundaryFromPublication(currentPublication);
    if (!current || JSON.stringify({ tenantId: current.tenantId, restoreEpoch: current.restoreEpoch,
      sources: current.sources }) !== identity) refuse(503, 'storage-unavailable');
  };
  return result;
}
async function body(req, limit = 16384, overflowStatus = 400) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { req.resume(); refuse(overflowStatus, 'limit-exceeded'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function send(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function handleHealthConnect(req, res, pathname, unavailable = () => null) {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return false;
  try {
    const lifecycle = () => {
      const blocked = unavailable();
      if (blocked) throw new AuthorityError(503, blocked.code, blocked);
    };
    REQUEST_LIFECYCLES.set(req, lifecycle);
    if (pathname.startsWith(`${BASE}/deletions/`)) {
      lifecycle();
      const sessionOwnerId = browser(req), actor = sourcePolicy().resolveBrowser(req);
      if (!actor.established) {
        refuseRetainedLegacyOwner(sessionOwnerId, null, sourceBoundary(lifecycle));
        refuse(403, 'scope-mismatch');
      }
      const ownerId = actor.ownerId;
      const retained = sourceBoundary(lifecycle);
      if (!retained) refuse(503, 'storage-unavailable');
      if (req.method !== 'POST' || !['preview', 'apply', 'selection-preview'].some(action =>
        pathname === `${BASE}/deletions/${action}`)) refuse(400, 'invalid-message');
      const bytes = await body(req, 65536, 413);
      const check = () => {
        try {
          lifecycle();
          if (browser(req) !== sessionOwnerId) refuse(401, 'unauthorised');
          actor.check();
          retained.check();
        } catch (error) {
          if (!(error instanceof AuthorityError)) throw error;
          const failure = new HistoryError(error.status, error.code);
          failure.body = error.body;
          throw failure;
        }
      };
      check();
      const input = decodeJson(bytes);
      const boundary = { ...retained, check };
      let result;
      if (pathname === `${BASE}/deletions/selection-preview`) {
        refuseRetainedLegacyOwner(sessionOwnerId, null, retained);
        const registry = retained.namespaces || [retained];
        const requested = input?.sourceStoreIds;
        const selected = requested === null ? registry.filter(namespace =>
          namespace.sources.some(source => source.ownerId === ownerId)) :
          Array.isArray(requested) && requested.length ? requested.map(sourceStoreId =>
            sourceNamespace(boundary, sourceStoreId)) : [];
        const tenants = new Set(selected.map(namespace => namespace.tenantId));
        if (tenants.size > 1) refuse(409, 'IMPORT_SOURCE_POLICY_CAPABILITY_REQUIRED');
        const scope = selected.length ? { ...boundary, ...selected[0], check } : boundary;
        result = ownerSelection.preview(scope, input, ownerId);
      } else {
        const scope = sourceNamespace(boundary, input?.sourceStoreId);
        ownerDeletion.validate(scope, input, pathname.endsWith('/apply'));
        refuseRetainedLegacyOwner(sessionOwnerId, null, scope);
        const source = scope.sources.find(item => item.sourceStoreId === input.sourceStoreId);
        if (!source || source.ownerId !== ownerId) refuse(403, 'scope-mismatch');
        result = pathname.endsWith('/preview') ? ownerDeletion.preview(scope, input) :
          ownerDeletion.apply(scope, input);
      }
      send(res, result);
      if (result.projectionQueued) scheduleSourceIndex(input.sourceStoreId);
      return true;
    }
    // These browser routes read retained ownership without minting a replacement
    // authority catalogue when saved history has lost its catalogue.
    if (pathname.startsWith(`${BASE}/projections/`)) {
      lifecycle();
      const sessionOwnerId = browser(req), actor = sourcePolicy().resolveBrowser(req);
      if (!actor.established) {
        refuseRetainedLegacyOwner(sessionOwnerId, null, sourceBoundary(lifecycle));
        refuse(403, 'scope-mismatch');
      }
      const ownerId = actor.ownerId;
      const checkedLifecycle = () => { lifecycle(); actor.check(); };
      if (pathname === `${BASE}/projections/status` && req.method === 'GET') {
        const retained = sourceBoundary(checkedLifecycle);
        refuseRetainedLegacyOwner(sessionOwnerId, null, retained);
        send(res, sourceIndex.readStatus(retained, ownerId));
      } else if (pathname === `${BASE}/projections/rebuild` && req.method === 'POST') {
        const bytes = await body(req);
        lifecycle();
        if (!exact(decodeJson(bytes), [])) refuse(400, 'invalid-message');
        if (browser(req) !== sessionOwnerId) refuse(401, 'unauthorised');
        actor.check();
        const retained = sourceBoundary(checkedLifecycle);
        refuseRetainedLegacyOwner(sessionOwnerId, null, retained);
        const queued = sourceIndex.queueRebuild(retained, ownerId);
        send(res, { target: sourceIndex.TARGET, queuedSources: queued.length }, 202);
        for (const sourceStoreId of queued) scheduleSourceIndex(sourceStoreId);
      } else refuse(400, 'invalid-message');
      return true;
    }
    // Corruption fences all authority routes before any grant can be issued.
    let state = load();
    lifecycle();
    if (pathname === `${BASE}/v1/pairing/exchange` && req.method === 'POST') {
      const bytes = await body(req);
      lifecycle();
      const frame = decodeMessage(bytes);
      if (frame.kind !== 'pairing-exchange') refuse(400, 'invalid-message');
      // No await between re-reading current state and committing single use.
      state = load();
      lifecycle();
      const selected = findGrantState(state, frame.grant);
      let result;
      if (selected.managed) {
        const custody = sourcePolicy().captureGrant(frame.grant);
        result = sourcePolicy().updateNamespace(custody, current => {
          checkPolicyLifecycle(req);
          return consumeGrant(current, frame);
        });
      } else {
        assertUnmanagedEnrollment();
        result = consumeGrant(selected.state, frame);
        persist(selected.state);
      }
      send(res, result);
    } else if (/^\/api\/connectors\/health-connect\/v2\/streams\/[A-Z][A-Za-z0-9]{0,95}\/readiness$/
        .test(pathname) && req.method === 'POST') {
      const custody = sourcePolicy().captureReadiness(req);
      const bytes = await body(req);
      lifecycle();
      sourcePolicy().recheckReadiness(custody);
      const stopped = readinessStopRequest(bytes, pathname.split('/').at(-2));
      if (stopped) {
        send(res, sourcePolicy().stopReadiness(custody, stopped));
        return true;
      }
      const readiness = require('./readiness');
      const input = readiness.request(bytes, pathname.split('/').at(-2));
      send(res, readiness.run(custody, input));
    } else if ([`${BASE}/v1/censuses/begin`, `${BASE}/v1/censuses/seal`].includes(pathname) &&
        req.method === 'POST') {
      readPolicyCredential(req);
      const bytes = await body(req, HARD_LIMITS.maxBytes);
      state = load();
      lifecycle();
      const currentAuthority = readPolicyCredential(req);
      state = currentAuthority.state;
      const connector = currentAuthority.connector;
      const action = pathname.endsWith('/begin') ? 'begin' : 'seal';
      const input = decodeJson(bytes);
      const fields = action === 'begin' ? ['coverageJson'] :
        ['coverageJson', 'handle', 'seenNativeRecordIds', 'tokenReset'];
      if (!exact(input, fields) || typeof input.coverageJson !== 'string') refuse(400, 'invalid-message');
      const claim = decodeJson(input.coverageJson);
      if (!claim || typeof claim !== 'object' || Array.isArray(claim)) refuse(400, 'invalid-message');
      const type = claim.recordType;
      if (claim.kind !== 'coverage' || !connector.categories.includes(type)) refuse(403, 'scope-mismatch');
      const generation = req.headers['klebb-health-generation'];
      const epoch = req.headers['klebb-health-restore-epoch'];
      if (!uint(generation) || !uuid(epoch)) refuse(400, 'invalid-message');
      if (generation !== connector.generations[type] || epoch !== state.restoreEpoch) {
        refuse(409, 'binding-mismatch');
      }
      const currentBinding = binding(state, connector, type);
      const ownership = sourceNamespace(sourceBoundary(lifecycle), connector.sourceStoreId,
        409, 'IMPORT_SOURCE_POLICY_UNKNOWN');
      const checkOwnership = ownership.check;
      ownership.check = () => {
        checkOwnership();
        const live = readPolicyCredential(req);
        const currentState = live.state;
        lifecycle();
        const currentConnector = live.connector;
        if (!currentConnector.categories.includes(type) ||
            JSON.stringify(binding(currentState, currentConnector, type)) !== JSON.stringify(currentBinding)) {
          refuse(409, 'binding-mismatch');
        }
      };
      const request = { action, binding: currentBinding, categories: connector.categories,
        coverageJson: input.coverageJson };
      if (action === 'seal') Object.assign(request, { handle: input.handle,
        seenNativeRecordIds: input.seenNativeRecordIds, tokenReset: input.tokenReset });
      const result = readHistorySnapshot((db, present) => {
        try {
          ownership.check();
          if (!present) throw new HistoryError(503, 'storage-unavailable');
          const saved = sourceIndex.savedSource(db, ownership, connector.sourceStoreId, request);
          ownership.check();
          return saved.census;
        } catch (error) {
          if (error instanceof AuthorityError || error instanceof ProtocolError) {
            const failure = new HistoryError(error instanceof AuthorityError ? error.status : 400, error.code);
            failure.body = error.body;
            throw failure;
          }
          throw error;
        }
      });
      if (Buffer.byteLength(JSON.stringify(result)) > HARD_LIMITS.maxBytes) refuse(413, 'limit-exceeded');
      send(res, result);
    } else if (pathname === `${BASE}/v1/batches` && req.method === 'POST') {
      readPolicyCredential(req);
      const bytes = await body(req, HARD_LIMITS.maxBytes);
      // Recheck the live credential, scope and import fence after reading the
      // asynchronous body. No await separates this check from the transaction.
      state = load();
      lifecycle();
      const currentAuthority = readPolicyCredential(req);
      state = currentAuthority.state;
      const connector = currentAuthority.connector;
      const frame = decodeMessage(bytes);
      if (frame.kind !== 'batch') refuse(400, 'invalid-message');
      const payload = decodeJson(frame.payloadJson);
      const type = payload.recordType;
      if (!connector.categories.includes(type)) refuse(403, 'scope-mismatch');
      const generation = req.headers['klebb-health-generation'];
      const epoch = req.headers['klebb-health-restore-epoch'];
      if (!uint(generation) || !uuid(epoch)) refuse(400, 'invalid-message');
      if (generation !== connector.generations[type] || epoch !== state.restoreEpoch) {
        refuse(409, 'binding-mismatch');
      }
      decodeMessage(bytes, { binding: binding(state, connector, type), categories: connector.categories });
      const admission = sourcePolicy().hasPolicyFamily() ? sourcePolicy().captureAdmission(req) : undefined;
      send(res, commitBatch(payload, frame.payloadDigest, admission));
      scheduleSourceIndex(connector.sourceStoreId);
    } else if ([`${BASE}/v1/object-parts`, `${BASE}/v1/object-finalise`].includes(pathname) &&
        req.method === 'POST') {
      readPolicyCredential(req);
      const bytes = await body(req, HARD_LIMITS.maxBytes);
      state = load();
      lifecycle();
      const currentAuthority = readPolicyCredential(req);
      state = currentAuthority.state;
      const connector = currentAuthority.connector;
      const frame = decodeMessage(bytes);
      const kind = pathname.endsWith('/object-parts') ? 'object-part' : 'object-finalise';
      if (frame.kind !== kind) refuse(400, 'invalid-message');
      const type = frame.recordType;
      if (!connector.categories.includes(type)) refuse(403, 'scope-mismatch');
      const generation = req.headers['klebb-health-generation'];
      const epoch = req.headers['klebb-health-restore-epoch'];
      if (!uint(generation) || !uuid(epoch)) refuse(400, 'invalid-message');
      if (generation !== connector.generations[type] || epoch !== state.restoreEpoch) {
        refuse(409, 'binding-mismatch');
      }
      decodeMessage(bytes, { binding: binding(state, connector, type),
        categories: connector.categories, limits: OBJECT_LIMITS });
      // Reconstruction and SQL are synchronous: there is no await between
      // the current authority/import fence above and the complete commit.
      const admission = sourcePolicy().hasPolicyFamily() ? sourcePolicy().captureAdmission(req) : undefined;
      send(res, kind === 'object-part' ? stagePart(frame, admission) : finaliseObject(frame, admission));
      if (kind === 'object-finalise') scheduleSourceIndex(connector.sourceStoreId);
    } else if (pathname === `${BASE}/v1/capabilities` && req.method === 'GET') {
      const currentAuthority = readPolicyCredential(req);
      state = currentAuthority.state;
      const connector = currentAuthority.connector;
      send(res, { version: 1, kind: 'capabilities', destination: destination(),
        tenantId: state.tenantId, instanceId: state.instanceId, restoreEpoch: state.restoreEpoch,
        connectorId: connector.id, sourceStoreId: connector.sourceStoreId,
        installationId: connector.installationId, categories: connector.categories,
        supportedVersions: [1], limits: OBJECT_LIMITS,
        serializers: [{ id: 'health-connect-record', version: 1, dataFamily: 'ordinary' }],
        streams: streams(state, connector) });
    } else if (/^\/api\/connectors\/health-connect\/v1\/streams\/[A-Z][A-Za-z0-9]{0,95}\/status$/
      .test(pathname) && req.method === 'GET') {
      const currentAuthority = readPolicyCredential(req);
      state = currentAuthority.state;
      const connector = currentAuthority.connector;
      const type = pathname.split('/').at(-2);
      if (!connector.categories.includes(type)) refuse(403, 'scope-mismatch');
      const generation = req.headers['klebb-health-generation'];
      const epoch = req.headers['klebb-health-restore-epoch'];
      if (!uint(generation) || typeof epoch !== 'string' || !UUID.test(epoch)) refuse(400, 'invalid-message');
      if (generation !== connector.generations[type] || epoch !== state.restoreEpoch) refuse(409, 'binding-mismatch');
      send(res, { version: 1, kind: 'stream-status', binding: binding(state, connector, type),
        recordType: type, generation,
        acknowledgedSequence: readFrontiers([{ binding: binding(state, connector, type), recordType: type }])[0] });
    } else {
      const ownerId = browser(req);
      if (pathname === BASE && req.method === 'GET') {
        namespaces();
        refuseRetainedLegacyOwner(ownerId, state, sourceBoundary(lifecycle));
        send(res, { version: 1, kind: 'connector-list', destination: destination(),
          connectors: [
            ...state.connectors.filter(item => item.ownerId === ownerId),
            ...(() => {
              const actor = sourcePolicy().resolveBrowser(req);
              if (!actor.established) return [];
              actor.check();
              return namespaces().filter(entry => entry.ownerId === actor.ownerId)
                .flatMap(entry => entry.state.connectors);
            })(),
          ].map(item => ({
            id: item.id, name: item.name, categories: item.categories,
            createdAt: item.createdAt, revokedAt: item.revokedAt,
          })) });
      } else if (pathname === `${BASE}/pairing-grants` && req.method === 'POST') {
        const enrolmentActor = sourcePolicy().resolveBrowser(req);
        const familyAtEntry = sourcePolicy().hasPolicyFamily();
        const bytes = await body(req);
        lifecycle();
        enrolmentActor.check();
        if (sourcePolicy().hasPolicyFamily() !== familyAtEntry) {
          refuse(409, 'IMPORT_SOURCE_POLICY_VERIFIER_REQUIRED');
        }
        const input = decodeJson(bytes);
        if (!exact(input, ['categories', 'name']) || !categories(input.categories) ||
            !nameValid(input.name)) refuse(400, 'invalid-message');
        if (browser(req) !== ownerId) refuse(401, 'unauthorised');
        state = load();
        lifecycle();
        const origin = destination();
        namespaces();
        // New stopped namespaces are bound to current registered membership.
        // Retained owner labels cannot grant authority over the old namespace.
        const retained = sourceBoundary(lifecycle);
        if (!familyAtEntry) refuseRetainedLegacyOwner(ownerId, state, retained);
        {
          const actor = enrolmentActor;
          actor.check();
          const enrolled = sourcePolicy().enrolStopped(req, input.categories, undefined, actor.actor);
          checkPolicyLifecycle(req);
          const result = sourcePolicy().updateNamespace(enrolled.namespaceAuthority, current => {
            checkPolicyLifecycle(req);
            if (current.tenantId !== enrolled.tenantId || current.instanceId !== enrolled.instanceId ||
                current.restoreEpoch !== enrolled.restoreEpoch) refuse(409, 'binding-mismatch');
            const secret = crypto.randomBytes(32).toString('base64url');
            const expiresAt = new Date(Date.now() + 300000).toISOString();
            current.grants = current.grants.filter(item => Date.parse(item.expiresAt) > Date.now());
            if (current.grants.length >= MAX_GRANTS) refuse(400, 'limit-exceeded');
            current.grants.push({ verifier: payloadDigest(secret), ownerId: enrolled.ownerId,
              instanceId: current.instanceId, sourceStoreId: enrolled.sourceStoreId,
              restoreEpoch: current.restoreEpoch, categories: input.categories,
              name: input.name.trim(), expiresAt, consumedAt: null });
            return { version: 1, kind: 'pairing-grant', destination: origin,
              tenantId: current.tenantId, instanceId: current.instanceId,
              sourceStoreId: enrolled.sourceStoreId, restoreEpoch: current.restoreEpoch,
              grant: secret, expiresAt, categories: input.categories, limits: OBJECT_LIMITS };
          });
          send(res, result, 201);
        }
      } else if (req.method === 'DELETE' && pathname.startsWith(`${BASE}/`) &&
          UUID.test(pathname.slice(BASE.length + 1))) {
        const connectorId = pathname.slice(BASE.length + 1);
        const legacy = state.connectors.find(item => item.id === connectorId);
        const retained = namespaces().filter(entry => entry.state.connectors.some(item => item.id === connectorId));
        if (retained.length > 1 || (legacy && retained.length)) refuse(503, 'storage-unavailable');
        if (legacy) {
          if (legacy.ownerId !== ownerId) refuse(403, 'scope-mismatch');
          refuseRetainedLegacyOwner(ownerId, state);
          legacy.revokedAt = legacy.revokedAt || new Date().toISOString();
          persist(state);
        } else {
          const actor = sourcePolicy().resolveBrowser(req), entry = retained[0];
          if (!entry || !actor.established || entry.ownerId !== actor.ownerId) refuse(403, 'scope-mismatch');
          actor.check();
          const custody = sourcePolicy().namespaceAuthority(actor.actor, entry.state.tenantId);
          sourcePolicy().updateNamespace(custody, current => {
            checkPolicyLifecycle(req);
            const connector = current.connectors.find(item => item.id === connectorId);
            if (!connector || connector.ownerId !== actor.ownerId) refuse(403, 'scope-mismatch');
            connector.revokedAt = connector.revokedAt || new Date().toISOString();
          });
        }
        send(res, { revoked: true });
      } else refuse(400, 'invalid-message');
    }
  } catch (error) {
    const status = error instanceof AuthorityError || error instanceof HistoryError ? error.status :
      error instanceof ProtocolError ? 400 : 503;
    const code = error instanceof AuthorityError || error instanceof HistoryError || error instanceof ProtocolError ?
      error.code : 'storage-unavailable';
    send(res, error.body || (pathname.startsWith(`${BASE}/projections/`) ?
      { target: sourceIndex.TARGET, code, retryable: status === 503 } :
      { version: pathname.startsWith(`${BASE}/v2/`) ? 2 : 1,
        kind: 'error', code, retryable: status === 503 }), status);
    req.resume();
  } finally {
    REQUEST_LIFECYCLES.delete(req);
  }
  return true;
}
module.exports = { handleHealthConnect, sourceBoundary, readPolicyCredential, checkPolicyLifecycle, bindBrowserRead };
