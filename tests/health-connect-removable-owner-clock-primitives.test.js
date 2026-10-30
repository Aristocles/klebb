// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inputs = require('./fixtures/health-connect/fixed-child-clock-inputs-v1.json');
const preload = path.resolve(__dirname, 'helpers/health-connect-removable-owner-clock-preload.cjs');
const reference = { milliseconds: 1793000000789, instant: '2026-10-26T07:33:20.789Z' };
const temporaryRoot = fs.realpathSync(os.tmpdir());

function verifyDirectory(directory) {
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  assert.ok(path.basename(directory).startsWith('eh-selection-observer-'));
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
  assert.equal(fs.realpathSync(directory), path.resolve(directory));
}
function cleanup(resource) {
  assert.equal(path.resolve(resource.path), resource.allocated);
  assert.equal(path.dirname(resource.allocated), temporaryRoot);
  assert.ok(path.basename(resource.allocated).startsWith('eh-selection-observer-'));
  let info;
  try { info = fs.lstatSync(resource.path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (resource.kind === 'alias') {
    assert.equal(info.isSymbolicLink(), true);
    fs.unlinkSync(resource.path);
  } else {
    verifyDirectory(resource.path);
    fs.rmSync(resource.path, { recursive: true });
  }
}

const script = `
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const assert = require('node:assert/strict');
  const input = JSON.parse(process.argv[2]), reference = JSON.parse(process.argv[3]);
  const mode = process.argv[4], directory = process.env.OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY;
  const RealDate = Date, timeout = setTimeout, monotonic = process.hrtime.bigint;
  function ReferenceDate(...args) {
    if (!new.target) return new RealDate(reference.milliseconds).toString();
    return Reflect.construct(RealDate, args.length ? args : [reference.milliseconds], new.target);
  }
  Object.setPrototypeOf(ReferenceDate, RealDate);
  ReferenceDate.prototype = RealDate.prototype;
  ReferenceDate.now = () => reference.milliseconds;
  global.Date = ReferenceDate;
  function snapshot(expectedMilliseconds) {
    return {
      pid: process.pid, now: Date.now(), noArgumentsInstant: new Date().toISOString(),
      callableMatchesIndependentInput: Date('ignored explicit callable argument') ===
        new RealDate(expectedMilliseconds).toString(),
      explicitEpoch: new Date(0).getTime(),
      explicitText: new Date('2001-02-03T04:05:06.123Z').toISOString(),
      explicitComponentsMatch: new Date(2001, 1, 3).getTime() === new RealDate(2001, 1, 3).getTime(),
      copiedDate: new Date(new RealDate(123)).getTime(),
      invalidIsNaN: Number.isNaN(new Date(NaN).getTime()),
      parseIdentity: Date.parse === RealDate.parse, utcIdentity: Date.UTC === RealDate.UTC,
      prototypeIdentity: Date.prototype === RealDate.prototype,
      timerIdentity: setTimeout === timeout, monotonicIdentity: process.hrtime.bigint === monotonic,
      inputParsedMilliseconds: Date.parse(new RealDate(expectedMilliseconds).toISOString()),
    };
  }
  let loadError;
  try { require(process.argv[1]); }
  catch (error) { loadError = error; }
  if (mode !== 'positive') {
    process.stdout.write(JSON.stringify({
      loaded: !loadError, errorName: loadError?.name || null, errorCode: loadError?.code || null,
      referenceDateUnchanged: Date === ReferenceDate,
      afterRefusal: snapshot(reference.milliseconds),
    }));
  } else {
    if (loadError) throw loadError;
    const present = snapshot(input.base.milliseconds), clock = path.join(directory, 'clock');
    fs.writeFileSync(clock, input.advanced.instant, { mode: 0o600 });
    const advanced = snapshot(input.advanced.milliseconds);
    fs.unlinkSync(clock);
    const released = snapshot(reference.milliseconds);
    assert.equal(path.dirname(path.resolve(directory)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('eh-selection-observer-'));
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    assert.equal(fs.realpathSync(directory), path.resolve(directory));
    fs.rmdirSync(directory);
    const removed = snapshot(reference.milliseconds), before = monotonic();
    timeout(() => process.stdout.write(JSON.stringify({
      present, advanced, released, removed, clockAbsent: !fs.existsSync(clock),
      directoryAbsent: !fs.existsSync(directory), monotonicAdvanced: monotonic() > before,
    })), 1);
  }
`;
function assertSnapshot(actual, expected) {
  assert.equal(actual.now, expected.milliseconds);
  assert.equal(actual.noArgumentsInstant, expected.instant);
  assert.equal(actual.callableMatchesIndependentInput, true);
  assert.equal(actual.explicitEpoch, 0);
  assert.equal(actual.explicitText, '2001-02-03T04:05:06.123Z');
  assert.equal(actual.explicitComponentsMatch, true);
  assert.equal(actual.copiedDate, 123);
  assert.equal(actual.invalidIsNaN, true);
  for (const field of ['parseIdentity', 'utcIdentity', 'prototypeIdentity',
    'timerIdentity', 'monotonicIdentity']) assert.equal(actual[field], true, field);
  assert.equal(actual.inputParsedMilliseconds, expected.milliseconds);
}

test('removable owner clock uses fixed input then restores captured Date and refuses invalid ownership',
  { timeout: 120000 }, () => {
    const resources = [];
    let primary;
    function create() {
      const directory = fs.mkdtempSync(path.join(temporaryRoot, 'eh-selection-observer-'));
      resources.push({ path: directory, allocated: path.resolve(directory), kind: 'directory' });
      verifyDirectory(directory);
      fs.chmodSync(directory, 0o700);
      return directory;
    }
    function probe(directory, mode) {
      const result = spawnSync(process.execPath, ['-e', script, preload,
        JSON.stringify(inputs), JSON.stringify(reference), mode], {
        env: { ...process.env, NODE_OPTIONS: '', OWNER_INITIAL_PUBLICATION_CLOCK_DIRECTORY: directory },
        encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    }
    try {
      const directory = create();
      fs.writeFileSync(path.join(directory, 'clock'), inputs.base.instant, { flag: 'wx', mode: 0o600 });
      const observed = probe(directory, 'positive');
      SystemSetupMarker();
      assert.equal(observed.present.now, inputs.base.milliseconds,
        'fixed clock present returns literal base rather than captured reference Date');
      assertSnapshot(observed.present, inputs.base);
      assertSnapshot(observed.advanced, inputs.advanced);
      assertSnapshot(observed.released, reference);
      assertSnapshot(observed.removed, reference);
      for (const phase of [observed.advanced, observed.released, observed.removed])
        assert.equal(phase.pid, observed.present.pid);
      assert.equal(observed.clockAbsent, true);
      assert.equal(observed.directoryAbsent, true);
      assert.equal(observed.monotonicAdvanced, true);
      for (const mode of ['malformed', 'unowned', 'symlink-file',
        'dangling-symlink-file', 'symlink-directory']) {
        const owned = create();
        let inputDirectory = owned;
        if (mode === 'unowned') {
          inputDirectory = path.join(owned, 'nested');
          fs.mkdirSync(inputDirectory, { mode: 0o700 });
        }
        const clock = path.join(inputDirectory, 'clock');
        if (mode === 'symlink-file' || mode === 'dangling-symlink-file') {
          const target = path.join(owned, 'target');
          if (mode === 'symlink-file')
            fs.writeFileSync(target, inputs.base.instant, { flag: 'wx', mode: 0o600 });
          fs.symlinkSync(target, clock, 'file');
        } else fs.writeFileSync(clock, mode === 'malformed' ? 'not-an-instant' : inputs.base.instant,
          { flag: 'wx', mode: 0o600 });
        if (mode === 'symlink-directory') {
          inputDirectory = owned + '-alias';
          assert.equal(path.dirname(path.resolve(inputDirectory)), temporaryRoot);
          assert.equal(fs.existsSync(inputDirectory), false);
          fs.symlinkSync(owned, inputDirectory, 'dir');
          resources.push({ path: inputDirectory, allocated: path.resolve(inputDirectory), kind: 'alias' });
        }
        const refusal = probe(inputDirectory, mode);
        assert.equal(refusal.loaded, false, mode);
        assert.equal(refusal.errorName, 'AssertionError', mode);
        assert.equal(refusal.errorCode, 'ERR_ASSERTION', mode);
        assert.equal(refusal.referenceDateUnchanged, true, mode);
        assertSnapshot(refusal.afterRefusal, reference);
      }
    } catch (error) { primary = error; }
    const errors = primary ? [primary] : [];
    for (const resource of resources.reverse()) {
      try { cleanup(resource); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors,
      'Removable-clock primitive control or owned cleanup failed', { cause: primary || errors[0] });
  });
function SystemSetupMarker() {
  console.log('REMOVABLE_OWNER_CLOCK_PRIMITIVE_SETUP_COMPLETE');
}
