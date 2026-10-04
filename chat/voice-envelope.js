// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/voice-envelope.js
// Unwraps the voice-mode { speak, display } envelope from a model's final
// text. The model is told to emit pure JSON, but stray text, fences and
// tool-use preamble happen, so the LAST envelope-shaped object wins (that
// one is always the final answer).
//
// Models also write a multi-line display with literal newlines instead of
// \n escapes, which JSON.parse rejects (#741). The scan escapes control
// characters inside string literals as it goes, and only counts braces
// outside them, so neither slip costs the user the envelope.

'use strict';

const CONTROL_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function escapeControl(c) {
  return CONTROL_ESCAPES[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

function objectCandidates(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inString = false;
  let escaped = false;
  for (const c of s) {
    if (depth === 0) {
      if (c === '{') { depth = 1; cur = c; }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      cur += c < ' ' ? escapeControl(c) : c;
      continue;
    }
    cur += c;
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) out.push(cur);
  }
  return out;
}

function extractJsonReply(raw) {
  if (typeof raw !== 'string') return null;
  const candidates = objectCandidates(raw);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (typeof obj.speak === 'string' || typeof obj.display === 'string') return obj;
    } catch {}
  }
  return null;
}

module.exports = { extractJsonReply };
