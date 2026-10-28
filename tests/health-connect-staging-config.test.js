// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const read = raw => {
  const env = { ...process.env, HEALTH_SYSTEM_PROMPT_FILE: '',
    HEALTH_CONNECT_STAGING_MAX_BYTES: raw };
  if (raw === undefined) delete env.HEALTH_CONNECT_STAGING_MAX_BYTES;
  return spawnSync(process.execPath, ['-e',
    'process.stdout.write(String(require("./config/env").HEALTH_CONNECT_STAGING_MAX_BYTES))'],
  { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 10000 });
};
test('absent staging limit uses the documented 256 MiB default', () => {
  for (const raw of [undefined, '']) {
    const result = read(raw);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '268435456');
  }
});
test('positive staging limits retain the exact requested inclusive bound', () => {
  for (const raw of ['1', '1049871', '1049872', '2099743', '2099744', '268435456']) {
    const result = read(raw);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, raw);
  }
});
test('invalid staging configuration fails instead of expanding the requested bound', () => {
  for (const raw of ['0', '-1', '01', '1.5', '1e6', '1049872oops', ' 1049872 ',
    '268435457', '9007199254740992']) {
    const result = read(raw);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('HEALTH_CONNECT_STAGING_MAX_BYTES must be an integer'));
  }
});
