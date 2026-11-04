// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { decodeJson, payloadDigest } = require('./protocol');
const { HistoryError } = require('./history');
const TYPES = new Set(require('../../config/health-connect-categories.json'));
const INT64 = /^(0|[1-9][0-9]{0,18})$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const MAX = 9223372036854775807n;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code = 'invalid-message', status = 400) => { throw new HistoryError(status, code); };
const uint = value => typeof value === 'string' && INT64.test(value) && BigInt(value) <= MAX;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const digest = value => typeof value === 'string' && SHA.test(value);
const bindKeys = ['tenantId', 'instanceId', 'sourceStoreId', 'installationId', 'generation', 'restoreEpoch'];

function request(bytes, type) {
  if (!TYPES.has(type)) fail('scope-mismatch', 403);
  const value = decodeJson(bytes);
  if (!value || value.version !== 2 || value.recordType !== type) fail();
  if (value.kind === 'readiness-begin') {
    if (!exact(value, ['version', 'kind', 'recordType', 'binding', 'policyRevision',
      'queryJson', 'filterDigest']) || !exact(value.binding, bindKeys) || !uint(value.policyRevision) ||
        typeof value.queryJson !== 'string' || !digest(value.filterDigest)) fail();
    if (payloadDigest(value.queryJson) !== value.filterDigest) fail('digest-mismatch');
    const query = decodeJson(Buffer.from(value.queryJson));
    // Every category query describes one bounded ordinary read, never unlimited readable history.
    if (!exact(query, ['recordType', 'window', 'pageSize']) || query.recordType !== type ||
        !exact(query.window, ['start', 'end']) || !time(query.window.start) || !time(query.window.end) ||
        Date.parse(query.window.start) >= Date.parse(query.window.end) || !Number.isInteger(query.pageSize) ||
        query.pageSize < 1 || query.pageSize > 500) fail();
    return Object.freeze({ ...value, query: Object.freeze({
      recordType: type, window: Object.freeze({ ...query.window }), pageSize: query.pageSize,
    }) });
  }
  if (value.kind === 'readiness-status') {
    if (!exact(value, ['version', 'kind', 'recordType', 'binding']) ||
        !exact(value.binding, bindKeys)) fail();
    return value;
  }
  if (value.kind !== 'readiness-complete' ||
      !exact(value, ['version', 'kind', 'recordType', 'readinessId', 'binding', 'policyRevision',
        'filterDigest', 'firstPage']) || typeof value.readinessId !== 'string' ||
      !/^hc_ready_[A-Za-z0-9_-]{43}$/.test(value.readinessId) ||
      !exact(value.binding, bindKeys) || !uint(value.policyRevision) || !digest(value.filterDigest)) fail();
  const first = value.firstPage;
  if (!exact(first, ['localReadRevision', 'recordCount', 'terminalPage', 'permissionFingerprintStart',
    'permissionFingerprintEnd', 'tokenValid', 'historyWindowLimited', 'interveningChangeCount',
    'changesHaveMore']) || first.localReadRevision !== '1' || !uint(first.recordCount) ||
      !uint(first.interveningChangeCount) || typeof first.terminalPage !== 'boolean' ||
      typeof first.historyWindowLimited !== 'boolean' || typeof first.changesHaveMore !== 'boolean' ||
      first.tokenValid !== true || !digest(first.permissionFingerprintStart) ||
      first.permissionFingerprintStart !== first.permissionFingerprintEnd) fail('readiness-unverified', 409);
  return value;
}

function run(custody, input) {
  const policy = require('./source-policy');
  if (input.kind === 'readiness-begin') return policy.beginReadiness(custody, input);
  if (input.kind === 'readiness-complete') return policy.completeReadiness(custody, input);
  return policy.readinessStatus(custody, input);
}

module.exports = { request, run };
