// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const crypto = require('node:crypto');
const { HistoryError } = require('./history');
const { decodeMessage, decodeJson, nativeKey, HARD_LIMITS } = require('./protocol');
const { footprint } = require('./deletion-admission');
const { instant } = require('./selection-time');
const pending = new Map();
const parts = ['tenantId', 'instanceId', 'sourceStoreId', 'installationId', 'generation', 'restoreEpoch'];
const fail = (status = 400, code = 'invalid-message') => { throw new HistoryError(status, code); };
const canonical = b => JSON.stringify(parts.map(k => b[k]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scalar = s => typeof s === 'string' && [...s].length >= 1 && [...s].length <= 256 && !/[\uD800-\uDFFF]/u.test(s);
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !equal(Object.keys(value).sort(), [...keys].sort())) fail();
}
function range(period, window) {
  if (!period) return null;
  const start = instant(window.start), end = instant(window.end);
  if (period.kind === 'instant') {
    const time = instant(period.time);
    return time === null ? null : time >= start && time < end;
  }
  const first = instant(period.startTime), last = instant(period.endTime);
  return first === null || last === null || first >= last ? null : first < end && last > start;
}
function snapshot(db, binding, type, query) {
  const scope = [binding.tenantId, binding.sourceStoreId, type];
  const stats = db.prepare('SELECT count(*) n, coalesce(sum(length(CAST(record_json AS BLOB))),0) bytes '
    + 'FROM health_records WHERE tenant_id=? AND source_store_id=? AND record_type=?').get(...scope);
  if (stats.n > 500 || stats.bytes > HARD_LIMITS.maxObjectBytes) fail(413, 'limit-exceeded');
  const rows = db.prepare('SELECT native_record_id, data_family, record_json FROM health_records '
    + 'WHERE tenant_id=? AND source_store_id=? AND record_type=? ORDER BY native_record_id LIMIT 501').all(...scope);
  if (rows.length > 500) fail(413, 'limit-exceeded');
  return rows.map(row => {
    const identity = { tenantId: binding.tenantId, sourceStoreId: binding.sourceStoreId,
      recordType: type, nativeRecordId: row.native_record_id };
    const key = nativeKey(identity);
    if (typeof row.record_json !== 'string') fail(503, 'storage-unavailable');
    const hash = crypto.createHash('sha256').update(row.record_json).digest('hex');
    let record, period;
    try {
      record = decodeJson(row.record_json);
      if (row.data_family !== 'ordinary' || record.metadata?.id !== identity.nativeRecordId) record = null;
      const text = footprint(db, identity, (status, code) => fail(status, code), true);
      period = text === null ? null : decodeJson(text);
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      record = null; period = null;
    }
    let inside = record ? range(period, query.window) : null;
    if (inside && query.dataOrigins.length) {
      const origin = typeof record.metadata?.dataOrigin === 'string' ? record.metadata.dataOrigin :
        record.metadata?.dataOrigin?.packageName;
      inside = typeof origin !== 'string' ? null : query.dataOrigins.includes(origin);
    }
    return { key, hash, inside };
  });
}
function ordinaryCensus(db, boundary, sourceStoreId, saved, request) {
  const sealing = request?.action === 'seal';
  exact(request, sealing ? ['action','binding','categories','coverageJson','handle','seenNativeRecordIds','tokenReset'] :
    ['action','binding','categories','coverageJson']);
  if (!['begin','seal'].includes(request.action) || !saved.complete || !Array.isArray(saved.frontiers)) fail(503, 'storage-unavailable');
  exact(request.binding, parts);
  if (request.binding.tenantId !== boundary.tenantId || request.binding.sourceStoreId !== sourceStoreId ||
      request.binding.restoreEpoch !== boundary.restoreEpoch) fail(409, 'binding-mismatch');
  if (!Array.isArray(request.categories) || typeof request.coverageJson !== 'string' ||
      Buffer.byteLength(request.coverageJson) > HARD_LIMITS.maxBytes) fail();
  const original = decodeJson(request.coverageJson);
  const frontier = saved.frontiers.find(f => f.recordType === original.recordType && canonical(f.binding) === canonical(request.binding));
  const acknowledged = frontier?.acknowledgedSequence || '0';
  const context = { binding: request.binding, categories: request.categories,
    rawFrontiers: { [original.recordType]: acknowledged } };
  let message, incomplete = false;
  try { message = decodeMessage(request.coverageJson, context); }
  catch (error) {
    if (error.code === 'binding-mismatch') fail(409, 'binding-mismatch');
    if (error.code !== 'incomplete-coverage') throw error;
    incomplete = true;
    message = decodeMessage(JSON.stringify({ ...original, status: 'partial' }), context);
  }
  if (message.kind !== 'coverage') fail();
  if (message.rawFrontier !== acknowledged) fail(409, 'binding-mismatch');
  const query = decodeJson(message.queryJson);
  const allowed = ['recordType','window','dataOrigins','historyStart','features','importStart'];
  if (Object.keys(query).some(k => !allowed.includes(k)) ||
      Object.entries(query.features).some(([k,v]) => !['history','backgroundRead'].includes(k) || typeof v !== 'boolean')) fail();
  // A narrower import policy cannot silently broaden this membership scope.
  if (query.importStart !== undefined && instant(query.importStart) > instant(query.window.start)) fail();
  const current = snapshot(db, request.binding, message.recordType, query);
  if (acknowledged === '0' && current.length) fail(409, 'binding-mismatch');
  const vector = JSON.stringify(saved.frontiers);
  const scope = canonical(request.binding) + message.recordType;
  const result = phase => ({ phase, seenNativeKeys: [], unseenNativeKeys: [], unresolvedNativeKeys: [],
    nativeCompleteness: 'unverified', deletionEligible: false });
  if (!sealing) {
    if (message.status !== 'partial') fail();
    for (const [handle, prior] of pending) if (prior.scope === scope) pending.delete(handle);
    if (pending.size >= 32) fail(413, 'limit-exceeded');
    const handle = crypto.randomBytes(32).toString('base64url');
    pending.set(handle, { scope, binding: canonical(request.binding), vector, query: message.queryJson,
      fingerprint: message.permissionFingerprintStart, current });
    return { handle, phase: 'begun', nativeCompleteness: 'unverified', deletionEligible: false };
  }
  if (typeof request.handle !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.handle) ||
      !Array.isArray(request.seenNativeRecordIds) || request.seenNativeRecordIds.length > 500 ||
      typeof request.tokenReset !== 'boolean') fail();
  const prior = pending.get(request.handle);
  if (!prior || prior.scope !== scope || prior.binding !== canonical(request.binding)) fail(409, 'binding-mismatch');
  pending.delete(request.handle);
  if (prior.vector !== vector || prior.query !== message.queryJson ||
      prior.fingerprint !== message.permissionFingerprintStart || !equal(prior.current, current)) fail(409, 'binding-mismatch');
  const keys = new Set();
  for (const id of request.seenNativeRecordIds) {
    if (!scalar(id)) fail();
    const key = nativeKey({ tenantId: request.binding.tenantId, sourceStoreId,
      recordType: message.recordType, nativeRecordId: id });
    if (keys.has(key) || !current.some(row => row.key === key && row.inside === true)) fail();
    keys.add(key);
  }
  if (message.status !== 'complete' || incomplete || request.tokenReset) return result('incomplete');
  const output = result('complete');
  output.seenNativeKeys = [...keys].sort();
  for (const row of current) {
    if (row.inside === null) output.unresolvedNativeKeys.push(row.key);
    else if (row.inside && !keys.has(row.key)) output.unseenNativeKeys.push(row.key);
  }
  output.unseenNativeKeys.sort(); output.unresolvedNativeKeys.sort();
  if (Buffer.byteLength(JSON.stringify(output)) > HARD_LIMITS.maxBytes) fail(413, 'limit-exceeded');
  return output;
}
module.exports = { ordinaryCensus };
