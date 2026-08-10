// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/helpers/hae-samples-readback.js
// Read the HAE sample store of a sandbox instance from outside the server
// process. WAL lets this see committed rows while the server under test still
// holds its own handle, so a suite can assert what is DURABLE rather than what
// an endpoint reported.
//
// Deliberately hand-rolled SQL rather than a call into
// health-auto-export/samples.js: this is the readback oracle for that module,
// and sharing its code would let a bug in it hide behind itself.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function dbPath(sandboxRoot) {
  return path.join(sandboxRoot, 'db', 'klebb.db');
}

// Every stored sample, newest push last. Shape:
//   [{ metric, metricMeta, dupCount, pushSeq, sample }]
function readSamples(sandboxRoot, metric = null) {
  const db = new DatabaseSync(dbPath(sandboxRoot), { readOnly: true });
  try {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='hae_samples'").all();
    if (names.length === 0) return [];
    const sql = 'SELECT metric, metric_meta, doc, dup_count, last_push FROM hae_samples'
      + (metric ? ' WHERE metric = ?' : '')
      + ' ORDER BY last_push, push_ord';
    const stmt = db.prepare(sql);
    const rows = metric ? stmt.all(String(metric)) : stmt.all();
    return rows.map(r => ({
      metric: r.metric,
      metricMeta: r.metric_meta ? JSON.parse(r.metric_meta) : null,
      dupCount: r.dup_count,
      pushSeq: r.last_push,
      sample: JSON.parse(r.doc),
    }));
  } finally {
    db.close();
  }
}

function readPushCount(sandboxRoot) {
  const db = new DatabaseSync(dbPath(sandboxRoot), { readOnly: true });
  try {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='hae_pushes'").all();
    if (names.length === 0) return 0;
    return db.prepare('SELECT COUNT(*) AS n FROM hae_pushes').get().n;
  } finally {
    db.close();
  }
}

module.exports = { readSamples, readPushCount };
