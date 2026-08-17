// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/feedback.js
// Append-only, anonymised feedback log: bug reports and feature requests.
// Klebbius records an entry when a request is genuinely unsupported (kind
// "feature") or when the user reports something broken it cannot fix (kind
// "bug"); the in-app feedback form writes the same shape. No external
// calls, no PII: only a paraphrased intent + structural context + a
// timestamp. One JSON object per line (JSONL), reusing the recordAuthEvent
// append style. readFeedback() is the admin-API read side, so the log is
// collectable without shell access.

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');

// Lives in the gitignored, discovery-skipped data/_meta/ sidecar namespace,
// next to cc-suggestions-dismissed.json. Created lazily on first append.
const FEEDBACK_FILE = path.join(PATHS.DATA_DIR, '_meta', 'feedback.jsonl');

const MAX_INTENT = 280;
const MAX_CONTEXT = 500;
const MAX_TOOLS = 12;

// Build the anonymised log line from a raw {intent, context, toolsConsidered}.
// This is the load-bearing privacy boundary: nothing strips PII upstream, so
// we keep ONLY a paraphrased capability intent, the structural context, and
// the considered tool names, each length-capped. The model is instructed to
// paraphrase, but anonymise() is the backstop, never the raw user message.
// Returns null when there is no usable intent to log.
function anonymise(input, now) {
  const intent = clampString(input && input.intent, MAX_INTENT);
  if (!intent) return null;
  // Anything that is not literally 'bug' records as a feature request:
  // pre-kind entries and junk values both degrade to the historical
  // meaning of the log rather than being dropped.
  const kind = (input && input.kind) === 'bug' ? 'bug' : 'feature';
  const line = { ts: now, kind, intent };
  const context = clampString(input && input.context, MAX_CONTEXT);
  if (context) line.context = context;
  const tools = Array.isArray(input && input.toolsConsidered)
    ? input.toolsConsidered
        .filter(t => typeof t === 'string' && t)
        .map(t => t.slice(0, 64))
        .slice(0, MAX_TOOLS)
    : [];
  if (tools.length) line.toolsConsidered = tools;
  return line;
}

function clampString(v, max) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// Anonymise + append one feedback line. Returns {logged:true} on success or
// {logged:false, reason} when there was nothing usable to log. Append errors
// are swallowed (best-effort logging must never break a chat turn), matching
// recordAuthEvent.
function appendFeedback(input, nowIso) {
  const ts = nowIso || new Date().toISOString();
  const line = anonymise(input, ts);
  if (!line) return { logged: false, reason: 'no intent' };
  try {
    fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(line) + '\n');
  } catch {
    return { logged: false, reason: 'write failed' };
  }
  return { logged: true };
}

// Read the log back, newest last, optionally only entries after `since`
// (ISO string; string comparison is safe because ts is always ISO-8601
// UTC). Unparseable lines are skipped rather than failing the read: a
// torn final line from a crashed append must not make the whole log
// unreadable. Missing file = empty log.
function readFeedback({ since } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(FEEDBACK_FILE, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed.ts !== 'string' || typeof parsed.intent !== 'string') continue;
    if (since && parsed.ts <= since) continue;
    entries.push(parsed);
  }
  return entries;
}

module.exports = { anonymise, appendFeedback, readFeedback, FEEDBACK_FILE };
