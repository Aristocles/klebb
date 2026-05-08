// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/health-auto-export.diagnostics.test.js
// Pure unit tests for the last-push.json read/write helpers.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('diagnostics: writeLastPush / readLastPush', () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-diag-'));
    // Point HEALTH_HOME at the tmp dir and drop the cached module so
    // config/paths resolves against it. We only need this module-level
    // tweak; other tests run in their own processes.
    process.env.HEALTH_HOME = tmp;
    process.env.HEALTH_HOME_WARNED = '1';
    fs.mkdirSync(path.join(tmp, 'data', 'auto-export'), { recursive: true });
    delete require.cache[require.resolve('../config/paths')];
    delete require.cache[require.resolve('../health-auto-export/diagnostics')];
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.HEALTH_HOME;
    delete require.cache[require.resolve('../config/paths')];
    delete require.cache[require.resolve('../health-auto-export/diagnostics')];
  });

  test('readLastPush returns null when file missing', () => {
    const diag = require('../health-auto-export/diagnostics');
    assert.equal(diag.readLastPush(), null);
  });

  test('writeLastPush then readLastPush round-trips', () => {
    const diag = require('../health-auto-export/diagnostics');
    const snap = {
      receivedAt: '2026-05-08T14:22:11.003Z',
      payloadBytes: 1234,
      subscribers: [{ id: 'steps', metric: 'step_count', rowsWritten: 2 }],
      availableUnsubscribed: ['heart_rate_variability'],
      warnings: [],
    };
    diag.writeLastPush(snap);
    assert.deepEqual(diag.readLastPush(), snap);
  });

  test('writeLastPush overwrites prior snapshot', () => {
    const diag = require('../health-auto-export/diagnostics');
    diag.writeLastPush({ receivedAt: 'a', payloadBytes: 1, subscribers: [], availableUnsubscribed: [], warnings: [] });
    diag.writeLastPush({ receivedAt: 'b', payloadBytes: 2, subscribers: [], availableUnsubscribed: [], warnings: [] });
    assert.equal(diag.readLastPush().receivedAt, 'b');
    assert.equal(diag.readLastPush().payloadBytes, 2);
  });
});
