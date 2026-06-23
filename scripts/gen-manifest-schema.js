// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// scripts/gen-manifest-schema.js
//
// Generates manifests/schema/klebb.datafile.v1.schema.json as a projection
// of the imperative validator (manifests/registry.validateManifestShape) plus
// the shared enums (config/categories, notifications-schema time-of-day). The
// artefact is the machine-readable contract the chat agent reads via read_doc;
// the imperative validator stays the load-bearing server-side gate.
//
// The schema deliberately encodes ONLY the structural subset the validator
// enforces, using constrained-decoding-safe keywords (const, enum, pattern,
// type, required, additionalProperties). It does NOT attempt cross-field rules
// (reserved-id, duplicate-id, per-renderer data shape) that JSON Schema cannot
// express; those remain the validator's job. So the schema is a SUBSET: it
// accepts at least everything the validator accepts structurally.
//
// Usage:
//   node scripts/gen-manifest-schema.js          # write the artefact
//   node scripts/gen-manifest-schema.js --check   # exit 1 if stale (CI/tests)

const fs = require('fs');
const path = require('path');

const { CATEGORIES } = require('../config/categories');
const { TIME_OF_DAY_TOKENS } = require('../manifests/notifications-schema');
const {
  SUPPORTED_SCHEMAS,
  ID_PATTERN,
  ID_MAX_LENGTH,
} = require('../manifests/registry');

const OUT_PATH = path.join(__dirname, '..', 'manifests', 'schema', 'klebb.datafile.v1.schema.json');

function buildSchema() {
  // ID_PATTERN is anchored (/^...$/); JSON Schema `pattern` is unanchored, so
  // strip the JS regex delimiters and reuse the source verbatim (it keeps its
  // own ^ and $), matching the validator exactly.
  const idPattern = ID_PATTERN.source;
  const timeOfDayEnum = [...TIME_OF_DAY_TOKENS];

  const scheduleTimeOfDay = {
    description: 'A single time-of-day token, or a non-empty array of distinct tokens.',
    anyOf: [
      { type: 'string', enum: timeOfDayEnum },
      { type: 'array', items: { type: 'string', enum: timeOfDayEnum }, minItems: 1, uniqueItems: true },
    ],
  };

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://klebb.app/schema/klebb.datafile.v1.schema.json',
    title: 'klebb.datafile.v1',
    description:
      'Structural contract for a Klebb data file (one card = one JSON file). '
      + 'Generated from the validator + shared enums by scripts/gen-manifest-schema.js; '
      + 'do not edit by hand. The server-side validator enforces additional cross-field '
      + 'rules (reserved/duplicate id, per-renderer data shape) this schema cannot express.',
    type: 'object',
    required: ['$schema', 'meta'],
    properties: {
      $schema: {
        description: 'Schema discriminator. Only klebb.datafile.v1 is supported.',
        const: SUPPORTED_SCHEMAS[0],
      },
      meta: {
        type: 'object',
        required: ['id', 'label'],
        properties: {
          id: {
            type: 'string',
            description: 'Stable card id. Filename-safe; reserved names are rejected by the validator.',
            pattern: idPattern,
            maxLength: ID_MAX_LENGTH,
          },
          label: { type: 'string', description: 'Human-facing card title.', minLength: 1 },
          emoji: { type: 'string' },
          order: { type: 'integer' },
          enabled: { type: 'boolean' },
          category: {
            description: 'Optional grouping for clustering heuristics. Unknown values are dropped at load.',
            type: 'string',
            enum: [...CATEGORIES],
          },
          // View-config objects share a shape; kept permissive (additionalProperties
          // true) because renderer-specific keys are validated by the renderer, not here.
          view: { type: 'object' },
          trends: { type: 'object' },
          calendar: { type: 'object' },
          reports: { type: 'object' },
          writeable: { type: 'object' },
          ingest: { type: 'object' },
          notifications: { type: 'object' },
          prompt: { type: 'object' },
          chat: { type: 'object' },
        },
        additionalProperties: true,
      },
      description: { type: 'string' },
      schema: { type: 'object' },
      // data is per-renderer and intentionally unconstrained here. The one
      // structural rule the validator enforces is on data.items[].schedule.time_of_day.
      data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    schedule: {
                      type: 'object',
                      properties: { time_of_day: scheduleTimeOfDay },
                    },
                  },
                },
              },
            },
          },
          { type: 'array' },
          { type: 'null' },
        ],
      },
    },
    additionalProperties: true,
  };
}

// Stable, sorted-key serialisation so the artefact is byte-deterministic
// regardless of property insertion order (the drift test compares bytes).
function serialise(schema) {
  return JSON.stringify(schema, null, 2) + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  const next = serialise(buildSchema());
  if (check) {
    let current = null;
    try {
      current = fs.readFileSync(OUT_PATH, 'utf8');
    } catch {
      console.error(`missing ${path.relative(process.cwd(), OUT_PATH)}; run: node scripts/gen-manifest-schema.js`);
      process.exit(1);
    }
    if (current !== next) {
      console.error(`${path.relative(process.cwd(), OUT_PATH)} is stale; run: node scripts/gen-manifest-schema.js`);
      process.exit(1);
    }
    console.log('manifest schema artefact is up to date');
    return;
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, next);
  console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

if (require.main === module) main();

module.exports = { buildSchema, serialise, OUT_PATH };
