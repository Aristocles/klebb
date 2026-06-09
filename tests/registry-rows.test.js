// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/registry-rows.test.js
// Integration tests for registry.readRows / appendRow / updateRow /
// removeRow against a real sandbox HEALTH_HOME. Atomicity, error codes,
// and that on-disk state and the in-memory cache stay aligned.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.resolve(REPO_ROOT, 'manifests') + path.sep;
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

function freshRegistry(sandboxRoot) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(MANIFESTS_DIR) || key.startsWith(CONFIG_DIR)) {
      delete require.cache[key];
    }
  }
  process.env.HEALTH_HOME = sandboxRoot;
  return require(path.join(REPO_ROOT, 'manifests', 'registry.js'));
}

function readBack(sandbox, file) {
  return JSON.parse(fs.readFileSync(path.join(sandbox, 'data', file), 'utf8'));
}

// Object-shaped data block (matches the schedule-card peptides shape).
const PEPTIDES = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'peptides',
    label: 'Schedule',
    emoji: '💉',
    writeable: { fromWebapp: true, inputs: [] },
  },
  data: {
    items: [
      { name: 'BPC-157', doses: [
        { scheduledDate: '2026-03-25' },
        { scheduledDate: '2026-03-26' },
      ]},
      { name: 'TB-500', doses: [
        { scheduledDate: '2026-03-27' },
      ]},
    ],
    groups: [
      { id: 'repair-stack', label: 'Repair Stack' },
    ],
  },
};

// Array-shaped data block (matches mood-card style).
const MOOD = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'mood',
    label: 'Mood',
    writeable: { fromWebapp: true, inputs: [] },
  },
  schema: { type: 'array' },
  data: [
    { date: '2026-05-04', mood: 4 },
    { date: '2026-05-05', mood: 5 },
  ],
};

describe('registry.readRows', () => {
  test('returns the resolved row by content-addressed path', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const r = registry.readRows('peptides', 'items[name="BPC-157"]');
      assert.equal(r.value.name, 'BPC-157');
      assert.equal(r.value.doses.length, 2);
      assert.equal(r.key, 0);
    } finally { cleanupSandbox(sandbox); }
  });

  test('empty path returns the whole data block', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const r = registry.readRows('peptides', '');
      assert.equal(r.container, null);
      assert.deepEqual(Object.keys(r.value), ['items', 'groups']);
    } finally { cleanupSandbox(sandbox); }
  });

  test('allowMultiple plumbs through to resolvePath', () => {
    const data = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'tags', label: 'T', writeable: { fromWebapp: true, inputs: [] } },
      data: { rows: [{ tag: 'a', n: 1 }, { tag: 'a', n: 2 }, { tag: 'b', n: 3 }] },
    };
    const sandbox = createSandbox({ seed: { 'tags.json': data } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const r = registry.readRows('tags', 'rows[tag="a"]', { allowMultiple: true });
      assert.equal(r.matches.length, 2);
    } finally { cleanupSandbox(sandbox); }
  });

  test('unknown manifest throws', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.readRows('does-not-exist', 'items'),
        /unknown manifest/,
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('bubbles BAD_PATH from parser', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.readRows('peptides', 'items[bad'),
        e => e.code === 'BAD_PATH',
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('bubbles NO_MATCH from resolver', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.readRows('peptides', 'items[name="NOPE"]'),
        e => e.code === 'NO_MATCH',
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('does not mutate the cache on read', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const before = JSON.stringify(registry.get('peptides').data);
      registry.readRows('peptides', 'items[name="BPC-157"].doses');
      const after = JSON.stringify(registry.get('peptides').data);
      assert.equal(before, after);
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('registry.appendRow', () => {
  test('appends a dose to an existing item; persists to disk and cache', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const out = registry.appendRow(
        'peptides',
        'items[name="BPC-157"].doses',
        { scheduledDate: '2026-03-27', takenAt: '2026-03-27T08:00:00Z' },
      );
      assert.equal(out.added, 1);
      assert.equal(out.totalAfter, 3);

      const onDisk = readBack(sandbox, 'peptides.json');
      assert.equal(onDisk.data.items[0].doses.length, 3);
      assert.equal(onDisk.data.items[0].doses[2].scheduledDate, '2026-03-27');

      const cached = registry.get('peptides').data;
      assert.equal(cached.items[0].doses.length, 3);
      assert.equal(cached.items[0].doses[2].takenAt, '2026-03-27T08:00:00Z');
    } finally { cleanupSandbox(sandbox); }
  });

  test('appends a top-level item to data.items', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const klow = { name: 'Klow Stack', doses: [] };
      registry.appendRow('peptides', 'items', klow);
      const onDisk = readBack(sandbox, 'peptides.json');
      assert.equal(onDisk.data.items.length, 3);
      assert.equal(onDisk.data.items[2].name, 'Klow Stack');
    } finally { cleanupSandbox(sandbox); }
  });

  test('appends to an array-shaped data block (no parent key)', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.appendRow('mood', '', { date: '2026-05-06', mood: 3 });
      const onDisk = readBack(sandbox, 'mood.json');
      assert.equal(onDisk.data.length, 3);
      assert.equal(onDisk.data[2].mood, 3);
    } finally { cleanupSandbox(sandbox); }
  });

  test('WRONG_TYPE when target is not an array', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.appendRow('peptides', 'items[name="BPC-157"].name', 'X'),
        e => e.code === 'WRONG_TYPE',
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('NO_MATCH bubbles when target item does not exist', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.appendRow('peptides', 'items[name="NOPE"].doses', {}),
        e => e.code === 'NO_MATCH',
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('mid-mutation throw leaves on-disk file unchanged', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const beforeRaw = fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8');
      assert.throws(() => registry.appendRow('peptides', 'items[name="NOPE"]', {}), e => e.code === 'NO_MATCH');
      const afterRaw = fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8');
      assert.equal(beforeRaw, afterRaw);
      // Cache is also untouched.
      assert.equal(registry.get('peptides').data.items.length, 2);
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('registry.updateRow', () => {
  test('merge-patches a row identified by filter', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const out = registry.updateRow(
        'peptides',
        'items[name="BPC-157"].doses[scheduledDate="2026-03-25"]',
        { takenAt: '2026-03-25T03:25:00Z', site: 'belly' },
      );
      assert.equal(out.updated, 1);
      assert.equal(out.after.takenAt, '2026-03-25T03:25:00Z');
      assert.equal(out.after.site, 'belly');
      // scheduledDate preserved via merge
      assert.equal(out.after.scheduledDate, '2026-03-25');

      const onDisk = readBack(sandbox, 'peptides.json');
      assert.equal(onDisk.data.items[0].doses[0].site, 'belly');
      assert.equal(onDisk.data.items[0].doses[0].scheduledDate, '2026-03-25');
    } finally { cleanupSandbox(sandbox); }
  });

  test('null in changes removes a key (RFC 7396)', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.updateRow(
        'peptides',
        'items[name="BPC-157"].doses[scheduledDate="2026-03-25"]',
        { scheduledDate: null, takenAt: '2026-03-25T03:25:00Z' },
      );
      const onDisk = readBack(sandbox, 'peptides.json');
      const dose = onDisk.data.items[0].doses[0];
      assert.equal('scheduledDate' in dose, false);
      assert.equal(dose.takenAt, '2026-03-25T03:25:00Z');
    } finally { cleanupSandbox(sandbox); }
  });

  test('AMBIGUOUS bubbles when multiple rows match', () => {
    const data = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'tags', label: 'T', writeable: { fromWebapp: true, inputs: [] } },
      data: { rows: [{ tag: 'a', n: 1 }, { tag: 'a', n: 2 }] },
    };
    const sandbox = createSandbox({ seed: { 'tags.json': data } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.updateRow('tags', 'rows[tag="a"]', { flagged: true }),
        e => e.code === 'AMBIGUOUS',
      );
      // Cache unchanged
      assert.equal('flagged' in registry.get('tags').data.rows[0], false);
    } finally { cleanupSandbox(sandbox); }
  });

  test('WRONG_TYPE when target is not a plain object', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.updateRow('peptides', 'items[name="BPC-157"].doses', { x: 1 }),
        e => e.code === 'WRONG_TYPE',
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('rejects non-object changes', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.updateRow('peptides', 'items[name="BPC-157"]', null),
        e => e.code === 'WRONG_TYPE',
      );
      assert.throws(
        () => registry.updateRow('peptides', 'items[name="BPC-157"]', [1, 2]),
        e => e.code === 'WRONG_TYPE',
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('cannot patch the root data value', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.updateRow('peptides', '', { extraKey: 1 }),
        e => e.code === 'WRONG_TYPE',
      );
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('registry.removeRow', () => {
  test('removes a dose by content-addressed path', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      const out = registry.removeRow(
        'peptides',
        'items[name="BPC-157"].doses[scheduledDate="2026-03-25"]',
      );
      assert.equal(out.removed.scheduledDate, '2026-03-25');
      assert.equal(out.totalAfter, 1);
      const onDisk = readBack(sandbox, 'peptides.json');
      assert.equal(onDisk.data.items[0].doses.length, 1);
      assert.equal(onDisk.data.items[0].doses[0].scheduledDate, '2026-03-26');
    } finally { cleanupSandbox(sandbox); }
  });

  test('removes a top-level item', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.removeRow('peptides', 'items[name="TB-500"]');
      const onDisk = readBack(sandbox, 'peptides.json');
      assert.equal(onDisk.data.items.length, 1);
      assert.equal(onDisk.data.items[0].name, 'BPC-157');
    } finally { cleanupSandbox(sandbox); }
  });

  test('removes from an array-shaped data block', () => {
    const sandbox = createSandbox({ seed: { 'mood.json': MOOD } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      registry.removeRow('mood', '[date="2026-05-04"]');
      const onDisk = readBack(sandbox, 'mood.json');
      assert.equal(onDisk.data.length, 1);
      assert.equal(onDisk.data[0].date, '2026-05-05');
    } finally { cleanupSandbox(sandbox); }
  });

  test('AMBIGUOUS bubbles for a non-unique match', () => {
    const data = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'tags', label: 'T', writeable: { fromWebapp: true, inputs: [] } },
      data: { rows: [{ tag: 'a' }, { tag: 'a' }] },
    };
    const sandbox = createSandbox({ seed: { 'tags.json': data } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.removeRow('tags', 'rows[tag="a"]'),
        e => e.code === 'AMBIGUOUS',
      );
      // Both rows still present
      assert.equal(registry.get('tags').data.rows.length, 2);
    } finally { cleanupSandbox(sandbox); }
  });

  test('cannot remove a non-array element (e.g. a property of an object)', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      // 'items' is itself a property of data, not an element of an array.
      assert.throws(
        () => registry.removeRow('peptides', 'items'),
        e => e.code === 'WRONG_TYPE',
      );
    } finally { cleanupSandbox(sandbox); }
  });

  test('cannot remove the root data value', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const registry = freshRegistry(sandbox);
      registry.init();
      assert.throws(
        () => registry.removeRow('peptides', ''),
        e => e.code === 'WRONG_TYPE',
      );
    } finally { cleanupSandbox(sandbox); }
  });
});
