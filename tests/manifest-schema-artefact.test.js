// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/manifest-schema-artefact.test.js
// The generated klebb.datafile.v1 JSON-Schema artefact is a faithful, byte-stable
// projection of the canonical validator constants + shared enums. (The fuller
// schema-vs-validator corpus agreement test lands separately.)

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { buildSchema, serialise, OUT_PATH } = require('../scripts/gen-manifest-schema');
const { CATEGORIES } = require('../config/categories');
const { TIME_OF_DAY_TOKENS } = require('../manifests/notifications-schema');
const { SUPPORTED_SCHEMAS, ID_PATTERN, ID_MAX_LENGTH } = require('../manifests/registry');

describe('manifest JSON-Schema artefact', () => {
  test('committed artefact is byte-identical to a fresh generation (not stale)', () => {
    const committed = fs.readFileSync(OUT_PATH, 'utf8');
    assert.strictEqual(committed, serialise(buildSchema()),
      'manifests/schema/klebb.datafile.v1.schema.json is stale; run: npm run gen-schema');
  });

  test('artefact is valid JSON and a draft-07 object schema', () => {
    const parsed = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    assert.strictEqual(parsed.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.strictEqual(parsed.type, 'object');
    assert.strictEqual(parsed.title, 'klebb.datafile.v1');
  });

  test('projects the validator structural contract: required $schema + meta', () => {
    const s = buildSchema();
    assert.deepStrictEqual(s.required, ['$schema', 'meta']);
    assert.strictEqual(s.properties.$schema.const, SUPPORTED_SCHEMAS[0]);
    assert.deepStrictEqual(s.properties.meta.required, ['id', 'label']);
  });

  test('id constraints match the canonical ID_PATTERN + ID_MAX_LENGTH', () => {
    const id = buildSchema().properties.meta.properties.id;
    assert.strictEqual(id.pattern, ID_PATTERN.source);
    assert.strictEqual(id.maxLength, ID_MAX_LENGTH);
  });

  test('category enum is exactly config/categories CATEGORIES', () => {
    const cat = buildSchema().properties.meta.properties.category;
    assert.deepStrictEqual(cat.enum, [...CATEGORIES]);
  });

  test('schedule.time_of_day enum is exactly TIME_OF_DAY_TOKENS, single or distinct array', () => {
    const tod = buildSchema().properties.data.anyOf[0]
      .properties.items.items.properties.schedule.properties.time_of_day;
    const tokens = [...TIME_OF_DAY_TOKENS];
    assert.deepStrictEqual(tod.anyOf[0].enum, tokens);
    assert.deepStrictEqual(tod.anyOf[1].items.enum, tokens);
    assert.strictEqual(tod.anyOf[1].uniqueItems, true);
    assert.strictEqual(tod.anyOf[1].minItems, 1);
  });

  test('data is permissive: object | array | null (per-renderer shape not constrained)', () => {
    const data = buildSchema().properties.data;
    const types = data.anyOf.map(b => b.type);
    assert.ok(types.includes('array'));
    assert.ok(types.includes('null'));
    assert.ok(types.includes('object'));
  });
});
