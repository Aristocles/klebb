// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/datastore/index.js
// Embedded per-instance store for card data rows: memory-first, SQLite-durable.
//
// The in-memory Map holds each card's live data value with the same
// reference-aliasing semantics the registry cache has today: getData()
// returns the exact object setData() stored, not a clone. SQLite (via
// node:sqlite, synchronous) is the durable copy, written in one
// transaction per mutation and rebuilt into memory by load(). Write
// serialisation matches today's writeFileSync: no new interleaving.
//
//   const store = require('./lib/datastore').open();
//   store.load();
//   store.getData(id) / setData(id, value) / deleteCard(id)
//   store.hasData(id) / dataUpdatedAt(id) / close()
//
// Rows persist decomposed per lib/datastore/shape.js. Container names are
// stored with a 'c:' prefix; the unprefixed '__rest__' and '__doc__' names
// are reserved storage channels for the rest document and doc value, so a
// user data key literally named '__rest__' can never collide with them.

'use strict';

const fs = require('fs');
const path = require('path');
const PATHS = require('../../config/paths');
const { decompose, reconstruct, rowDate } = require('./shape');

const SCHEMA_VERSION = 1;

const REST_CONTAINER = '__rest__';
const DOC_CONTAINER = '__doc__';
const CONTAINER_PREFIX = 'c:';

function setKey(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value, writable: true, enumerable: true, configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

function open(dbFile = PATHS.DB_FILE) {
  // Lazy require: nothing imports this module on Node < 22.13 until the
  // engines floor lands, and a top-level require would crash older runtimes
  // that merely load the file.
  const { DatabaseSync } = require('node:sqlite');

  fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      card_id TEXT PRIMARY KEY,
      shape TEXT NOT NULL,
      data_updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rows (
      card_id TEXT NOT NULL,
      container TEXT NOT NULL,
      seq INTEGER NOT NULL,
      row_id TEXT NOT NULL,
      doc TEXT NOT NULL,
      date TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (card_id, container, row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rows_card_date ON rows (card_id, date);
  `);
  const versionRow = db.prepare('SELECT version FROM schema_version').get();
  if (!versionRow) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }

  const stmts = {
    deleteRows: db.prepare('DELETE FROM rows WHERE card_id = ?'),
    deleteCard: db.prepare('DELETE FROM cards WHERE card_id = ?'),
    insertRow: db.prepare(
      'INSERT INTO rows (card_id, container, seq, row_id, doc, date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    upsertCard: db.prepare(
      'INSERT INTO cards (card_id, shape, data_updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(card_id) DO UPDATE SET shape = excluded.shape, data_updated_at = excluded.data_updated_at',
    ),
    selectCards: db.prepare('SELECT card_id, shape, data_updated_at FROM cards'),
    selectRows: db.prepare('SELECT container, seq, doc FROM rows WHERE card_id = ? ORDER BY container, seq'),
  };

  const _values = new Map();      // id -> live data value (null allowed)
  const _updatedAt = new Map();   // id -> ISO string

  function load() {
    _values.clear();
    _updatedAt.clear();
    for (const card of stmts.selectCards.all()) {
      const shape = JSON.parse(card.shape);
      const containers = {};
      let rest = null;
      for (const row of stmts.selectRows.all(card.card_id)) {
        const doc = JSON.parse(row.doc);
        if (row.container === REST_CONTAINER) {
          rest = doc;
        } else if (row.container === DOC_CONTAINER) {
          setKey(containers, DOC_CONTAINER, [doc]);
        } else {
          const name = row.container.slice(CONTAINER_PREFIX.length);
          if (!Object.prototype.hasOwnProperty.call(containers, name)) setKey(containers, name, []);
          containers[name].push(doc);
        }
      }
      _values.set(card.card_id, reconstruct({ shape, containers, rest }));
      _updatedAt.set(card.card_id, card.data_updated_at);
    }
    return { count: _values.size };
  }

  // Full replace: decompose the value, then one transaction that deletes the
  // card's rows and re-inserts. Memory is only swapped after COMMIT, so a
  // throw anywhere (including an unserialisable row) leaves both the DB and
  // the served value at the prior state.
  function setData(id, value) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('setData: id must be a non-empty string');
    }
    const { shape, containers, rest } = decompose(value);
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      stmts.deleteRows.run(id);
      for (const name of Object.keys(containers)) {
        // Only the doc shape may use the reserved unprefixed channel; a user
        // object key literally named '__doc__' stores as 'c:__doc__'.
        const storedName = shape.kind === 'doc' && name === DOC_CONTAINER
          ? DOC_CONTAINER
          : CONTAINER_PREFIX + name;
        const rows = containers[name];
        for (let seq = 0; seq < rows.length; seq++) {
          const row = rows[seq] === undefined ? null : rows[seq];
          stmts.insertRow.run(id, storedName, seq, String(seq), JSON.stringify(row), rowDate(row), now);
        }
      }
      if (rest !== null) {
        stmts.insertRow.run(id, REST_CONTAINER, 0, '0', JSON.stringify(rest), null, now);
      }
      stmts.upsertCard.run(id, JSON.stringify(shape), now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    _values.set(id, value === undefined ? null : value);
    _updatedAt.set(id, now);
    return true;
  }

  function getData(id) {
    const v = _values.get(id);
    return v === undefined ? null : v;
  }

  function hasData(id) {
    return _values.has(id) && _values.get(id) !== null;
  }

  function dataUpdatedAt(id) {
    return _updatedAt.get(id) || null;
  }

  function deleteCard(id) {
    db.exec('BEGIN');
    try {
      stmts.deleteRows.run(id);
      stmts.deleteCard.run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const known = _values.delete(id);
    _updatedAt.delete(id);
    return known;
  }

  function close() {
    db.close();
  }

  return { load, getData, setData, hasData, dataUpdatedAt, deleteCard, close, file: dbFile };
}

module.exports = { open };
