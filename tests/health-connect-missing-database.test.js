// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');

test('an absent configured main database refuses native frontier and commit without creating a replacement', () => {
  const home = createSandbox();
  const database = path.join(home, 'db', 'klebb.db');
  fs.mkdirSync(path.dirname(database));
  const env = { ...process.env, HEALTH_HOME: home, NODE_OPTIONS: '' };
  for (const name of [
    'HEALTH_DB_DIR', 'HEALTH_DB_FILE', 'HEALTH_DATA_DIR', 'HEALTH_REPORTS_DIR',
    'HEALTH_AUTO_EXPORT_DIR', 'HEALTH_SESSIONS_DIR', 'HEALTH_CREDENTIALS_DIR',
    'HEALTH_ARCHIVE_DIR', 'HEALTH_CONFIG_PATH', 'HEALTH_CHAT_DIR', 'HEALTH_USER_FILE',
    'HEALTH_NOTIFICATIONS_STATE_FILE', 'HEALTH_INBOX_DIR', 'HEALTH_KEYS_DIR',
    'HEALTH_VAPID_FILE', 'HEALTH_PUSH_SUBSCRIPTIONS_FILE',
  ]) env[name] = '';
  try {
    assert.equal(fs.existsSync(database), false, 'the actual file is absent, while its directory exists');
    const child = spawnSync(process.execPath, ['-e', `
      const history = require('./lib/health-connect/history');
      const bank = require('./tests/fixtures/health-connect/durable-history-independent-vectors.json');
      const vector = bank.vectors.find(item => item.id === 'initial-raw-only');
      const payload = JSON.parse(vector.payloadJson);
      const results = [];
      for (const operation of [
        () => history.readFrontiers([{ binding: payload.binding, recordType: payload.recordType }]),
        () => history.commitBatch(payload, vector.expectedReceipt.payloadDigest),
      ]) {
        try { results.push({ returned: operation() }); }
        catch (error) { results.push({ status: error.status, code: error.code }); }
      }
      console.log(JSON.stringify(results));
    `], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [
      { status: 503, code: 'storage-unavailable' },
      { status: 503, code: 'storage-unavailable' },
    ]);
    assert.equal(fs.existsSync(database), false, 'the native service must not create an empty replacement');
  } finally { cleanupSandbox(home); }
});
