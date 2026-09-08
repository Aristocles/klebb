// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-703.test.js
// Regression seed for #703: appendRow pushed its value verbatim, so a
// double-serialised row (a JSON string where an object was meant) was
// persisted as a string blob: the row rendered blank and wedged
// reorderRows for the whole card. The guard has to stay surgical, because
// bare-string rows are legitimate data (greeting-banner cards hold an
// array of message strings): rescue strings that parse to structured
// values, reject shape mismatches against object-rowed arrays, and leave
// scalar-rowed arrays alone.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('../helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFESTS_DIR = path.resolve(REPO_ROOT, 'manifests') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;
const CHAT_DIR = path.resolve(REPO_ROOT, 'chat') + path.sep;

function freshTools(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MANIFESTS_DIR) ||
        key.startsWith(CONFIG_DIR) ||
        key.startsWith(CHAT_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  const registry = require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
  registry.init();
  const { dispatchToolCall } = require(path.join(REPO_ROOT, 'chat', 'tools.js'));
  return { registry, dispatchToolCall };
}

function makeToolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

const CHECKLIST = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'supplements',
    label: 'Supplements',
    view: { enabled: true, component: 'checklist-card' },
    writeable: { fromWebapp: true },
  },
  description: 'Object-rowed checklist.',
  data: { items: [{ name: 'Magnesium', doses: [] }] },
};

const GREETING = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'greeting',
    label: 'Greeting',
    view: { enabled: true, component: 'greeting-banner', slot: 'top' },
    writeable: { fromWebapp: true },
  },
  description: 'String-rowed banner.',
  data: ['Have a good one', 'Hydrate today'],
};

function seededSandbox() {
  return createSandbox({ seed: { 'supplements.json': CHECKLIST, 'greeting.json': GREETING } });
}

describe('issue #703: appendRow string blobs', () => {
  test('a double-serialised object row is rescued to a real object', () => {
    const sandbox = seededSandbox();
    const origWarn = console.warn;
    let warned = '';
    console.warn = (msg) => { warned += String(msg); };
    try {
      const { registry } = freshTools(sandbox);
      registry.appendRow('supplements', 'items', JSON.stringify({ name: 'Zinc', doses: [] }));
      const items = registry.readRows('supplements', 'items').value;
      assert.equal(items.length, 2);
      assert.equal(typeof items[1], 'object', `stored a ${typeof items[1]}, not an object`);
      assert.equal(items[1].name, 'Zinc');
      assert.match(warned, /rescued double-serialised/);
    } finally {
      console.warn = origWarn;
      cleanupSandbox(sandbox);
    }
  });

  test('a non-object value onto an object-rowed array is rejected, array unchanged', () => {
    const sandbox = seededSandbox();
    try {
      const { registry } = freshTools(sandbox);
      assert.throws(
        () => registry.appendRow('supplements', 'items', 'Zinc 30mg nightly'),
        (e) => e.code === 'WRONG_TYPE' && /must be a plain object/.test(e.message)
      );
      const items = registry.readRows('supplements', 'items').value;
      assert.equal(items.length, 1, 'nothing was appended by the rejected call');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('a bare string onto a string-rowed array still appends (greeting-style cards)', () => {
    const sandbox = seededSandbox();
    try {
      const { registry } = freshTools(sandbox);
      const out = registry.appendRow('greeting', '', 'Stretch before coffee');
      assert.equal(out.added, 1);
      const rows = registry.readRows('greeting', '').value;
      assert.equal(rows[2], 'Stretch before coffee');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('a JSON-looking string onto a string-rowed array stays a VERBATIM string', () => {
    const sandbox = seededSandbox();
    try {
      const { registry } = freshTools(sandbox);
      registry.appendRow('greeting', '', '{"msg":"hello"}');
      const rows = registry.readRows('greeting', '').value;
      assert.equal(rows[2], '{"msg":"hello"}',
        'the rescue must not convert a legitimate string row into an object row');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('a stringified ARRAY onto an object-rowed array is rejected, not nested in', () => {
    const sandbox = seededSandbox();
    try {
      const { registry } = freshTools(sandbox);
      assert.throws(
        () => registry.appendRow('supplements', 'items', JSON.stringify([{ name: 'Zinc' }])),
        (e) => e.code === 'WRONG_TYPE'
      );
      const items = registry.readRows('supplements', 'items').value;
      assert.equal(items.length, 1, 'nothing was appended by the rejected call');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  test('append_row via chat dispatch rescues a stringified row', () => {
    const sandbox = seededSandbox();
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const { registry, dispatchToolCall } = freshTools(sandbox);
      const out = JSON.parse(dispatchToolCall(
        makeToolCall('append_row', {
          id: 'supplements',
          path: 'items[name="Magnesium"].doses',
          value: JSON.stringify({ scheduledDate: '2026-09-08', takenAt: '2026-09-08T08:00:00Z' }),
        })
      ));
      assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
      const doses = registry.readRows('supplements', 'items[name="Magnesium"].doses').value;
      assert.equal(typeof doses[0], 'object');
      assert.equal(doses[0].scheduledDate, '2026-09-08');
    } finally {
      console.warn = origWarn;
      cleanupSandbox(sandbox);
    }
  });
});
