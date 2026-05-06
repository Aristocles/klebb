// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/template-manifests.test.js
// Successor to the removed tests/example-manifests.test.js. Walks every
// templates/*.klebb.json, strips placeholder tokens, and verifies the
// stripped result is a valid klebb.datafile.v1 manifest referencing a known
// renderer. Also validates the meta.template block and the placeholder
// syntax itself.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// Renderer names the client knows about. Kept in sync with
// public/js/components/eh-view-renderer.js.
const KNOWN_COMPONENTS = new Set([
  'generic-card',
  'schedule-card',
  'checklist-card',
  'markdown-doc',
  'line-chart',
  'schedule-timeline',
  'table-list',
  'adherence-report',
  'greeting-banner',
  'list-card',
  'day-marker',
  'combination-card',
  'welcome-card',
]);

const PLACEHOLDER_TYPES = new Set([
  'string', 'number', 'boolean', 'date', 'enum',
]);

// Matches {{type:name}} or {{name}} (default type = string).
const PLACEHOLDER_RE = /\{\{([a-z]+:)?([a-z0-9_]+)\}\}/gi;

// Placeholder default values, keyed by declared type. Used only to produce a
// syntactically valid manifest for schema validation; no semantic meaning.
const PLACEHOLDER_DEFAULTS = {
  string: 'test',
  number: 1,
  boolean: true,
  date: '2026-01-01',
  enum: 'option-a',
};

function stripPlaceholders(rawJson) {
  // Replace every placeholder with a JSON-safe default. For non-string types,
  // the default needs to be inserted without quotes, so we swap the whole
  // quoted-placeholder token.
  let out = rawJson;

  // First pass: quoted placeholders like "{{number:dose_mg}}" become the raw
  // default (unquoted for numbers/booleans).
  out = out.replace(/"\{\{([a-z]+:)?([a-z0-9_]+)\}\}"/gi, (_, typePrefix, name) => {
    const type = typePrefix ? typePrefix.slice(0, -1) : 'string';
    const def = PLACEHOLDER_DEFAULTS[type];
    if (def === undefined) throw new Error(`unknown placeholder type: ${type}`);
    if (type === 'string' || type === 'date' || type === 'enum') return JSON.stringify(def);
    return JSON.stringify(def); // numbers + booleans: JSON.stringify handles unquoting
  });

  // Second pass: unquoted placeholders (shouldn't happen in valid templates,
  // but catch anything we missed).
  out = out.replace(PLACEHOLDER_RE, (_, typePrefix, name) => {
    const type = typePrefix ? typePrefix.slice(0, -1) : 'string';
    const def = PLACEHOLDER_DEFAULTS[type];
    if (def === undefined) throw new Error(`unknown placeholder type: ${type}`);
    return JSON.stringify(def);
  });

  return out;
}

function listTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.klebb.json'))
    .map(f => path.join(TEMPLATES_DIR, f));
}

describe('templates/ directory', () => {
  test('exists and contains at least 10 templates', () => {
    const files = listTemplates();
    assert.ok(files.length >= 10, `expected >= 10 templates, found ${files.length}`);
  });
});

const files = listTemplates();
for (const file of files) {
  const name = path.basename(file);
  describe(`template: ${name}`, () => {
    const raw = fs.readFileSync(file, 'utf8');

    test('placeholder syntax is valid', () => {
      const matches = [...raw.matchAll(PLACEHOLDER_RE)];
      for (const m of matches) {
        const typePrefix = m[1];
        if (typePrefix) {
          const type = typePrefix.slice(0, -1);
          assert.ok(
            PLACEHOLDER_TYPES.has(type),
            `unknown placeholder type "${type}" in ${name}`,
          );
        }
      }
    });

    test('parses to valid JSON after placeholder substitution', () => {
      const stripped = stripPlaceholders(raw);
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(stripped); },
        `JSON parse failed after placeholder substitution in ${name}`);

      assert.equal(parsed.$schema, 'klebb.datafile.v1', '$schema mismatch');
      assert.ok(parsed.meta, 'missing meta');
      assert.ok(typeof parsed.meta.id === 'string', 'missing meta.id');
      assert.ok(typeof parsed.meta.label === 'string', 'missing meta.label');
    });

    test('meta.template block is complete', () => {
      const parsed = JSON.parse(stripPlaceholders(raw));
      const t = parsed.meta.template;
      assert.ok(t, 'missing meta.template block');
      assert.ok(typeof t.id === 'string' && t.id.length > 0, 'meta.template.id required');
      assert.ok(typeof t.title === 'string' && t.title.length > 0, 'meta.template.title required');
      assert.ok(typeof t.summary === 'string' && t.summary.length > 0, 'meta.template.summary required');
      assert.ok(typeof t.category === 'string' && t.category.length > 0, 'meta.template.category required');
      assert.ok(Array.isArray(t.tags), 'meta.template.tags must be array');
    });

    test('references only known renderer components', () => {
      const parsed = JSON.parse(stripPlaceholders(raw));
      const views = ['view', 'trends', 'calendar', 'reports'];
      for (const v of views) {
        const block = parsed.meta[v];
        if (!block || !block.component) continue;
        assert.ok(
          KNOWN_COMPONENTS.has(block.component),
          `unknown component "${block.component}" in meta.${v} of ${name}`,
        );
      }
    });

    test('template filename matches meta.template.id', () => {
      const parsed = JSON.parse(stripPlaceholders(raw));
      const expected = parsed.meta.template.id + '.klebb.json';
      assert.equal(name, expected,
        `filename ${name} does not match meta.template.id ${parsed.meta.template.id}`);
    });
  });
}
