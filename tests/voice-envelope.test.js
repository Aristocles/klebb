// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/voice-envelope.test.js
// Unwrapping the voice-mode { speak, display } envelope from model text.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { extractJsonReply } = require('../chat/voice-envelope');

describe('extractJsonReply', () => {
  test('unwraps a clean envelope', () => {
    assert.deepEqual(
      extractJsonReply('{"speak":"Created it.","display":"Created **E**."}'),
      { speak: 'Created it.', display: 'Created **E**.' },
    );
  });

  test('keeps raw newlines inside display as line breaks (#741)', () => {
    const raw = '{\n  "speak": "Too high.",\n  "display": "**6 mg is high.**\n\nTypical:\n- 200 mcg"\n}';
    assert.deepEqual(extractJsonReply(raw), {
      speak: 'Too high.',
      display: '**6 mg is high.**\n\nTypical:\n- 200 mcg',
    });
  });

  test('keeps raw carriage returns, tabs and other control characters', () => {
    const raw = '{"speak":"ok","display":"a\r\nb\tc\u0007d"}';
    assert.equal(extractJsonReply(raw).display, 'a\r\nb\tc\u0007d');
  });

  test('leaves already-escaped newlines and quotes alone', () => {
    const raw = '{"speak":"say \\"hi\\"","display":"line 1\\nline 2 \\\\"}';
    assert.deepEqual(extractJsonReply(raw), { speak: 'say "hi"', display: 'line 1\nline 2 \\' });
  });

  test('unwraps a fenced envelope', () => {
    const raw = '```json\n{"speak":"Hi.","display":"Hi there."}\n```';
    assert.equal(extractJsonReply(raw).speak, 'Hi.');
  });

  test('finds the envelope after tool-use preamble, last one wins', () => {
    const raw = 'Checking. {"speak":"draft"} Done:\n{"speak":"Final.","display":"Final."}';
    assert.equal(extractJsonReply(raw).speak, 'Final.');
  });

  test('a brace inside a string does not break extraction among other text', () => {
    const raw = 'Here you go: {"speak":"Use the name field.","display":"Use `}` then {name"} thanks';
    assert.deepEqual(extractJsonReply(raw), {
      speak: 'Use the name field.',
      display: 'Use `}` then {name',
    });
  });

  test('accepts an envelope carrying only one of the two fields', () => {
    assert.deepEqual(extractJsonReply('{"display":"Only display."}'), { display: 'Only display.' });
  });

  test('returns null for prose, non-envelope JSON and non-strings', () => {
    assert.equal(extractJsonReply('You have three cards.\nAsk me for details.'), null);
    assert.equal(extractJsonReply('{"answer":"nope"}'), null);
    assert.equal(extractJsonReply(''), null);
    assert.equal(extractJsonReply(undefined), null);
  });

  test('returns null for an unterminated envelope (handled by #709, not here)', () => {
    assert.equal(extractJsonReply('{"speak":"You have three cards and the sleep one is'), null);
  });
});
