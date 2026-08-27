// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/activity-state.test.js
// The activity signal's clock logic (#664), driven with an injected `now` so
// day boundaries, the 7-day window and the 14-day prune are exact rather
// than whatever today happens to be. Fresh-require against a temp
// HEALTH_HOME; no spawnServer in this file (harness rule).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 86400000;
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);

let home;
function freshActivity() {
  for (const k of Object.keys(require.cache)) {
    if (/activity-state\.js$|config[\\/]paths\.js$/.test(k)) delete require.cache[k];
  }
  return require('../lib/activity-state');
}

describe('activity-state', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-activity-'));
    process.env.HEALTH_HOME = home;
  });

  test('empty state serves nulls, not errors', () => {
    const a = freshActivity();
    assert.deepEqual(a.summary(T0), { lastActiveAt: null, activeDays7: 0 });
  });

  test('a GET of anything but the shell is not an interaction', () => {
    const a = freshActivity();
    a.record('GET', '/api/manifests', T0);
    a.record('GET', '/js/app.js', T0);
    assert.equal(a.summary(T0).lastActiveAt, null,
      'components poll; an open tab must never read as a person');
    a.record('GET', '/', T0);
    assert.equal(a.summary(T0).lastActiveAt, new Date(T0).toISOString(),
      'loading the shell is a person showing up');
  });

  test('activeDays7 counts distinct days in the window, not requests', () => {
    const a = freshActivity();
    a.record('POST', '/api/manifests', T0 - 2 * DAY);
    a.record('POST', '/api/manifests', T0 - 2 * DAY + 1000);
    a.record('PUT', '/api/manifests/x', T0 - 1 * DAY);
    a.record('GET', '/', T0);
    assert.equal(a.summary(T0).activeDays7, 3, 'three days, despite four requests');
    assert.equal(a.summary(T0 + 8 * DAY).activeDays7, 0, 'the window slides shut');
  });

  test('a day older than the window is out; the newest timestamp survives anyway', () => {
    const a = freshActivity();
    a.record('POST', '/api/x', T0 - 9 * DAY);
    const s = a.summary(T0);
    assert.equal(s.activeDays7, 0);
    assert.equal(s.lastActiveAt, new Date(T0 - 9 * DAY).toISOString(),
      'last interaction is reported however old it is');
  });

  test('state survives a restart through the sidecar file', () => {
    let a = freshActivity();
    a.record('POST', '/api/manifests', T0);
    a.flush(T0);
    const file = path.join(home, 'data', '_meta', 'activity.json');
    assert.ok(fs.existsSync(file), 'sidecar written');

    a = freshActivity();
    const s = a.summary(T0 + 1000);
    assert.equal(s.lastActiveAt, new Date(T0).toISOString());
    assert.equal(s.activeDays7, 1);
  });

  test('the prune keeps 14 days and drops the rest at flush', () => {
    const a = freshActivity();
    a.record('POST', '/api/x', T0 - 20 * DAY);
    a.record('POST', '/api/x', T0 - 10 * DAY);
    a.record('POST', '/api/x', T0);
    a.flush(T0);
    const file = path.join(home, 'data', '_meta', 'activity.json');
    const days = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).days);
    assert.equal(days.length, 2, 'the 20-day-old bucket is gone, the 10-day-old one stays');
  });

  test('a corrupt sidecar degrades to empty, never a crash', () => {
    const file = path.join(home, 'data', '_meta', 'activity.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json{');
    const a = freshActivity();
    assert.deepEqual(a.summary(T0), { lastActiveAt: null, activeDays7: 0 });
  });
});
