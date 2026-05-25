// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/voice-sanitise-for-tts.test.js
// Markdown and URL stripping for text on its way to Fish Audio TTS.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { sanitiseForTts } = require('../voice/sanitise-for-tts');

describe('sanitiseForTts', () => {
  test('strips bold (**)', () => {
    assert.equal(sanitiseForTts('hello **world** there'), 'hello world there');
  });

  test('strips italic (*)', () => {
    assert.equal(sanitiseForTts('hello *world* there'), 'hello world there');
  });

  test('strips bold-italic (***)', () => {
    assert.equal(sanitiseForTts('hello ***world*** there'), 'hello world there');
  });

  test('strips bold (__)', () => {
    assert.equal(sanitiseForTts('hello __world__ there'), 'hello world there');
  });

  test('strips italic (_) but leaves snake_case alone', () => {
    assert.equal(sanitiseForTts('hello _world_ there'), 'hello world there');
    assert.equal(sanitiseForTts('snake_case_var'), 'snake_case_var');
  });

  test('strips strikethrough (~~)', () => {
    assert.equal(sanitiseForTts('hello ~~world~~ there'), 'hello world there');
  });

  test('strips inline code backticks', () => {
    assert.equal(sanitiseForTts('use `git commit` here'), 'use git commit here');
  });

  test('strips fenced code blocks but keeps contents', () => {
    const input = 'before\n```js\nconst x = 1;\n```\nafter';
    assert.equal(sanitiseForTts(input), 'before const x = 1; after');
  });

  test('markdown link: keeps label, drops URL', () => {
    assert.equal(
      sanitiseForTts('see [the docs](https://example.com/docs) for more'),
      'see the docs for more'
    );
  });

  test('bare URL: dropped', () => {
    assert.equal(
      sanitiseForTts('visit https://example.com today'),
      'visit today'
    );
  });

  test('bare square brackets: drop brackets, keep contents', () => {
    assert.equal(sanitiseForTts('and [aside] then more'), 'and aside then more');
  });

  test('curly braces: drop braces, keep contents', () => {
    assert.equal(sanitiseForTts('value is {42}'), 'value is 42');
  });

  test('strips heading markers', () => {
    assert.equal(sanitiseForTts('# Heading\nbody'), 'Heading body');
    assert.equal(sanitiseForTts('### Subheading\nbody'), 'Subheading body');
  });

  test('strips bullet markers', () => {
    const input = '- one\n- two\n* three\n+ four';
    assert.equal(sanitiseForTts(input), 'one two three four');
  });

  test('strips ordered-list markers', () => {
    assert.equal(sanitiseForTts('1. first\n2. second'), 'first second');
  });

  test('strips blockquote markers', () => {
    assert.equal(sanitiseForTts('> quoted\nfollowup'), 'quoted followup');
  });

  test('keeps parentheses (read aloud naturally)', () => {
    assert.equal(
      sanitiseForTts('your weight (in kg) trended down'),
      'your weight (in kg) trended down'
    );
  });

  test('collapses whitespace runs', () => {
    assert.equal(sanitiseForTts('a   b\n\n\nc'), 'a b c');
  });

  test('the actual reported case: bold reads cleanly', () => {
    assert.equal(
      sanitiseForTts('unformatted text here **formatted text here**'),
      'unformatted text here formatted text here'
    );
  });

  test('combined markdown survives all passes', () => {
    const input = '## Summary\n\nYour **HRV** is `42ms`, see [details](https://x.com).';
    assert.equal(
      sanitiseForTts(input),
      'Summary Your HRV is 42ms, see details.'
    );
  });

  test('non-string input returns empty string', () => {
    assert.equal(sanitiseForTts(null), '');
    assert.equal(sanitiseForTts(undefined), '');
    assert.equal(sanitiseForTts(42), '');
  });

  test('empty string returns empty string', () => {
    assert.equal(sanitiseForTts(''), '');
    assert.equal(sanitiseForTts('   \n  '), '');
  });
});
