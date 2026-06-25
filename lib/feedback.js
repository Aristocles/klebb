// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/feedback.js
// Append-only, anonymised feature-request log. When Klebbius decides a user
// request is genuinely unsupported, it records the unmet intent here so the
// operator can later review what users actually want. No external calls, no
// PII: only a paraphrased capability intent + structural context + a
// timestamp. One JSON object per line (JSONL), reusing the recordAuthEvent
// append style.

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
  const line = { ts: now, intent };
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

module.exports = { anonymise, appendFeedback, FEEDBACK_FILE };
