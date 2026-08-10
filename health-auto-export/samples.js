// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/samples.js
//
// Durable, deduplicated store for every sample an HAE push carries, in the
// instance datastore (`node:sqlite`, no new deps). Replaces the raw-file
// archive at data/auto-export/raw/, which grew to 404 MB across 482 files on
// a real instance for 2.5 months of data because HAE re-sends a rolling
// window and every push was archived whole: 85% of the samples on disk were
// byte-identical re-sends.
//
//   samples.recordPush(payload, { receivedAt })   // ingest, INSERT OR IGNORE
//   samples.forMetric('step_count')               // replay source
//   samples.pushCount() / samples.metricSummary()
//   samples.close()                               // checkpoints the WAL
//
// EVERY metric is stored, catalogued or not. 19 of the 25 metrics a real
// iPhone pushes have no catalogue entry and no card, and this table is their
// only home; docs/HEALTH-AUTO-EXPORT.md promises they survive for later
// backfill, so a catalogued-only store would hit the size target by deleting
// exactly the data the promise is about.
//
// Three columns exist purely to make replay from this table byte-identical to
// replay from the file archive. They look like over-modelling until you try to
// remove one:
//
//   last_push  The push that most recently carried this sample. HAE re-sends
//              running totals, so for a `sum-per-date` metric the correct
//              value for a date is the sum from the LAST push that mentioned
//              it, not the sum of every push. Aggregating a flat bag of
//              deduplicated samples resurrects #168 (5x step counts): content
//              dedupe does not collapse `{date:D, qty:1000}` and
//              `{date:D, qty:2000}`, so both would be summed.
//   push_ord   Position within that push. `last-per-date` means "the last
//              matching entry in payload order wins", so for sleep, resting
//              heart rate and body mass the intra-push order decides the
//              stored value.
//   dup_count  How many times the sample appeared in that push. A payload
//              carrying one sample twice sums it twice under `sum-per-date`;
//              collapsing the pair on content would silently change a total.
//
// The dedupe key is the FULL canonical sample content, not a
// `metric|date|source` composite. Apple Health emits multiple distinct
// samples at the same minute from the same source, so a composite key drops
// real data; and the same sample arrives with different JSON key order
// between pushes, so the content has to be canonicalised before hashing
// (measured: 68% false-conflict rate on raw strings, 0 once canonicalised).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PATHS = require('../config/paths');
const { toDate } = require('./helpers');

// 128 bits of SHA-256. At the observed scale (~330k unique samples) collision
// probability is ~1e-28; the other 16 bytes would cost 5 MB to buy nothing.
const HASH_BYTES = 16;

// Recursive canonical JSON: object keys sorted at every depth, so a re-sent
// sample hashes to the same value regardless of the order HAE serialised it
// in. Numbers go through JSON.stringify, which round-trips an IEEE-754 double
// exactly (62.00000000000001 stays 62.00000000000001), so stored qty values
// keep full precision.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    if (value[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonical(value[k])}`);
  }
  return `{${parts.join(',')}}`;
}

// The metric name and the wrapper metadata are part of the key, not just the
// sample: `{date, qty}` is the shape of nearly every metric, so step_count and
// mindful_minutes can carry byte-identical samples that must not collapse; and
// a `units` change on the wrapper has to produce new rows rather than silently
// reinterpret the old ones.
//
// The three parts are hashed as a JSON array so the encoding is injective: a
// delimiter-joined string can be forged by a metric name containing the
// delimiter, and `JSON.stringify` escapes its own quotes.
function sampleHash(metric, metricMeta, doc) {
  const input = `[${JSON.stringify(metric)},${JSON.stringify(metricMeta)},${doc}]`;
  return crypto.createHash('sha256')
    .update(input)
    .digest()
    .subarray(0, HASH_BYTES);
}

// Best-effort calendar date, for the metric-summary diagnostic and for
// ordering. Never used to decide what replay aggregates: that runs the
// catalogue's own row() so a catalogue change can't be silently overridden by
// a date guessed at write time.
function guessDate(sample) {
  if (!sample || typeof sample !== 'object') return null;
  return toDate(sample.date) || toDate(sample.start)
    || toDate(sample.sleepStart) || toDate(sample.startDate) || null;
}

// Walk a payload as { metric, metricMeta, sample } in payload order.
//
// A generator, not an array: recordPush consumes it one sample at a time so a
// push with a million samples does not materialise a million-entry array on top
// of the parsed payload. Payload order is preserved because `push_ord` depends
// on it (last-per-date metrics resolve by position within the push).
//
// `data.metrics[]` entries look like { name, units, data: [...] }. Everything
// on the wrapper except `name` and `data` is kept as `metricMeta` and hashed
// in: for an uncatalogued metric, `units` is the difference between a right
// and a wrong number when someone backfills it later, and a units change
// between pushes has to produce a new row rather than silently reinterpret
// the old ones.
function* flatten(payload) {
  const data = payload?.data || payload || {};

  if (Array.isArray(data.metrics)) {
    for (const m of data.metrics) {
      if (!m || typeof m !== 'object' || typeof m.name !== 'string') continue;
      if (!Array.isArray(m.data)) continue;
      const wrapper = {};
      for (const k of Object.keys(m)) {
        if (k === 'name' || k === 'data') continue;
        wrapper[k] = m[k];
      }
      const metricMeta = Object.keys(wrapper).length ? canonical(wrapper) : null;
      for (const sample of m.data) {
        yield { metric: m.name, metricMeta, sample };
      }
    }
  }

  // Workouts arrive under their own key, not as a named metric. The pseudo-name
  // `workouts` matches the catalogue key and metricsPresent(), so the metric
  // namespace stays consistent across ingest, replay and discovery.
  if (Array.isArray(data.workouts)) {
    for (const sample of data.workouts) {
      yield { metric: 'workouts', metricMeta: null, sample };
    }
  }
}

let _db = null;
let _stmts = null;
let _file = null;

function _open(dbFile) {
  if (_db && (!dbFile || dbFile === _file)) return _db;
  if (_db) close();
  const { DatabaseSync } = require('node:sqlite');
  const target = dbFile || PATHS.DB_FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  // A second handle on the same file: the card datastore holds the other one.
  // Both are synchronous and in one thread, so they cannot actually interleave;
  // the timeout is for an out-of-process writer (the migration or export
  // script running against a live instance).
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS hae_pushes (
      push_seq    INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      source_file TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS hae_samples (
      hash        BLOB PRIMARY KEY,
      metric      TEXT NOT NULL,
      metric_meta TEXT,
      sample_date TEXT,
      doc         TEXT NOT NULL,
      dup_count   INTEGER NOT NULL,
      push_ord    INTEGER NOT NULL,
      first_push  INTEGER NOT NULL,
      last_push   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hae_samples_metric
      ON hae_samples (metric, sample_date);
  `);

  _db = db;
  _file = target;
  _stmts = {
    insertPush: db.prepare(
      'INSERT INTO hae_pushes (received_at, source_file) VALUES (?, ?)'),
    pushBySource: db.prepare(
      'SELECT push_seq FROM hae_pushes WHERE source_file = ?'),
    countPushes: db.prepare('SELECT COUNT(*) AS n FROM hae_pushes'),
    // Intra-push repeats are collapsed HERE rather than in a Map built ahead of
    // the transaction, so a push is streamed sample by sample and peak memory
    // does not scale with the sample count. See recordPush.
    //
    // The `last_push = excluded.last_push` test is what keeps `dup_count`
    // meaning "times this sample appeared in the MOST RECENT push":
    //   same push  -> a genuine intra-push repeat, so increment
    //   older push -> a re-send, so reset to 1 and take the new position
    // Getting this backwards would either double-count a re-sent sample forever
    // or lose an intra-push repeat, and both silently change a sum-per-date
    // total on replay.
    upsertSample: db.prepare(
      'INSERT INTO hae_samples '
      + '(hash, metric, metric_meta, sample_date, doc, dup_count, push_ord, first_push, last_push) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(hash) DO UPDATE SET '
      + 'dup_count = CASE WHEN hae_samples.last_push = excluded.last_push '
      + 'THEN hae_samples.dup_count + 1 ELSE 1 END, '
      + 'push_ord = CASE WHEN hae_samples.last_push = excluded.last_push '
      + 'THEN hae_samples.push_ord ELSE excluded.push_ord END, '
      + 'last_push = excluded.last_push'),
    forMetric: db.prepare(
      'SELECT doc, metric_meta, dup_count, push_ord, last_push FROM hae_samples '
      + 'WHERE metric = ? ORDER BY last_push, push_ord'),
    summary: db.prepare(
      'SELECT metric, COUNT(*) AS samples, MIN(sample_date) AS firstDate, '
      + 'MAX(sample_date) AS lastDate, MAX(last_push) AS lastPush '
      + 'FROM hae_samples GROUP BY metric ORDER BY metric'),
    countSamples: db.prepare('SELECT COUNT(*) AS n FROM hae_samples'),
    countFirstPush: db.prepare(
      'SELECT COUNT(*) AS n FROM hae_samples WHERE first_push = ?'),
    exportRows: db.prepare(
      'SELECT s.metric, s.metric_meta, s.doc, s.dup_count, s.last_push, p.received_at '
      + 'FROM hae_samples s JOIN hae_pushes p ON p.push_seq = s.last_push '
      + 'ORDER BY s.last_push, s.push_ord'),
  };
  return _db;
}

// Record one push. Returns { pushSeq, seen, inserted, skipped }.
//
//   seen      samples in the payload (including intra-push repeats)
//   inserted  rows the table did not already hold
//   skipped   true when sourceFile was already imported (migration re-run)
//
// One transaction: a push either lands whole or not at all, so a crash
// mid-write cannot leave a half-recorded push that later reads as the most
// recent carrier of a date.
function recordPush(payload, opts = {}) {
  const { receivedAt = new Date().toISOString(), sourceFile = null, dbFile = null } = opts;
  const db = _open(dbFile);

  if (sourceFile) {
    const already = _stmts.pushBySource.get(sourceFile);
    if (already) {
      return { pushSeq: Number(already.push_seq), seen: 0, inserted: 0, skipped: true };
    }
  }

  // Streamed one sample at a time, deliberately: nothing here holds a
  // per-sample structure for the whole payload.
  //
  // This used to build a flat array of every sample and then a Map keyed by
  // hash, both live at once alongside the request body string and the parsed
  // object. The cost was per SAMPLE, not per byte, so the 100 MB body cap did
  // not bound it: a 6.6 MB body of a million bare numbers exhausted a 256 MB
  // heap, and 2.6 MB exhausted 128 MB, while a 6.2 MB body holding ONE large
  // sample was fine. Verified both ways, and verified that the pre-samples-table
  // code survived the same input, so this was a regression rather than an
  // inherited limit. A crash here is a restart loop, because the phone retries.
  //
  // Intra-push repeats now collapse in the upsert (see the statement), which is
  // what the Map was for.
  db.exec('BEGIN');
  let pushSeq;
  let inserted = 0;
  let seen = 0;
  try {
    const res = _stmts.insertPush.run(receivedAt, sourceFile);
    pushSeq = Number(res.lastInsertRowid);
    for (const { metric, metricMeta, sample } of flatten(payload)) {
      const doc = canonical(sample);
      _stmts.upsertSample.run(
        sampleHash(metric, metricMeta, doc), metric, metricMeta,
        guessDate(sample), doc, 1, seen, pushSeq, pushSeq);
      seen += 1;
    }
    // `changes` is 1 for both a fresh insert and a conflicting update, so
    // novelty is counted by asking which rows recorded THIS push as their
    // first sighting. Inside the transaction, so it cannot see another writer.
    inserted = _stmts.countFirstPush.get(pushSeq).n;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { pushSeq, seen, inserted, skipped: false };
}

// Every stored sample for one metric, in the order replay must consume them:
// by push, then by position within that push.
function forMetric(metric, opts = {}) {
  _open(opts.dbFile || null);
  return _stmts.forMetric.all(String(metric));
}

function pushCount(opts = {}) {
  _open(opts.dbFile || null);
  return _stmts.countPushes.get().n;
}

function sampleCount(opts = {}) {
  _open(opts.dbFile || null);
  return _stmts.countSamples.get().n;
}

// Per-metric coverage. Feeds the migration/verification output today; the
// hidden-metrics panel can use it to show span and sample count per metric.
function metricSummary(opts = {}) {
  _open(opts.dbFile || null);
  return _stmts.summary.all();
}

// Rebuild the stored history as a list of HAE-shaped payloads, one per push,
// each carrying that push's deduplicated samples.
//
// This is the portable form. The table lives in klebb.db, and the export path
// deliberately never copies db/ (a live WAL copy can be torn, and the staged
// tree is handed to a customer, so credentials and sessions must not be in it).
// Emitting payloads instead means the export carries HAE history in the same
// shape the endpoint accepts, and importing is the ordinary ingest path rather
// than a second write path with its own bugs.
//
// Round-trips exactly: recordPush() assigns push numbers in call order, and a
// push that carried no samples contributes nothing to replay, so re-importing
// this list reproduces the same grouping. `dup_count` is expanded back into
// repeated entries and `metric_meta` back onto the metric wrapper, so what
// comes out is what went in.
function exportPushes(opts = {}) {
  _open(opts.dbFile || null);
  const rows = _stmts.exportRows.all();

  const byPush = new Map();
  for (const row of rows) {
    let push = byPush.get(row.last_push);
    if (!push) {
      push = { receivedAt: row.received_at, metrics: new Map(), workouts: [] };
      byPush.set(row.last_push, push);
    }
    const sample = JSON.parse(row.doc);
    const copies = Math.max(1, Number(row.dup_count) || 1);
    if (row.metric === 'workouts') {
      for (let i = 0; i < copies; i++) push.workouts.push(sample);
      continue;
    }
    const key = `${row.metric}␟${row.metric_meta || ''}`;
    let stream = push.metrics.get(key);
    if (!stream) {
      const wrapper = row.metric_meta ? JSON.parse(row.metric_meta) : {};
      stream = { name: row.metric, ...wrapper, data: [] };
      push.metrics.set(key, stream);
    }
    for (let i = 0; i < copies; i++) stream.data.push(sample);
  }

  const out = [];
  for (const [, push] of [...byPush.entries()].sort((a, b) => a[0] - b[0])) {
    const data = {};
    const metrics = [...push.metrics.values()];
    if (metrics.length) data.metrics = metrics;
    if (push.workouts.length) data.workouts = push.workouts;
    out.push({ receivedAt: push.receivedAt, payload: { data } });
  }
  return out;
}

// Import the list exportPushes() produces, in order, through the ordinary
// ingest path. Returns { pushes, inserted }.
function importPushes(list, opts = {}) {
  let pushes = 0;
  let inserted = 0;
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.payload) continue;
    const r = recordPush(item.payload, {
      receivedAt: item.receivedAt || new Date().toISOString(),
      dbFile: opts.dbFile || null,
    });
    pushes += 1;
    inserted += r.inserted;
  }
  return { pushes, inserted };
}

// Closing checkpoints the WAL into the main database file, so a copy of
// klebb.db alone is complete. Safe to call having never opened.
function close() {
  if (!_db) return false;
  try {
    _db.close();
  } catch (e) {
    console.warn('[hae] samples close failed:', e.message);
    return false;
  }
  _db = null;
  _stmts = null;
  _file = null;
  return true;
}

module.exports = {
  recordPush, forMetric, pushCount, sampleCount, metricSummary, close,
  exportPushes, importPushes,
  // Exported for tests and for the migration's own hashing.
  canonical, sampleHash, flatten, guessDate,
};
