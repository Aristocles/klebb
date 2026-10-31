// SPDX-License-Identifier: AGPL-3.0-only
// Test-only, one-shot export stream control for a spawned isolated server.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const control = fs.realpathSync(process.env.KLEBB_TEST_EXPORT_GATE_DIR);
const home = fs.realpathSync(process.env.HEALTH_HOME);
const relative = path.relative(home, control);
if (!relative || (!path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`))) {
  throw new Error('Export gate controls must be outside the isolated home');
}
const file = name => path.join(control, name);
const original = fs.createReadStream;
let selected = 0;
fs.createReadStream = function (filename, ...args) {
  if (typeof filename !== 'string' || path.dirname(path.resolve(filename)) !== home ||
      !/^export-staging\.\d+\.zip$/.test(path.basename(filename))) {
    return original.apply(this, arguments);
  }
  try { fs.unlinkSync(file('arm')); } catch (e) {
    if (e.code === 'ENOENT') return original.apply(this, arguments);
    fs.createReadStream = original;
    throw e;
  }
  fs.createReadStream = original;
  selected++;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 1 ||
      !Number.isSafeInteger(stat.size) || fs.realpathSync(filename) !== path.resolve(filename)) {
    throw new Error('Export gate requires one regular direct-home ZIP larger than one byte');
  }
  const state = { selectedOnce: selected, zipName: path.basename(filename),
    zipBytes: stat.size, forwardedBytes: 0, heldCallback: false,
    destinationAttached: false, terminal: false, terminalEvent: null,
    released: false, failure: null };
  const source = original.apply(this, arguments);
  let callback = null, suffix = null, watcher = null, destination = null;
  let stopped = false;
  const stopWatcher = () => { if (watcher) { watcher.close(); watcher = null; } };
  const detach = () => {
    if (!destination) return;
    destination.removeListener('finish', onFinish);
    destination.removeListener('close', onClose);
    destination.removeListener('error', onError);
  };
  const persist = () => {
    try {
      fs.writeFileSync(file('state.next'), JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(file('state.next'), file('state.json'));
      return true;
    } catch (e) {
      state.failure = 'gate state recording failed';
      stopWatcher();
      gate.destroy(e);
      return false;
    }
  };
  const gate = new Transform({
    transform(chunk, encoding, done) {
      if (state.released) { done(null, chunk); return; }
      if (!chunk.length) { done(); return; }
      suffix = chunk.subarray(1);
      callback = done;
      state.heldCallback = true;
      state.forwardedBytes = 1;
      this.push(chunk.subarray(0, 1));
      persist();
      queueMicrotask(checkControl);
    },
    destroy(error, done) {
      stopped = true;
      stopWatcher();
      // The response owns its terminal event, even after normal gate teardown.
      source.destroy();
      const pending = callback;
      callback = null; suffix = null; state.heldCallback = false;
      if (pending) pending(error || new Error('Export gate cancelled'));
      done(error);
    },
  });
  gate.on('error', () => { state.failure = 'export gate stream failed'; persist(); });
  source.on('error', e => gate.destroy(e));
  source.on('close', () => {
    if (!stopped && !source.readableEnded) gate.destroy(new Error('Export ZIP source closed early'));
  });
  function terminal(event) {
    state.terminal = true; state.terminalEvent = event;
    stopWatcher(); detach(); persist();
    if (!state.released || event !== 'finish') gate.destroy(new Error('Export response terminated'));
  }
  function onFinish() { terminal('finish'); }
  function onClose() { terminal('close'); }
  function onError() { terminal('error'); }
  const normalPipe = gate.pipe;
  gate.pipe = function (dest, options) {
    if (destination || dest.writableFinished || dest.destroyed || dest.closed) {
      gate.destroy(new Error('Export gate destination is not a fresh response'));
      return dest;
    }
    destination = dest;
    dest.once('finish', onFinish); dest.once('close', onClose); dest.once('error', onError);
    state.destinationAttached = true;
    persist();
    return normalPipe.call(this, dest, options);
  };
  const checkControl = () => {
    if (stopped || state.terminal) return;
    if (fs.existsSync(file('cancel'))) {
      state.failure = 'export gate cancelled'; persist();
      gate.destroy(new Error('Export gate cancelled'));
      return;
    }
    if (!fs.existsSync(file('release')) || !callback) return;
    stopWatcher();
    const pending = callback, remaining = suffix;
    callback = null; suffix = null;
    state.released = true; state.heldCallback = false;
    if (!persist()) { pending(new Error('Export gate release recording failed')); return; }
    pending(null, remaining);
  };
  try {
    watcher = fs.watch(control, checkControl);
    watcher.on('error', e => gate.destroy(e));
  } catch (e) {
    queueMicrotask(() => gate.destroy(e));
    return gate;
  }
  // A control may have been written before the watcher was attached.
  queueMicrotask(checkControl);
  source.pipe(gate);
  return gate;
};
