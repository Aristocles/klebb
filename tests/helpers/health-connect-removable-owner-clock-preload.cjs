// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inputs = require('../fixtures/health-connect/fixed-child-clock-inputs-v1.json');
const CapturedDate = Date;
const supplied = process.env.OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY;

if (supplied !== undefined) {
  const directory = path.resolve(supplied);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(directory), temporaryRoot);
  assert.ok(path.basename(directory).startsWith('eh-selection-observer-'));
  const clock = path.join(directory, 'clock');

  function directoryPresent() {
    let info;
    try { info = fs.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.isDirectory(), true);
    assert.equal(fs.realpathSync(directory), directory);
    return true;
  }
  function milliseconds() {
    if (!directoryPresent()) return null;
    let info;
    try { info = fs.lstatSync(clock); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.isFile(), true);
    const text = fs.readFileSync(clock, 'utf8');
    const input = [inputs.base, inputs.advanced].find(value => value.instant === text);
    assert.ok(input && Number.isSafeInteger(input.milliseconds));
    return input.milliseconds;
  }

  assert.equal(directoryPresent(), true);
  milliseconds();
  function RemovableOwnerDate(...args) {
    if (new.target && args.length)
      return Reflect.construct(CapturedDate, args, new.target);
    const fixed = milliseconds();
    if (!new.target)
      return fixed === null ? Reflect.apply(CapturedDate, undefined, args) :
        new CapturedDate(fixed).toString();
    return Reflect.construct(CapturedDate, fixed === null ? [] : [fixed], new.target);
  }
  Object.setPrototypeOf(RemovableOwnerDate, CapturedDate);
  RemovableOwnerDate.prototype = CapturedDate.prototype;
  RemovableOwnerDate.now = () => {
    const fixed = milliseconds();
    return fixed === null ? CapturedDate.now() : fixed;
  };
  global.Date = RemovableOwnerDate;
}
