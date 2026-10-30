// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSandbox, cleanupSandbox } = require('./helpers/sandbox');
const inputs = require('./fixtures/health-connect/fixed-child-clock-inputs-v1.json');
const preload = path.resolve(__dirname, 'helpers/health-connect-fixed-child-clock-preload.cjs');

test('explicit child clock inputs preserve Date values parsing timers and monotonic advancement', { timeout: 30000 }, () => {
  const script = `
    const assert = require('node:assert/strict');
    const RealDate = Date, timeout = setTimeout, monotonic = process.hrtime.bigint;
    const input = JSON.parse(process.argv[2]);
    require(process.argv[1]);
    assert.equal(Date.now(), input.milliseconds);
    assert.equal(new Date().toISOString(), input.instant);
    assert.equal(Date('ignored explicit callable argument'), new RealDate(input.milliseconds).toString());
    assert.equal(new Date(0).getTime(), 0);
    assert.equal(new Date('2001-02-03T04:05:06.123Z').toISOString(), '2001-02-03T04:05:06.123Z');
    assert.equal(new Date(2001, 1, 3).getTime(), new RealDate(2001, 1, 3).getTime());
    assert.equal(new Date(new RealDate(123)).getTime(), 123);
    assert.ok(Number.isNaN(new Date(NaN).getTime()));
    assert.equal(Date.parse, RealDate.parse);
    assert.equal(Date.UTC, RealDate.UTC);
    assert.equal(Date.prototype, RealDate.prototype);
    assert.equal(Date.parse(input.instant), input.milliseconds);
    assert.equal(setTimeout, timeout);
    assert.equal(process.hrtime.bigint, monotonic);
    const before = monotonic();
    setTimeout(() => {
      assert.ok(monotonic() > before);
      assert.equal(Date.now(), input.milliseconds);
      process.stdout.write('fixed-clock-primitives-preserved\\n');
    }, 1);
  `;
  for (const input of [inputs.base, inputs.advanced]) {
    const home = createSandbox();
    try {
      const result = spawnSync(process.execPath, ['-e', script, preload, JSON.stringify(input)], {
        env: { ...process.env, NODE_OPTIONS: '', HEALTH_HOME: home,
          INDEPENDENT_FIXED_CHILD_CLOCK: String(input.milliseconds) },
        encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'fixed-clock-primitives-preserved\n');
    } finally { cleanupSandbox(home); }
  }
});
