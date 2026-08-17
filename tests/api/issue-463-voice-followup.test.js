// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-463-voice-followup.test.js
// Regression for #463: embellishment chips never rendered for recorded-voice
// turns. The server attaches `followup` to every /api/chat reply shape
// (including voice mode), and the typed-send path (_sendText) rides it onto
// the assistant message, but the recorded-voice path (_handleRecordedBlob)
// built its message with only { speakText }, silently dropping the chips.
//
// Pins both send paths to a single shared unpack helper so they cannot
// drift apart again. Source-level wiring assertion, same pattern as
// tests/welcome-empty-state.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'components', 'health-chat.js'),
  'utf8'
);

function methodBody(name) {
  const start = SRC.indexOf(name);
  assert.notStrictEqual(start, -1, `${name} not found in health-chat.js`);
  // Slice to the next method at the same indentation level. Coarse but
  // stable: bodies here are short and the next definition anchors the end.
  const rest = SRC.slice(start);
  const end = rest.search(/\n  (?:async )?_?[a-zA-Z]+\(/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('#463: both send paths ride followup chips onto the message', () => {
  test('a shared followup-unpack helper exists', () => {
    assert.match(SRC, /_followupExtras\(data\)/);
  });

  // The #605 rework strengthened the original fix: both paths now funnel
  // through one turn runner, and only its outcome handler unpacks the
  // followup, so the two paths cannot drift apart by construction.
  test('typed send path (_sendText) funnels through the shared turn runner', () => {
    assert.match(methodBody('async _sendText()'), /_runTurn\(/);
  });

  test('recorded-voice path (_handleRecordedBlob) funnels through the shared turn runner', () => {
    assert.match(methodBody('async _handleRecordedBlob(blob)'), /_runTurn\(/);
  });

  test('the shared outcome handler is what unpacks the followup', () => {
    assert.match(methodBody('async _applyTurnOutcome(useVoice)'), /_followupExtras\(/);
  });
});
