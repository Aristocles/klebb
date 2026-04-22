// tests/example-manifests.test.js
// Walks every data.example/*.json and verifies each is a valid klebb.datafile.v1
// manifest that references a known renderer and parseable template(s).
//
// Catches 'did I ship a broken example' regressions before they reach users.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { renderTemplate } =
  require(path.join(__dirname, '..', 'public', 'js', 'lib', 'display-template.js'));

const EXAMPLE_DIR = path.join(__dirname, '..', 'data.example');

// Built-in renderer names — keep in sync with MANIFEST-SCHEMA.md
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
  'progress-bars-card',  // Used by existing goals.json
  'list-card',           // Pending deferred-a — some examples point at it
  'day-marker',          // Calendar-only marker config (meta.calendar.component)
]);

const KNOWN_INPUT_TYPES = new Set([
  'number', 'text', 'textarea', 'select', 'emoji-picker',
  'colour', 'color', 'checkbox', 'date', 'time', 'rating',
]);

function loadExample(file) {
  const full = path.join(EXAMPLE_DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
}

// Shared sanity checker — reused per file
function assertValidManifest(parsed, file) {
  assert.equal(parsed.$schema, 'klebb.datafile.v1',
    `${file}: \$schema must be klebb.datafile.v1, got ${parsed.$schema}`);
  assert.ok(parsed.meta, `${file}: missing meta`);
  assert.ok(parsed.meta.id, `${file}: missing meta.id`);
  assert.ok(parsed.meta.label, `${file}: missing meta.label`);
  assert.ok('data' in parsed, `${file}: missing data field`);

  // Walk views (view, trends, calendar, reports) and validate their component
  for (const viewName of ['view', 'trends', 'calendar', 'reports']) {
    const v = parsed.meta[viewName];
    if (!v) continue;
    if (!v.component) continue;
    assert.ok(
      KNOWN_COMPONENTS.has(v.component),
      `${file}: meta.${viewName}.component="${v.component}" not in known list`
    );
  }

  // Walk writeable.inputs and validate each input type
  const inputs = parsed.meta.writeable?.inputs;
  if (Array.isArray(inputs)) {
    for (const input of inputs) {
      assert.ok(input.key, `${file}: input missing key`);
      assert.ok(input.type, `${file}: input "${input.key}" missing type`);
      assert.ok(
        KNOWN_INPUT_TYPES.has(input.type),
        `${file}: input "${input.key}" has unknown type "${input.type}"`
      );
    }
  }

  // Template parses without exploding (we can't assert output — templates
  // reference fields that may not exist in empty data)
  const tpls = [];
  if (parsed.meta.view?.display?.template) tpls.push(parsed.meta.view.display.template);
  if (parsed.meta.view?.display?.secondary) tpls.push(parsed.meta.view.display.secondary);
  if (parsed.meta.view?.display?.emptyHeadline) tpls.push(parsed.meta.view.display.emptyHeadline);
  for (const t of tpls) {
    // Should not throw regardless of input data
    const rendered = renderTemplate(t, {}, parsed.meta.view.display);
    assert.equal(typeof rendered, 'string', `${file}: template rendered non-string`);
  }
}

const exampleFiles = fs.readdirSync(EXAMPLE_DIR)
  .filter(f => f.endsWith('.json'))
  .filter(f => f !== 'greeting-messages.json'); // reference-only, not a manifest

describe('data.example manifests', () => {
  test(`${exampleFiles.length} example files found`, () => {
    assert.ok(exampleFiles.length >= 15,
      `expected at least 15 example manifests, found ${exampleFiles.length}`);
  });

  for (const file of exampleFiles) {
    test(`${file} is a valid v1 manifest`, () => {
      const parsed = loadExample(file);
      assertValidManifest(parsed, file);
    });
  }

  test('every example id is unique', () => {
    const ids = new Map();
    for (const file of exampleFiles) {
      const parsed = loadExample(file);
      const id = parsed.meta.id;
      if (ids.has(id)) {
        assert.fail(`duplicate id "${id}" in ${file} and ${ids.get(id)}`);
      }
      ids.set(id, file);
    }
  });

  test('every example filename matches its meta.id', () => {
    for (const file of exampleFiles) {
      const parsed = loadExample(file);
      // Filename is "<id>.example.json" by convention
      const expected = `${parsed.meta.id}.example.json`;
      assert.equal(
        file, expected,
        `${file}: meta.id is "${parsed.meta.id}" so filename should be "${expected}"`
      );
    }
  });

  test('every example has a description for AI writers', () => {
    for (const file of exampleFiles) {
      const parsed = loadExample(file);
      assert.ok(
        parsed.description && parsed.description.length > 10,
        `${file}: description is too short or missing`
      );
    }
  });
});
