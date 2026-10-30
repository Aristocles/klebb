// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Explicit child-only synthetic clock input; production code and parent clocks stay unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inputs = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json');
const directory = fs.realpathSync(process.env.HEALTH_HOME);
assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(directory).startsWith('eh-test-'));
assert.equal(fs.lstatSync(process.env.HEALTH_HOME).isSymbolicLink(), false);
const text = process.env.INDEPENDENT_FIXED_CHILD_CLOCK;
const input = [inputs.base, inputs.advanced].find(value => String(value.milliseconds) === text);
assert.ok(input && Number.isSafeInteger(input.milliseconds));
const RealDate = Date;
function FixedChildDate(...args) {
  if (!new.target) return new RealDate(input.milliseconds).toString();
  return Reflect.construct(RealDate, args.length ? args : [input.milliseconds], new.target);
}
Object.setPrototypeOf(FixedChildDate, RealDate);
FixedChildDate.prototype = RealDate.prototype;
FixedChildDate.now = () => input.milliseconds;
global.Date = FixedChildDate;
