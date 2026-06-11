// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/notifications-state-prune.test.js
//
// Verifies the registry's onDelete hook prunes orphan items[] entries
// from notifications.state.json when a card is deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-prune-'));
  const stateFile = path.join(root, 'notifications.state.json');
  process.env.HEALTH_NOTIFICATIONS_STATE_FILE = stateFile;
  // Reset the require cache so PATHS picks up the override.
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('config' + path.sep + 'paths.js') || k.includes('notifications-state')) {
      delete require.cache[k];
    }
  }
  return { root, stateFile };
}

test.describe('notifications-state.pruneCard', () => {
  test('removes only the keys whose runtime id starts with `${cardId}#`', () => {
    const { stateFile } = freshState();
    const stateMod = require('../lib/notifications-state');

    stateMod.writeItem('mood#evening-log', { enabled: true, lastFired: 'a' });
    stateMod.writeItem('mood#morning-log', { enabled: false, lastFired: 'b' });
    stateMod.writeItem('weight#daily', { enabled: true, lastFired: 'c' });

    const removed = stateMod.pruneCard('mood');
    assert.equal(removed, 2);

    const remaining = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(remaining.items), ['weight#daily']);
  });

  test('returns 0 when no matching keys exist', () => {
    freshState();
    const stateMod = require('../lib/notifications-state');
    stateMod.writeItem('weight#daily', { enabled: true });
    assert.equal(stateMod.pruneCard('mood'), 0);
  });

  test('returns 0 when the state file does not exist yet', () => {
    freshState();
    const stateMod = require('../lib/notifications-state');
    assert.equal(stateMod.pruneCard('mood'), 0);
  });
});
