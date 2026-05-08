// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.discoveries.test.js
// Pure unit tests for the discovered.json read/write + sync helpers.

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let discoveries;

function reloadModule() {
  delete require.cache[require.resolve('../config/paths')];
  delete require.cache[require.resolve('../health-auto-export/discoveries')];
  discoveries = require('../health-auto-export/discoveries');
}

describe('discoveries module', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-disc-'));
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    fs.mkdirSync(path.join(tmp, 'data', 'auto-export'), { recursive: true });
    reloadModule();
  });

  after(() => {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
    delete process.env.HEALTH_HOME;
    delete require.cache[require.resolve('../config/paths')];
    delete require.cache[require.resolve('../health-auto-export/discoveries')];
  });

  test('load() on missing file returns empty object', () => {
    assert.deepEqual(discoveries.load(), {});
  });

  test('sync() records new unsubscribed metrics', () => {
    const state = discoveries.sync({
      seen: ['heart_rate_variability', 'blood_oxygen_saturation'],
      subscribed: ['step_count'],
      now: '2026-05-08T00:00:00.000Z',
    });
    assert.ok(state.heart_rate_variability);
    assert.equal(state.heart_rate_variability.dismissed, false);
    assert.equal(state.heart_rate_variability.firstSeenAt, '2026-05-08T00:00:00.000Z');
    assert.ok(state.blood_oxygen_saturation);
  });

  test('sync() preserves dismiss state across calls', () => {
    discoveries.sync({
      seen: ['heart_rate_variability'], subscribed: [],
      now: '2026-05-08T00:00:00.000Z',
    });
    discoveries.dismiss('heart_rate_variability', '2026-05-09T00:00:00.000Z');

    discoveries.sync({
      seen: ['heart_rate_variability'], subscribed: [],
      now: '2026-05-10T00:00:00.000Z',
    });
    const state = discoveries.load();
    assert.equal(state.heart_rate_variability.dismissed, true);
    assert.equal(state.heart_rate_variability.dismissedAt, '2026-05-09T00:00:00.000Z');
    // firstSeenAt does not change on re-sync.
    assert.equal(state.heart_rate_variability.firstSeenAt, '2026-05-08T00:00:00.000Z');
  });

  test('sync() removes entries whose metric now has a subscriber', () => {
    discoveries.sync({ seen: ['step_count'], subscribed: [] });
    assert.ok(discoveries.load().step_count);

    discoveries.sync({ seen: [], subscribed: ['step_count'] });
    assert.equal(discoveries.load().step_count, undefined);
  });

  test('sync() does not duplicate already-known entries', () => {
    discoveries.sync({ seen: ['hrv'], subscribed: [], now: 't1' });
    discoveries.sync({ seen: ['hrv'], subscribed: [], now: 't2' });
    const state = discoveries.load();
    // First-seen timestamp must be sticky.
    assert.equal(state.hrv.firstSeenAt, 't1');
  });

  test('dismiss() / unhide() round-trip', () => {
    discoveries.sync({ seen: ['hrv'], subscribed: [] });
    assert.equal(discoveries.dismiss('hrv'), true);
    assert.equal(discoveries.load().hrv.dismissed, true);

    assert.equal(discoveries.unhide('hrv'), true);
    assert.equal(discoveries.load().hrv.dismissed, false);
    assert.equal(discoveries.load().hrv.dismissedAt, undefined);
  });

  test('dismiss() / unhide() return false for unknown metric', () => {
    assert.equal(discoveries.dismiss('nope'), false);
    assert.equal(discoveries.unhide('nope'), false);
  });

  test('list() partitions by dismissed flag and sorts', () => {
    discoveries.sync({ seen: ['a', 'b', 'c'], subscribed: [], now: 't1' });
    discoveries.dismiss('b');
    discoveries.dismiss('c');
    const out = discoveries.list();
    assert.equal(out.undismissed.length, 1);
    assert.equal(out.undismissed[0].metric, 'a');
    assert.equal(out.dismissed.length, 2);
    assert.deepEqual(out.dismissed.map(e => e.metric), ['b', 'c']);
  });

  test('sync() lazily creates the file (not present before first write)', () => {
    const file = path.join(tmp, 'data', 'auto-export', 'discovered.json');
    assert.equal(fs.existsSync(file), false, 'file should not exist initially');
    discoveries.sync({ seen: ['hrv'], subscribed: [] });
    assert.equal(fs.existsSync(file), true, 'file should exist after sync with new entries');
  });

  test('sync() with empty seen + empty subscribed is a no-op', () => {
    discoveries.sync({ seen: [], subscribed: [] });
    const file = path.join(tmp, 'data', 'auto-export', 'discovered.json');
    assert.equal(fs.existsSync(file), false);
  });
});
