// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeJson, decodeMessage, payloadDigest, HARD_LIMITS, ProtocolError } = require('./protocol');
const { CREDENTIALS_DIR } = require('../../config/paths');
const ENV = require('../../config/env');
const { getSessionRecord } = require('../../auth/webauthn');
const { originAllowed } = require('../origin-check');
const { isHealthConnectorBearer } = require('../../auth/bearer-scope');
const { commitBatch, readFrontiers, HistoryError } = require('./history');
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
class AuthorityError extends Error {
  constructor(status, code, body) {
    super(code); this.status = status; this.code = code; this.body = body;
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
function load() {
  try {
    if (fs.statSync(FILE).size > HARD_LIMITS.maxBytes) refuse(503, 'storage-unavailable');
    const state = decodeJson(fs.readFileSync(FILE));
    if (!validState(state)) refuse(503, 'storage-unavailable');
    return JSON.parse(JSON.stringify(state));
  } catch (error) {
    if (error.code !== 'ENOENT') refuse(503, 'storage-unavailable');
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
function credential(state, req) {
  const value = /^Bearer (klebb_hc1_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
  if (!value) refuse(401, 'unauthorised');
  const verifier = payloadDigest(value);
  const connector = state.connectors.find(item => safeEqual(item.credentialVerifier, verifier));
  if (!connector) refuse(401, 'unauthorised');
  if (connector.revokedAt || connector.restoreEpoch !== state.restoreEpoch) refuse(401, 'revoked');
  if (req.headers['klebb-health-protocol'] !== '1') refuse(400, 'unsupported-version');
  return connector;
}
function browser(req) {
  if (isHealthConnectorBearer(req)) refuse(401, 'unauthorised');
  const session = getSessionRecord(req);
  if (!session || !id(session.userId)) refuse(401, 'unauthorised');
  if (!originAllowed(req)) refuse(403, 'scope-mismatch');
  return session.userId;
}
async function body(req, limit = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { req.resume(); refuse(400, 'limit-exceeded'); }
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
      persist(state);
      send(res, result);
    } else if (pathname === `${BASE}/v1/batches` && req.method === 'POST') {
      credential(state, req);
      const bytes = await body(req, HARD_LIMITS.maxBytes);
      // Recheck the live credential, scope and import fence after reading the
      // asynchronous body. No await separates this check from the transaction.
      state = load();
      lifecycle();
      const connector = credential(state, req);
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
      send(res, commitBatch(payload, frame.payloadDigest));
    } else if (pathname === `${BASE}/v1/capabilities` && req.method === 'GET') {
      const connector = credential(state, req);
      send(res, { version: 1, kind: 'capabilities', destination: destination(),
        tenantId: state.tenantId, instanceId: state.instanceId, restoreEpoch: state.restoreEpoch,
        connectorId: connector.id, sourceStoreId: connector.sourceStoreId,
        installationId: connector.installationId, categories: connector.categories,
        supportedVersions: [1], limits: HARD_LIMITS,
        serializers: [{ id: 'health-connect-record', version: 1, dataFamily: 'ordinary' }],
        streams: streams(state, connector) });
    } else if (/^\/api\/connectors\/health-connect\/v1\/streams\/[A-Z][A-Za-z0-9]{0,95}\/status$/
      .test(pathname) && req.method === 'GET') {
      const connector = credential(state, req);
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
        send(res, { version: 1, kind: 'connector-list', destination: destination(),
          connectors: state.connectors.filter(item => item.ownerId === ownerId).map(item => ({
            id: item.id, name: item.name, categories: item.categories,
            createdAt: item.createdAt, revokedAt: item.revokedAt,
          })) });
      } else if (pathname === `${BASE}/pairing-grants` && req.method === 'POST') {
        const bytes = await body(req);
        lifecycle();
        const input = decodeJson(bytes);
        if (!exact(input, ['categories', 'name']) || !categories(input.categories) ||
            !nameValid(input.name)) refuse(400, 'invalid-message');
        if (browser(req) !== ownerId) refuse(401, 'unauthorised');
        state = load();
        lifecycle();
        const origin = destination();
        const secret = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 300000).toISOString();
        const approved = { verifier: payloadDigest(secret), ownerId, instanceId: state.instanceId,
          sourceStoreId: crypto.randomUUID(), restoreEpoch: state.restoreEpoch,
          categories: input.categories, name: input.name.trim(), expiresAt, consumedAt: null };
        state.grants = state.grants.filter(item => Date.parse(item.expiresAt) > Date.now());
        if (state.grants.length >= MAX_GRANTS) refuse(400, 'limit-exceeded');
        state.grants.push(approved);
        persist(state);
        send(res, { version: 1, kind: 'pairing-grant', destination: origin,
          tenantId: state.tenantId, instanceId: state.instanceId,
          sourceStoreId: approved.sourceStoreId, restoreEpoch: state.restoreEpoch,
          grant: secret, expiresAt, categories: approved.categories, limits: HARD_LIMITS }, 201);
      } else if (req.method === 'DELETE' && pathname.startsWith(`${BASE}/`) &&
          UUID.test(pathname.slice(BASE.length + 1))) {
        const connector = state.connectors.find(item => item.id === pathname.slice(BASE.length + 1));
        if (!connector || connector.ownerId !== ownerId) refuse(403, 'scope-mismatch');
        connector.revokedAt = connector.revokedAt || new Date().toISOString();
        persist(state);
        send(res, { revoked: true });
      } else refuse(400, 'invalid-message');
    }
  } catch (error) {
    const status = error instanceof AuthorityError || error instanceof HistoryError ? error.status :
      error instanceof ProtocolError ? 400 : 503;
    const code = error instanceof AuthorityError || error instanceof HistoryError || error instanceof ProtocolError ?
      error.code : 'storage-unavailable';
    send(res, error.body || { version: 1, kind: 'error', code, retryable: status === 503 }, status);
    req.resume();
  }
  return true;
}
module.exports = { handleHealthConnect };
