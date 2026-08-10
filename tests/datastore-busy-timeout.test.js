// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/datastore-busy-timeout.test.js
//
// Opening the datastore while another process is writing must wait, not fail.
//
// SQLite's default busy timeout is 0, so a connection that finds the write lock
// held throws SQLITE_BUSY ("database is locked") immediately. Switching a
// database into WAL takes that lock, so the very first statement of a fresh
// open() is the one that collides.
//
// This is not only a test-flake concern. scripts/export-embed.js is designed to
// run against a live instance (that is how a Cloud export reads a running
// container), so the same collision turns a customer's export into a support
// ticket rather than a red CI run.
//
// The contention has to be across PROCESSES to be meaningful. An in-process
// attempt cannot demonstrate anything: the holder's release timer cannot fire
// while the same thread is blocked inside a synchronous exec(), so it fails with
// or without the timeout. That false negative is why this file spawns children.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let sqliteAvailable = true;
try { require('node:sqlite'); } catch { sqliteAvailable = false; }
const skip = sqliteAvailable ? false : 'node:sqlite unavailable on this Node';

const DATASTORE = path.join(__dirname, '..', 'lib', 'datastore');

// Hold the write lock on `file` in a separate process for `holdMs`, then commit.
// Resolves once the lock is definitely held.
function holdWriteLock(file, holdMs) {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('CREATE TABLE IF NOT EXISTS lockprobe (x)');
    db.exec('BEGIN EXCLUSIVE');
    db.exec("INSERT INTO lockprobe VALUES ('x')");
    console.log('LOCKED');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${holdMs});
  `;
  const proc = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('lock holder never reported LOCKED')), 20000);
    proc.stdout.on('data', c => {
      out += c;
      if (out.includes('LOCKED')) { clearTimeout(timer); resolve(proc); }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      if (!out.includes('LOCKED')) reject(new Error(`lock holder exited ${code}`));
    });
  });
}

// Open the datastore in a fresh process, so it competes for the lock for real.
// Returns { ok, errcode, ms }.
function openInChild(file) {
  const script = `
    const t0 = Date.now();
    try {
      const store = require(${JSON.stringify(DATASTORE)}).open(process.argv[1]);
      store.load();
      store.close();
      console.log('RESULT ok ' + (Date.now() - t0));
    } catch (e) {
      console.log('RESULT fail ' + (Date.now() - t0) + ' ' + (e.errcode === undefined ? '?' : e.errcode));
    }
  `;
  const r = spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8', timeout: 60000 });
  const m = /RESULT (ok|fail) (\d+)(?: (\S+))?/.exec(r.stdout || '');
  if (!m) return { ok: false, errcode: null, ms: -1, raw: `${r.stdout || ''}${r.stderr || ''}` };
  return { ok: m[1] === 'ok', ms: Number(m[2]), errcode: m[3] || null };
}

describe('datastore open() waits for a busy database', { skip }, () => {
  test('an open that collides with another process\'s write succeeds', async () => {
    // A fresh (non-WAL) file, because the WAL switch is the statement that needs
    // the write lock. On an already-WAL database the same pragma is a no-op read
    // and cannot collide, so seeding one would test nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-busy-'));
    const file = path.join(dir, 'klebb.db');
    let holder;
    try {
      holder = await holdWriteLock(file, 600);
      const result = openInChild(file);

      assert.ok(result.ok,
        `open() failed against a busy database (errcode ${result.errcode}, `
        + `after ${result.ms}ms): SQLITE_BUSY is not being waited out. ${result.raw || ''}`);
      // It really did wait rather than winning a race: the holder keeps the lock
      // for 600ms, so a success under ~100ms would mean the collision never
      // happened and this test proves nothing.
      assert.ok(result.ms >= 100,
        `open() returned in ${result.ms}ms, so it never actually contended; `
        + 'the fixture is not reproducing the collision');
    } finally {
      if (holder) { try { holder.kill(); } catch {} }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the pragma is set before journal_mode, which is what fails', () => {
    // Order matters and is easy to lose in a tidy-up: setting busy_timeout after
    // journal_mode leaves the one statement that actually collides unprotected.
    const src = fs.readFileSync(path.join(DATASTORE, 'index.js'), 'utf8');
    const busy = src.indexOf('busy_timeout');
    const journal = src.indexOf('journal_mode=WAL');
    assert.ok(busy > 0, 'busy_timeout is not set at all');
    assert.ok(busy < journal,
      'busy_timeout is set AFTER journal_mode, so the statement that collides '
      + 'is still unprotected');
  });

  test('the HAE sample store carries the same protection', () => {
    // Both modules open the same file with their own handle, so a timeout on one
    // and not the other leaves half the surface exposed.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'health-auto-export', 'samples.js'), 'utf8');
    assert.match(src, /busy_timeout/,
      'the sample store opens the same database without a busy timeout');
  });
});
