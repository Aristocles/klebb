// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/conversations.js
// Chat conversations: SQLite-durable, in the same per-instance database
// file as the card datastore but through its own handle (the HAE samples
// store established that pattern; busy_timeout lets the handles coexist).
//
// One row per conversation with the messages as a JSON document. Chat
// writes are whole-transcript replaces, matching the /api/chat/history
// semantics this supersedes, so row-per-message granularity would buy
// contention, not safety. Hard caps: 100 conversations (oldest by
// activity pruned on create), 200 messages per conversation (oldest
// dropped on write).

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES = 200;
const BUSY_TIMEOUT_MS = 5000;

// The persisted message shape, shared by the API routes and the chat loop:
// role/content plus the extras the client round-trips (chip payloads from
// #191, and hasVoice so a spoken reply keeps its player across reloads).
// Anything else the client sends is dropped, same rules as the legacy
// history endpoint.
function sanitiseMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(m => m && typeof m === 'object'
      && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string')
    .map(m => {
      const out = {
        id: typeof m.id === 'string' ? m.id : `m${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: m.role,
        content: m.content,
      };
      if (typeof m.followupText === 'string' && m.followupText) {
        out.followupText = m.followupText;
      }
      if (Array.isArray(m.embellishments) && m.embellishments.length) {
        out.embellishments = m.embellishments
          .filter(e => e && typeof e === 'object'
            && typeof e.label === 'string'
            && typeof e.prompt === 'string')
          .map(e => ({ label: e.label, prompt: e.prompt }));
        if (out.embellishments.length === 0) delete out.embellishments;
      }
      if (m.hasVoice === true) out.hasVoice = true;
      return out;
    })
    .slice(-MAX_MESSAGES);
}

function open(dbFile = PATHS.DB_FILE) {
  // Lazy require, matching lib/datastore: loading this file must not crash
  // a runtime without node:sqlite; only using it may.
  const { DatabaseSync } = require('node:sqlite');

  fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbFile);
  // Same pragma order as lib/datastore: busy_timeout FIRST, because
  // switching into WAL takes the write lock and is therefore the statement
  // that collides when another handle is mid-write.
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      messages TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at);
  `);

  const stmts = {
    insert: db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, messages) VALUES (?, ?, ?, ?, ?)'),
    list: db.prepare('SELECT id, title, created_at, updated_at, messages FROM conversations ORDER BY updated_at DESC, id DESC'),
    get: db.prepare('SELECT id, title, created_at, updated_at, messages FROM conversations WHERE id = ?'),
    setMessages: db.prepare('UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ?'),
    setTitle: db.prepare('UPDATE conversations SET title = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM conversations WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM conversations'),
    // Excludes the row being created: with same-millisecond timestamps the
    // freshly inserted conversation could otherwise be its own prune victim.
    oldest: db.prepare('SELECT id FROM conversations WHERE id != ? ORDER BY updated_at ASC, id ASC LIMIT ?'),
  };

  function rowToSummary(row) {
    let count = 0;
    try { count = JSON.parse(row.messages).length; } catch {}
    return {
      id: row.id,
      title: row.title || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: count,
    };
  }

  function list() {
    return stmts.list.all().map(rowToSummary);
  }

  function get(id) {
    const row = stmts.get.get(id);
    if (!row) return null;
    let messages = [];
    try { messages = JSON.parse(row.messages); } catch {}
    return {
      id: row.id,
      title: row.title || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages,
    };
  }

  // Create, then prune anything over the cap by least-recent activity, in
  // one transaction so a crash cannot leave 101 rows behind.
  function create({ title = null, messages = [] } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const clean = sanitiseMessages(messages);
    db.exec('BEGIN');
    try {
      stmts.insert.run(id, title, now, now, JSON.stringify(clean));
      const over = stmts.count.get().n - MAX_CONVERSATIONS;
      if (over > 0) {
        for (const row of stmts.oldest.all(id, over)) stmts.remove.run(row.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { id, title, createdAt: now, updatedAt: now, messages: clean };
  }

  function setMessages(id, messages) {
    const clean = sanitiseMessages(messages);
    const now = new Date().toISOString();
    const out = stmts.setMessages.run(JSON.stringify(clean), now, id);
    return out.changes > 0;
  }

  function appendMessages(id, messages) {
    const existing = get(id);
    if (!existing) return false;
    return setMessages(id, existing.messages.concat(Array.isArray(messages) ? messages : []));
  }

  function rename(id, title) {
    const clean = typeof title === 'string' ? title.trim().slice(0, 120) : '';
    const out = stmts.setTitle.run(clean || null, id);
    return out.changes > 0;
  }

  function remove(id) {
    return stmts.remove.run(id).changes > 0;
  }

  function close() {
    db.close();
  }

  return { list, get, create, setMessages, appendMessages, rename, remove, close, file: dbFile };
}

module.exports = { open, sanitiseMessages, MAX_CONVERSATIONS, MAX_MESSAGES };
