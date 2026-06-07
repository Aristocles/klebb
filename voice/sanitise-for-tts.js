// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// voice/sanitise-for-tts.js — strip markdown + URLs from text before TTS.
// The voice-mode chat agent is told to emit plain prose in `speak`, but the
// model occasionally leaks markdown anyway. Without this, Fish Audio reads
// the syntax aloud ("asterisk asterisk bold asterisk asterisk").

function sanitiseForTts(input) {
  if (typeof input !== 'string') return '';
  let s = input;

  // Fenced code blocks: keep contents, drop the fences and any language tag.
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');

  // Inline code: keep contents, drop the backticks.
  s = s.replace(/`([^`]+)`/g, '$1');

  // Markdown links: [label](url) -> label
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  // Bare URLs (http/https): drop entirely.
  s = s.replace(/https?:\/\/\S+/g, '');

  // Bold / italic / strikethrough — handle longest delimiters first.
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/___([^_]+)___/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1$2');
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // Bare square brackets that survived the link pass: drop brackets, keep contents.
  s = s.replace(/\[([^\]]*)\]/g, '$1');

  // Curly braces (rare in prose): drop braces, keep contents.
  s = s.replace(/\{([^}]*)\}/g, '$1');

  // Strip leading line markers: '#', '>', '-', '*', '+', and ordered-list digits.
  s = s.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '');

  // Collapse whitespace runs (multiple spaces / blank lines) into single space.
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

module.exports = { sanitiseForTts };
