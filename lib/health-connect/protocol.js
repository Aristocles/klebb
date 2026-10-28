// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const schema = require('../../schemas/health-connect/protocol-v1.schema.json');
const HARD_LIMITS = Object.freeze({ maxBytes: 1048576, maxChanges: 500, maxDepth: 16,
  maxNodes: 20000, maxSamples: 10000, maxParts: 128, maxObjectBytes: 67108864 });
const DEFAULT_SERIALIZERS = Object.freeze([
  Object.freeze({ id: 'health-connect-record', version: 1, dataFamily: 'ordinary' })
]);
const KINDS = Object.freeze({ capabilities: 'capabilities', 'pairing-grant': 'pairingGrant',
  'pairing-exchange': 'pairingExchange', batch: 'batch', coverage: 'coverage',
  aggregate: 'aggregate', 'object-part': 'objectPart', 'object-finalise': 'objectFinalise',
  error: 'error' });
const scalar = text => !/[\uD800-\uDFFF]/u.test(text);
class ProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.path = '$';
  }
}
function fail(code = 'invalid-message') { throw new ProtocolError(code); }
function payloadDigest(text) {
  if (typeof text !== 'string' || !scalar(text)) fail();
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
function nativeKey(identity) {
  if (!identity || typeof identity !== 'object') fail();
  const { tenantId, sourceStoreId, recordType, nativeRecordId } = identity;
  if (!matches(schema.$defs.identity, { tenantId, sourceStoreId, recordType, nativeRecordId })) fail();
  return JSON.stringify([tenantId, sourceStoreId, recordType, nativeRecordId]);
}
function limitsFor(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) fail();
  const limits = { ...HARD_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isInteger(value) || value < 1 ||
        value > HARD_LIMITS[key]) fail('limit-exceeded');
    limits[key] = value;
  }
  return limits;
}

// Parse bounded JSON before materialising deeply nested values. Only string tokens
// use JSON.parse; decimal/exponent number tokens are rejected before conversion.
function parse(text, limits, budget, initialDepth = 1) {
  let position = 0;
  const space = () => { while (/[ \t\r\n]/.test(text[position] || '\0')) position++; };
  const node = () => { if (++budget.nodes > limits.maxNodes) fail('limit-exceeded'); };
  function string() {
    const start = position++;
    let escaped = false;
    while (position < text.length) {
      const char = text[position++];
      if (!escaped && char === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, position)); } catch { fail(); }
        if (!scalar(value)) fail();
        return value;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    fail();
  }
  function value(depth) {
    if (depth > limits.maxDepth) fail('limit-exceeded');
    node();
    space();
    const char = text[position];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      position++;
      const object = char === '{';
      const result = object ? Object.create(null) : [];
      const close = object ? '}' : ']';
      space();
      if (text[position] === close) { position++; return result; }
      while (position < text.length) {
        let key;
        if (object) {
          space();
          if (text[position] !== '"') fail();
          node();
          key = string();
          if (Object.hasOwn(result, key)) fail();
          space();
          if (text[position++] !== ':') fail();
        }
        const child = value(depth + 1);
        if (object) result[key] = child;
        else result.push(child);
        space();
        if (text[position] === close) { position++; return result; }
        if (text[position++] !== ',') fail();
      }
      fail();
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, position)) { position += token.length; return result; }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/
      .exec(text.slice(position))?.[0];
    if (!token || /[.eE]/.test(token) || !Number.isSafeInteger(Number(token))) fail();
    position += token.length;
    return Number(token);
  }
  const result = value(initialDepth);
  space();
  if (position !== text.length) fail();
  return result;
}

// Deliberately limited to the keywords used by the published schema, not a
// general JSON Schema implementation. Runtime semantics are checked below.
function matches(rule, value) {
  if (rule.$ref) return matches(schema.$defs[rule.$ref.split('/').at(-1)], value);
  if (rule.oneOf) return rule.oneOf.filter(candidate => matches(candidate, value)).length === 1;
  if (Object.hasOwn(rule, 'const') && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (rule.type && (rule.type === 'integer' ? !Number.isSafeInteger(value) : type !== rule.type)) {
    return false;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (!scalar(value) || (rule.minLength !== undefined && length < rule.minLength) ||
        (rule.maxLength !== undefined && length > rule.maxLength) ||
        (rule.pattern && !new RegExp(rule.pattern).test(value))) return false;
    if (rule === schema.$defs.int64 && BigInt(value) > 9223372036854775807n) return false;
    if (rule === schema.$defs.instant && !validInstant(value)) return false;
  }
  if (typeof value === 'number' && ((rule.minimum !== undefined && value < rule.minimum) ||
      (rule.maximum !== undefined && value > rule.maximum))) return false;
  if (Array.isArray(value)) {
    if ((rule.minItems !== undefined && value.length < rule.minItems) ||
        (rule.maxItems !== undefined && value.length > rule.maxItems) ||
        (rule.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length)) {
      return false;
    }
    if (rule.items && !value.every(item => matches(rule.items, item))) return false;
  }
  if (type === 'object') {
    const keys = Object.keys(value);
    if (rule.minProperties !== undefined && keys.length < rule.minProperties) return false;
    if (rule.required?.some(key => !Object.hasOwn(value, key))) return false;
    for (const key of keys) {
      if (rule.properties && Object.hasOwn(rule.properties, key)) {
        if (!matches(rule.properties[key], value[key])) return false;
      } else if (rule.additionalProperties === false) return false;
    }
  }
  return true;
}
function validInstant(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!match) return false;
  const [, y, m, d, h, minute, second] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(h) < 24 && Number(minute) < 60 && Number(second) < 60;
}
function instantKey(text) {
  const [whole, fraction = ''] = text.slice(0, -1).split('.');
  return `${whole}.${fraction.padEnd(9, '0')}`;
}
function windowValid(window) {
  if (instantKey(window.start) >= instantKey(window.end)) fail();
}
function bind(binding, context) {
  if (context.binding && Object.keys(schema.$defs.binding.properties).some(key =>
    binding[key] !== context.binding[key])) fail('binding-mismatch');
}
function scoped(recordType, context) {
  if (context.categories && !context.categories.includes(recordType)) fail('scope-denied');
}
function identityBound(identity, binding, recordType) {
  if (identity.tenantId !== binding.tenantId || identity.sourceStoreId !== binding.sourceStoreId ||
      identity.recordType !== recordType) fail('binding-mismatch');
}
function rawRecord(record, limits, budget, dataFamily) {
  if (dataFamily === 'ordinary' && record.metadata &&
      Object.hasOwn(record.metadata, 'clientRecordVersion') &&
      !matches(schema.$defs.int64, record.metadata.clientRecordVersion)) fail();
  function visit(value, key = '') {
    if (Array.isArray(value)) {
      budget.samples += value.length;
      if (budget.samples > limits.maxSamples) fail('limit-exceeded');
      value.forEach(item => visit(item));
    } else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        visit(child, name);
      }
      if (dataFamily === 'ordinary' && typeof value.startTime === 'string' &&
          typeof value.endTime === 'string') {
        windowValid({ start: value.startTime, end: value.endTime });
      }
      if (dataFamily === 'ordinary' && Object.hasOwn(value, 'value') && Object.hasOwn(value, 'unit') &&
          !matches(schema.$defs.decimal, value.value)) fail();
    } else {
      if (typeof value === 'number' && (value < -2147483648 || value > 2147483647)) fail();
      if (dataFamily === 'ordinary' && ['time', 'startTime', 'endTime', 'lastModifiedTime'].includes(key) &&
          !matches(schema.$defs.instant, value)) fail();
    }
  }
  visit(record);
}
function queryRecord(message, limits, budget) {
  if (payloadDigest(message.queryJson) !== message.filterDigest) fail('digest-mismatch');
  const query = parse(message.queryJson, limits, budget, 2);
  if (!matches(schema.$defs.query, query)) fail();
  if (query.recordType !== message.recordType || query.window.start !== message.window.start ||
      query.window.end !== message.window.end) fail('binding-mismatch');
  function arrays(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      budget.samples += value.length;
      if (budget.samples > limits.maxSamples) fail('limit-exceeded');
    }
    Object.values(value).forEach(arrays);
  }
  arrays(query);
  return query;
}
function frontier(message, field, context) {
  const saved = context.rawFrontiers?.[message.recordType];
  if (!matches(schema.$defs.int64, saved) || BigInt(saved) < BigInt(message[field])) {
    fail('frontier-lag');
  }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function decodeMessage(input, context = {}) {
  const limits = limitsFor(context.limits);
  let text;
  if (Buffer.isBuffer(input)) {
    if (input.length > limits.maxBytes) fail('limit-exceeded');
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { fail(); }
  } else if (typeof input === 'string' && scalar(input)) {
    if (Buffer.byteLength(input, 'utf8') > limits.maxBytes) fail('limit-exceeded');
    text = input;
  } else fail();
  const budget = { nodes: 0, samples: 0 };
  const message = parse(text, limits, budget);
  if (!message || typeof message !== 'object' || Array.isArray(message)) fail();
  if (message.version !== 1) fail('unsupported-version');
  const kind = typeof message.kind === 'string' && Object.hasOwn(KINDS, message.kind) ?
    KINDS[message.kind] : null;
  if (!kind || !matches(schema.$defs[kind], message)) fail();
  if (message.binding) bind(message.binding, context);
  if (context.binding && Object.keys(schema.$defs.binding.properties).some(key =>
    Object.hasOwn(message, key) && message[key] !== context.binding[key])) fail('binding-mismatch');
  if (message.recordType) scoped(message.recordType, context);
  if (message.categories) message.categories.forEach(category => scoped(category, context));
  if (message.kind === 'batch') {
    if (payloadDigest(message.payloadJson) !== message.payloadDigest) fail('digest-mismatch');
    const payload = parse(message.payloadJson, limits, budget, 2);
    if (!matches(schema.$defs.batchPayload, payload)) fail();
    bind(payload.binding, context);
    scoped(payload.recordType, context);
    if (payload.changes.length > limits.maxChanges) fail('limit-exceeded');
    for (const change of payload.changes) {
      identityBound(change.identity, payload.binding, payload.recordType);
      if (change.operation === 'upsert') {
        if (!(context.serializers || DEFAULT_SERIALIZERS).some(serializer =>
          serializer.id === change.serializerId && serializer.version === change.serializerVersion &&
          serializer.dataFamily === change.dataFamily)) fail();
        if (change.dataFamily === 'ordinary' &&
            change.record.metadata?.id !== change.identity.nativeRecordId) fail('binding-mismatch');
        rawRecord(change.record, limits, budget, change.dataFamily);
      }
    }
  }
  if (message.window) windowValid(message.window);
  const query = message.queryJson ? queryRecord(message, limits, budget) : null;
  if (message.kind === 'coverage' && message.status === 'complete') {
    if (!message.pagesFinished || !message.permissionsStable || !message.tokenValid ||
        !message.historyIncludesScope || !message.changesBarrierDrained ||
        message.permissionFingerprintStart !== message.permissionFingerprintEnd ||
        (query.historyStart !== null &&
          instantKey(query.historyStart) > instantKey(message.window.start))) {
      fail('incomplete-coverage');
    }
    frontier(message, 'rawFrontier', context);
  }
  if (message.kind === 'aggregate') {
    const { state, quantity } = message.observation;
    if ((state === 'value') !== (quantity !== null) ||
        (message.status === 'current' && state === 'missing')) fail();
    if (message.status === 'current') frontier(message, 'requiredRawFrontier', context);
  }
  if (message.kind === 'pairing-grant') {
    let destination;
    try { destination = new URL(message.destination); } catch { fail('invalid-destination'); }
    if (destination.protocol !== 'https:' || destination.username || destination.password ||
        destination.pathname !== '/' || destination.search || destination.hash ||
        destination.origin !== message.destination) fail('invalid-destination');
  }
  if (message.kind === 'object-part' || message.kind === 'object-finalise') {
    identityBound(message.identity, message.binding, message.recordType);
    if (message.partCount > limits.maxParts || message.totalBytes > limits.maxObjectBytes) {
      fail('limit-exceeded');
    }
    if (message.kind === 'object-part') {
      const bytes = Buffer.from(message.partBase64, 'base64');
      if (message.partIndex >= message.partCount || bytes.length > message.totalBytes ||
          bytes.toString('base64') !== message.partBase64) fail();
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (digest !== message.partDigest) fail('digest-mismatch');
    } else if (message.parts.length !== message.partCount ||
        message.parts.some((part, index) => part.index !== index) ||
        message.parts.reduce((sum, part) => sum + part.bytes, 0) !== message.totalBytes) fail();
  }
  return freeze(message);
}
module.exports = { decodeMessage, payloadDigest, nativeKey, ProtocolError, HARD_LIMITS };
