// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic child-only staging clock and actual registered timer observer.
// Authority clocks remain real. No product route, header or clock bypass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers');
const home = path.resolve(process.env.HEALTH_HOME || '');
assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
  path.basename(home).startsWith('eh-test-'));
const controlPath = path.resolve(process.env.INDEPENDENT_OBJECT_CLOCK_CONTROL || '');
const observationPath = path.resolve(process.env.INDEPENDENT_OBJECT_CLOCK_OBSERVATIONS || '');
const product = path.resolve(process.env.INDEPENDENT_OBJECT_PRODUCT_ROOT || '');
assert.equal(path.dirname(controlPath), home);
assert.equal(path.dirname(observationPath), home);
const MAX_CLOCK_REVISIONS = 32;
function control() {
  // Revision zero is the immutable initial file. Each later publication renames
  // a closed temporary file to a previously absent name, never over a file this
  // Windows child may currently have open. Partial temporary files are ignored.
  const prefix = path.basename(controlPath) + '.revision-';
  const revisions = fs.readdirSync(home).filter(name =>
    name.startsWith(prefix) && name.endsWith('.json'));
  assert.ok(revisions.length < MAX_CLOCK_REVISIONS);
  for (const name of revisions) {
    const revision = name.slice(prefix.length, -5);
    assert.ok(/^[0-9]{4}$/.test(revision));
    assert.ok(Number(revision) > 0 && Number(revision) < MAX_CLOCK_REVISIONS);
  }
  const filename = revisions.length ?
    path.join(home, revisions.sort().at(-1)) : controlPath;
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.ok(Number.isSafeInteger(value.now) && value.now > 0);
  assert.ok(Number.isSafeInteger(value.tick) && value.tick >= 0);
  assert.ok(value.freeze === undefined || typeof value.freeze === 'boolean');
  return value;
}
const initial = control();
let lastTick = initial.tick;
const actualNow = Date.now.bind(Date);
const actualInterval = timers.setInterval;
const actualClearInterval = timers.clearInterval;
const registered = new Map();
function observation(value) {
  fs.appendFileSync(observationPath, JSON.stringify(value) + '\n',
    { encoding: 'utf8', mode: 0o600 });
}
Date.now = function stagingClockOnly() {
  // Only the immediate objects.js caller receives the staging clock. An
  // authority callback reached through objects.js still has a real clock.
  const caller = (new Error().stack?.split('\n')[2] || '').replaceAll('\\', '/');
  if (caller.includes('/lib/health-connect/objects.js:')) {
    const value = control();
    observation({ kind: 'staging-clock-read', now: value.now });
    return value.now;
  }
  return actualNow();
};
function interval(callback, delay, ...args) {
  const caller = (new Error().stack?.split('\n')[2] || '').replaceAll('\\', '/');
  if (!caller.includes('/lib/health-connect/objects.js:')) {
    return actualInterval(callback, delay, ...args);
  }
  assert.equal(delay, 300000, 'observe the actual five-minute stage cleanup registration');
  assert.equal(typeof callback, 'function');
  const wrapped = async (...invocationArgs) => {
    observation({ kind: 'registered-sweep-fired', delay, tick: control().tick });
    try {
      await callback(...invocationArgs);
      observation({ kind: 'registered-sweep-complete', delay, tick: control().tick });
    } catch {
      observation({ kind: 'registered-sweep-failed', delay, tick: control().tick });
      throw new Error('synthetic observed stage sweep failed');
    }
  };
  const timer = actualInterval(wrapped, delay, ...args);
  registered.set(timer, { invoke: () => wrapped(...args), delay });
  observation({ kind: 'registered-sweep', delay });
  return timer;
}
function clear(timer) {
  registered.delete(timer);
  return actualClearInterval(timer);
}
global.setInterval = timers.setInterval = interval;
global.clearInterval = timers.clearInterval = clear;
actualInterval(() => {
  const value = control();
  if (value.tick === lastTick) return;
  assert.equal(value.tick, lastTick + 1, 'bounded synthetic scheduler triggers are ordered');
  lastTick = value.tick;
  if (value.freeze !== undefined) {
    const freeze = require(path.join(product, 'lib/import/freeze'));
    if (value.freeze && !freeze.frozen()) {
      freeze.engage('synthetic-object-cleanup-review');
      observation({ kind: 'test-freeze-engaged', tick: value.tick });
    } else if (!value.freeze && freeze.frozen()) {
      freeze.release();
      observation({ kind: 'test-freeze-released', tick: value.tick });
    }
  }
  observation({ kind: 'synthetic-scheduler-trigger', tick: value.tick });
  for (const { invoke } of registered.values()) {
    void invoke().catch(() => {}); // Actual failure is recorded and fails the assertion.
  }
}, 20).unref();
observation({ kind: 'staging-clock-preload-ready' });
