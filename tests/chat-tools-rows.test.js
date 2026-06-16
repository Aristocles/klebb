// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/chat-tools-rows.test.js
// Direct-dispatch tests for the row-level chat tools: read_manifest_meta,
// read_manifest_rows, append_row, update_row, remove_row. Bypasses the
// chat agent loop; verifies the dispatch contract end-to-end.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
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
  const { TOOL_DEFS, dispatchToolCall } = require(path.join(REPO_ROOT, 'chat', 'tools.js'));
  return { registry, TOOL_DEFS, dispatchToolCall };
}

function makeToolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

function call(dispatchToolCall, name, args, ctx) {
  return JSON.parse(dispatchToolCall(makeToolCall(name, args), ctx));
}

const PEPTIDES = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'peptides',
    label: 'Schedule',
    emoji: '💉',
    view: { enabled: true, component: 'schedule-card' },
    writeable: { fromWebapp: true, inputs: [] },
  },
  description: 'Scheduled peptide doses.',
  data: {
    items: [
      { name: 'BPC-157', doses: [
        { scheduledDate: '2026-03-25' },
        { scheduledDate: '2026-03-26' },
        { scheduledDate: '2026-03-27' },
        { scheduledDate: '2026-03-28' },
        { scheduledDate: '2026-03-29' },
        { scheduledDate: '2026-03-30' },
        { scheduledDate: '2026-03-31' },
        { scheduledDate: '2026-04-01' },
        { scheduledDate: '2026-04-02' },
        { scheduledDate: '2026-04-03' },
        { scheduledDate: '2026-04-04' },
        { scheduledDate: '2026-04-05' },
      ]},
      { name: 'TB-500', doses: [{ scheduledDate: '2026-03-27' }] },
    ],
    groups: [{ id: 'repair-stack', label: 'Repair Stack' }],
  },
};

const INGEST_ONLY = {
  $schema: 'klebb.datafile.v1',
  meta: {
    id: 'steps',
    label: 'Steps',
    view: { enabled: true, component: 'generic-card' },
    writeable: { fromWebapp: false },
  },
  description: 'Ingest-only.',
  data: [{ date: '2026-05-05', count: 7200 }],
};

describe('row tools: TOOL_DEFS exposure', () => {
  test('all five new tool names are registered', () => {
    const sandbox = createSandbox();
    try {
      const { TOOL_DEFS } = freshTools(sandbox);
      const names = TOOL_DEFS.map(t => t.function.name);
      for (const want of ['read_manifest_meta', 'read_manifest_rows', 'append_row', 'update_row', 'remove_row']) {
        assert.ok(names.includes(want), `${want} missing from TOOL_DEFS`);
      }
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('read_manifest_meta', () => {
  test('returns meta + description + schema, NOT data', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_meta', { id: 'peptides' });
      assert.equal(res.meta.id, 'peptides');
      assert.equal(res.description, 'Scheduled peptide doses.');
      assert.equal('data' in res, false, 'data must NOT be returned');
    } finally { cleanupSandbox(sandbox); }
  });

  test('unknown id returns {error}', () => {
    const sandbox = createSandbox();
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_meta', { id: 'ghost' });
      assert.match(res.error, /unknown manifest/);
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('read_manifest_rows: auto-summarisation', () => {
  test('long array auto-truncates to 10 with {truncated, total}', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', {
        id: 'peptides',
        path: 'items[name="BPC-157"].doses',
      });
      assert.equal(res.truncated, true);
      assert.equal(res.total, 12);
      assert.equal(res.rows.length, 10);
      assert.equal(res.window, 'asc');
      assert.equal(res.rows[0].scheduledDate, '2026-03-25');
    } finally { cleanupSandbox(sandbox); }
  });

  test('short array returns all rows, untruncated', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', {
        id: 'peptides',
        path: 'items[name="TB-500"].doses',
      });
      assert.equal(res.truncated, false);
      assert.equal(res.total, 1);
      assert.equal(res.rows.length, 1);
    } finally { cleanupSandbox(sandbox); }
  });

  test('order=desc returns the LAST 10 rows', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', {
        id: 'peptides',
        path: 'items[name="BPC-157"].doses',
        order: 'desc',
      });
      assert.equal(res.window, 'desc');
      assert.equal(res.rows[0].scheduledDate, '2026-03-27');
      assert.equal(res.rows[9].scheduledDate, '2026-04-05');
    } finally { cleanupSandbox(sandbox); }
  });

  test('object resolution collapses long sub-arrays to {omittedArray, count}', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', {
        id: 'peptides',
        path: 'items[name="BPC-157"]',
      });
      assert.equal(res.row.name, 'BPC-157');
      assert.deepEqual(res.row.doses, { omittedArray: true, count: 12 });
    } finally { cleanupSandbox(sandbox); }
  });

  test('object resolution keeps short sub-arrays inline', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', {
        id: 'peptides',
        path: 'items[name="TB-500"]',
      });
      assert.equal(res.row.name, 'TB-500');
      assert.deepEqual(res.row.doses, [{ scheduledDate: '2026-03-27' }]);
    } finally { cleanupSandbox(sandbox); }
  });

  test('top-level data block: groups inline (length 1), items inline (length 2 < 10) but each item still expands', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', { id: 'peptides', path: '' });
      // root is an object: rows -> {row: {items: [...], groups: [...]}}
      // items is short (length 2) so it's inlined at the top level; per-item
      // doses[] are NOT collapsed at this level (only top-level walk).
      assert.ok(Array.isArray(res.row.items));
      assert.equal(res.row.items.length, 2);
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('read_manifest_rows: errors', () => {
  test('BAD_PATH bubbles with code', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', { id: 'peptides', path: 'items[bad' });
      assert.equal(res.code, 'BAD_PATH');
      assert.ok(res.error);
      assert.equal(res.path, 'items[bad');
      assert.equal(res.id, 'peptides');
    } finally { cleanupSandbox(sandbox); }
  });

  test('NO_MATCH bubbles with code', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'read_manifest_rows', { id: 'peptides', path: 'items[name="NOPE"]' });
      assert.equal(res.code, 'NO_MATCH');
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('append_row: dispatch', () => {
  test('appends a dose; persists to disk; recordTouch fires for embellishment', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const ctx = { touches: [] };
      const res = JSON.parse(dispatchToolCall(makeToolCall('append_row', {
        id: 'peptides',
        path: 'items[name="TB-500"].doses',
        value: { scheduledDate: '2026-03-28', takenAt: '2026-03-28T08:00:00Z' },
      }), ctx));
      assert.equal(res.ok, true);
      assert.equal(res.totalAfter, 2);

      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8'));
      const tb = onDisk.data.items.find(x => x.name === 'TB-500');
      assert.equal(tb.doses.length, 2);
      assert.deepEqual(ctx.touches, [{ id: 'peptides', flow: 'edit' }]);
    } finally { cleanupSandbox(sandbox); }
  });

  test('appends a brand-new top-level item', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'append_row', {
        id: 'peptides',
        path: 'items',
        value: { name: 'Klow Stack', doses: [] },
      });
      assert.equal(res.ok, true);
      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8'));
      assert.equal(onDisk.data.items.length, 3);
      assert.equal(onDisk.data.items[2].name, 'Klow Stack');
    } finally { cleanupSandbox(sandbox); }
  });

  test('writeable gate: ingest-only card rejected with explanatory error', () => {
    const sandbox = createSandbox({ seed: { 'steps.json': INGEST_ONLY } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'append_row', {
        id: 'steps',
        path: '',
        value: { date: '2026-05-06', count: 9000 },
      });
      assert.match(res.error, /not writeable from the webapp/);
      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'steps.json'), 'utf8'));
      assert.equal(onDisk.data.length, 1, 'on-disk untouched');
    } finally { cleanupSandbox(sandbox); }
  });

  test('unknown manifest returns {error}', () => {
    const sandbox = createSandbox();
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'append_row', { id: 'ghost', path: '', value: 1 });
      assert.match(res.error, /unknown manifest/);
    } finally { cleanupSandbox(sandbox); }
  });

  test('WRONG_TYPE bubbles with code', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'append_row', {
        id: 'peptides',
        path: 'items[name="BPC-157"].name',
        value: 'X',
      });
      assert.equal(res.code, 'WRONG_TYPE');
    } finally { cleanupSandbox(sandbox); }
  });

  test('NO_MATCH bubbles with code; on-disk untouched', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const before = fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8');
      const res = call(dispatchToolCall, 'append_row', {
        id: 'peptides',
        path: 'items[name="DOES_NOT_EXIST"].doses',
        value: {},
      });
      assert.equal(res.code, 'NO_MATCH');
      const after = fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8');
      assert.equal(before, after);
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('update_row: dispatch', () => {
  test('merge-patches a row; persists; recordTouch fires', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const ctx = { touches: [] };
      const res = JSON.parse(dispatchToolCall(makeToolCall('update_row', {
        id: 'peptides',
        path: 'items[name="BPC-157"].doses[scheduledDate="2026-03-25"]',
        changes: { takenAt: '2026-03-25T03:25:00Z', site: 'belly' },
      }), ctx));
      assert.equal(res.ok, true);
      assert.equal(res.after.takenAt, '2026-03-25T03:25:00Z');
      assert.equal(res.after.site, 'belly');
      assert.equal(res.after.scheduledDate, '2026-03-25');
      assert.deepEqual(ctx.touches, [{ id: 'peptides', flow: 'edit' }]);
    } finally { cleanupSandbox(sandbox); }
  });

  test('writeable gate enforced', () => {
    const sandbox = createSandbox({ seed: { 'steps.json': INGEST_ONLY } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'update_row', {
        id: 'steps',
        path: '[date="2026-05-05"]',
        changes: { count: 9999 },
      });
      assert.match(res.error, /not writeable/);
    } finally { cleanupSandbox(sandbox); }
  });

  test('AMBIGUOUS surfaces with code', () => {
    const dup = {
      $schema: 'klebb.datafile.v1',
      meta: { id: 'tags', label: 'T', writeable: { fromWebapp: true, inputs: [] } },
      data: { rows: [{ tag: 'a', n: 1 }, { tag: 'a', n: 2 }] },
    };
    const sandbox = createSandbox({ seed: { 'tags.json': dup } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'update_row', {
        id: 'tags',
        path: 'rows[tag="a"]',
        changes: { flagged: true },
      });
      assert.equal(res.code, 'AMBIGUOUS');
    } finally { cleanupSandbox(sandbox); }
  });

  test('rejects non-object changes with WRONG_TYPE', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'update_row', {
        id: 'peptides',
        path: 'items[name="BPC-157"]',
        changes: null,
      });
      assert.equal(res.code, 'WRONG_TYPE');
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('remove_row: dispatch', () => {
  test('removes a dose by content-addressed path', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const ctx = { touches: [] };
      const res = JSON.parse(dispatchToolCall(makeToolCall('remove_row', {
        id: 'peptides',
        path: 'items[name="BPC-157"].doses[scheduledDate="2026-03-25"]',
      }), ctx));
      assert.equal(res.ok, true);
      assert.equal(res.removed.scheduledDate, '2026-03-25');
      assert.equal(res.totalAfter, 11);
      assert.deepEqual(ctx.touches, [{ id: 'peptides', flow: 'edit' }]);
    } finally { cleanupSandbox(sandbox); }
  });

  test('writeable gate enforced', () => {
    const sandbox = createSandbox({ seed: { 'steps.json': INGEST_ONLY } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'remove_row', {
        id: 'steps',
        path: '[date="2026-05-05"]',
      });
      assert.match(res.error, /not writeable/);
    } finally { cleanupSandbox(sandbox); }
  });

  test('cannot remove a non-array element', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'remove_row', { id: 'peptides', path: 'items' });
      assert.equal(res.code, 'WRONG_TYPE');
    } finally { cleanupSandbox(sandbox); }
  });

  test('cannot remove the root', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'remove_row', { id: 'peptides', path: '' });
      assert.equal(res.code, 'WRONG_TYPE');
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('reorder_rows: dispatch', () => {
  test('reorders top-level items array by name; persists; recordTouch fires', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const ctx = { touches: [] };
      const res = JSON.parse(dispatchToolCall(makeToolCall('reorder_rows', {
        id: 'peptides',
        path: 'items',
        key: 'name',
        order: ['TB-500', 'BPC-157'],
      }), ctx));
      assert.equal(res.ok, true);
      assert.equal(res.reordered, 2);

      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8'));
      assert.deepEqual(onDisk.data.items.map(i => i.name), ['TB-500', 'BPC-157']);
      assert.deepEqual(ctx.touches, [{ id: 'peptides', flow: 'edit' }]);
    } finally { cleanupSandbox(sandbox); }
  });

  test('preserves each row\'s full content (doses + nested fields untouched)', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      JSON.parse(dispatchToolCall(makeToolCall('reorder_rows', {
        id: 'peptides',
        path: 'items',
        key: 'name',
        order: ['TB-500', 'BPC-157'],
      })));
      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8'));
      const bpc = onDisk.data.items.find(x => x.name === 'BPC-157');
      assert.equal(bpc.doses.length, 12);
      assert.equal(bpc.doses[0].scheduledDate, '2026-03-25');
    } finally { cleanupSandbox(sandbox); }
  });

  test('reorders nested doses array', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const original = PEPTIDES.data.items.find(i => i.name === 'BPC-157').doses
        .map(d => d.scheduledDate);
      const reversed = [...original].reverse();
      const res = JSON.parse(dispatchToolCall(makeToolCall('reorder_rows', {
        id: 'peptides',
        path: 'items[name="BPC-157"].doses',
        key: 'scheduledDate',
        order: reversed,
      })));
      assert.equal(res.ok, true);
      assert.equal(res.reordered, 12);
      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8'));
      const bpc = onDisk.data.items.find(x => x.name === 'BPC-157');
      assert.deepEqual(bpc.doses.map(d => d.scheduledDate), reversed);
    } finally { cleanupSandbox(sandbox); }
  });

  test('reorders an array-rooted card via empty path', () => {
    const arrayRooted = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'log',
        label: 'Log',
        view: { enabled: true, component: 'list-card' },
        writeable: { fromWebapp: true, inputs: [] },
      },
      data: [
        { date: '2026-05-01', note: 'a' },
        { date: '2026-05-02', note: 'b' },
        { date: '2026-05-03', note: 'c' },
      ],
    };
    const sandbox = createSandbox({ seed: { 'log.json': arrayRooted } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = JSON.parse(dispatchToolCall(makeToolCall('reorder_rows', {
        id: 'log',
        path: '',
        key: 'date',
        order: ['2026-05-03', '2026-05-01', '2026-05-02'],
      })));
      assert.equal(res.ok, true);
      const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', 'log.json'), 'utf8'));
      assert.deepEqual(onDisk.data.map(r => r.date), ['2026-05-03', '2026-05-01', '2026-05-02']);
    } finally { cleanupSandbox(sandbox); }
  });

  test('writeable gate: ingest-only card rejected with explanatory error', () => {
    const sandbox = createSandbox({ seed: { 'steps.json': INGEST_ONLY } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'steps',
        path: '',
        key: 'date',
        order: ['2026-05-05'],
      });
      assert.match(res.error, /not writeable/);
    } finally { cleanupSandbox(sandbox); }
  });

  test('ORDER_MISMATCH: order length does not match row count', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const before = fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8');
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'peptides',
        path: 'items',
        key: 'name',
        order: ['BPC-157'],
      });
      assert.equal(res.code, 'ORDER_MISMATCH');
      const after = fs.readFileSync(path.join(sandbox, 'data', 'peptides.json'), 'utf8');
      assert.equal(before, after, 'on-disk untouched on mismatch');
    } finally { cleanupSandbox(sandbox); }
  });

  test('ORDER_MISMATCH: order has a value that is not in the rows', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'peptides',
        path: 'items',
        key: 'name',
        order: ['TB-500', 'GHOST-9'],
      });
      assert.equal(res.code, 'ORDER_MISMATCH');
    } finally { cleanupSandbox(sandbox); }
  });

  test('ORDER_MISMATCH: order has a duplicate value', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'peptides',
        path: 'items',
        key: 'name',
        order: ['BPC-157', 'BPC-157'],
      });
      assert.equal(res.code, 'ORDER_MISMATCH');
    } finally { cleanupSandbox(sandbox); }
  });

  test('ORDER_MISMATCH: a row has no key property', () => {
    const noKey = {
      $schema: 'klebb.datafile.v1',
      meta: {
        id: 'odd',
        label: 'Odd',
        writeable: { fromWebapp: true, inputs: [] },
      },
      data: { rows: [{ name: 'a' }, { other: 'b' }] },
    };
    const sandbox = createSandbox({ seed: { 'odd.json': noKey } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'odd',
        path: 'rows',
        key: 'name',
        order: ['a', 'b'],
      });
      assert.equal(res.code, 'ORDER_MISMATCH');
    } finally { cleanupSandbox(sandbox); }
  });

  test('WRONG_TYPE: target is not an array', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'peptides',
        path: 'items[name="BPC-157"]',
        key: 'name',
        order: ['BPC-157'],
      });
      assert.equal(res.code, 'WRONG_TYPE');
    } finally { cleanupSandbox(sandbox); }
  });

  test('WRONG_TYPE: missing key arg', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'peptides',
        path: 'items',
        order: ['BPC-157', 'TB-500'],
      });
      assert.equal(res.code, 'WRONG_TYPE');
    } finally { cleanupSandbox(sandbox); }
  });

  test('WRONG_TYPE: order is not an array', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'peptides',
        path: 'items',
        key: 'name',
        order: 'BPC-157',
      });
      assert.equal(res.code, 'WRONG_TYPE');
    } finally { cleanupSandbox(sandbox); }
  });

  test('NO_MATCH bubbles when path resolves to nothing', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const res = call(dispatchToolCall, 'reorder_rows', {
        id: 'peptides',
        path: 'no_such_array',
        key: 'name',
        order: [],
      });
      assert.equal(res.code, 'NO_MATCH');
    } finally { cleanupSandbox(sandbox); }
  });

  test('reorder_rows is in TOOL_DEFS', () => {
    const sandbox = createSandbox();
    try {
      const { TOOL_DEFS } = freshTools(sandbox);
      const names = TOOL_DEFS.map(t => t.function.name);
      assert.ok(names.includes('reorder_rows'));
    } finally { cleanupSandbox(sandbox); }
  });
});

describe('row tools: invalid JSON arguments are caught at the outer parse', () => {
  test('malformed args return {error}', () => {
    const sandbox = createSandbox({ seed: { 'peptides.json': PEPTIDES } });
    try {
      const { dispatchToolCall } = freshTools(sandbox);
      const tc = { function: { name: 'append_row', arguments: '{not json' } };
      const res = JSON.parse(dispatchToolCall(tc));
      assert.match(res.error, /invalid JSON in tool arguments/);
    } finally { cleanupSandbox(sandbox); }
  });
});
