// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createSandbox, cleanupSandbox, spawnServer, fakeAuthState } = require('../helpers/sandbox');
const ORIGIN = 'https://boundary.example.test';
function post(server, cookie, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${server.baseUrl}/api/connectors/health-connect/pairing-grants`, {
      method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN,
        'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, json: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('bounded request timed out')));
    request.end(payload);
  });
}
test('management body rejects duplicates, invalid UTF-8 and oversized bytes without issuing grants', async () => {
  const owner = fakeAuthState('boundary-owner');
  const home = createSandbox({ credentials: owner.credentials, sessions: owner.sessions });
  let server;
  try {
    server = await spawnServer(home, {
      HEALTH_ORIGIN: ORIGIN, HEALTH_RP_ID: 'boundary.example.test', AGENT_API_TOKEN: '',
      KLEBB_ADMIN_TOKEN: '', KLEBB_CLOUD: '', KLEBB_DEMO: '', NODE_OPTIONS: '',
      HEALTH_DATA_DIR: '', HEALTH_REPORTS_DIR: '', HEALTH_AUTO_EXPORT_DIR: '',
      HEALTH_SESSIONS_DIR: '', HEALTH_CREDENTIALS_DIR: '', HEALTH_ARCHIVE_DIR: '',
      HEALTH_CONFIG_PATH: '', HEALTH_DB_DIR: '', HEALTH_DB_FILE: '', HEALTH_CHAT_DIR: '',
      HEALTH_USER_FILE: '', HEALTH_NOTIFICATIONS_STATE_FILE: '', HEALTH_INBOX_DIR: '',
      HEALTH_KEYS_DIR: '', HEALTH_VAPID_FILE: '', HEALTH_PUSH_SUBSCRIPTIONS_FILE: '',
      HEALTH_AUTO_EXPORT_TOKEN: '',
    });
    const cases = [
      [Buffer.from('{"categories":["StepsRecord"],"name":"A","\\u006eame":"B"}'), 'invalid-message'],
      [Buffer.from([0xc3, 0x28]), 'invalid-message'],
      [Buffer.from(' '.repeat(16385)), 'limit-exceeded'],
    ];
    for (const [payload, code] of cases) {
      const response = await post(server, owner.cookie, payload);
      assert.equal(response.status, 400);
      assert.equal(response.json.code, code);
      assert.equal(response.json.grant, undefined);
      const state = JSON.parse(fs.readFileSync(path.join(home, 'credentials', 'health-connect.json'), 'utf8'));
      assert.deepEqual(state.grants, []);
      assert.deepEqual(state.connectors, []);
    }
  } finally {
    if (server) await server.kill();
    cleanupSandbox(home);
  }
});
