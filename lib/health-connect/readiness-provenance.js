// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const crypto = require('node:crypto');
const { getSessionSecret } = require('../../config/env');
const { HistoryError } = require('./history');
const TYPES = new Set(require('../../config/health-connect-categories.json'));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAC = /^hmac-sha256:[a-f0-9]{64}$/;
const FIELDS = ['tenantId', 'ownerId', 'instanceId', 'sourceStoreId', 'installationId',
  'recordType', 'restoreEpoch', 'generation', 'queryDigest', 'reportDigest'];
const id = value => typeof value === 'string' && value.length > 0 &&
  [...value].length <= 256 && !/[\uD800-\uDFFF]/u.test(value);
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

function tupleText(tuple) {
  if (!tuple || typeof tuple !== 'object' || Array.isArray(tuple) ||
      Object.keys(tuple).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(tuple, key)) ||
      !['tenantId', 'instanceId', 'sourceStoreId', 'restoreEpoch'].every(key =>
        typeof tuple[key] === 'string' && UUID.test(tuple[key])) ||
      !id(tuple.ownerId) || !id(tuple.installationId) || !TYPES.has(tuple.recordType) ||
      !uint(tuple.generation) ||
      typeof tuple.queryDigest !== 'string' || !DIGEST.test(tuple.queryDigest) ||
      typeof tuple.reportDigest !== 'string' || !DIGEST.test(tuple.reportDigest)) {
    throw new HistoryError(409, 'binding-mismatch');
  }
  // The domain and fixed field order separate this proof from browser-session signatures.
  return JSON.stringify(['health-connect-readiness-v2', ...FIELDS.map(key => tuple[key])]);
}

function mac(tuple) {
  const text = tupleText(tuple);
  const secret = getSessionSecret();
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new HistoryError(503, 'storage-unavailable');
  }
  return 'hmac-sha256:' + crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

function verify(tuple, proof) {
  if (typeof proof !== 'string' || !MAC.test(proof)) return false;
  const expected = Buffer.from(mac(tuple).slice(12), 'hex');
  const actual = Buffer.from(proof.slice(12), 'hex');
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { mac, verify };
