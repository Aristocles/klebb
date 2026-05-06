// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/event-target.test.js
// Unit tests for public/js/lib/event-target.js — the guard that keeps the
// date-view's window-level arrow-key handler from eating caret moves in
// inputs, including inputs inside a web component's shadow root.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEditableTarget } from '../public/js/lib/event-target.js';

function fakeEvent(path) {
  return { target: path[0], composedPath: () => path };
}

test('isEditableTarget: false for a bare div target', () => {
  const div = { tagName: 'DIV' };
  assert.equal(isEditableTarget(fakeEvent([div, { tagName: 'BODY' }])), false);
});

test('isEditableTarget: true for a direct INPUT target', () => {
  const input = { tagName: 'INPUT' };
  assert.equal(isEditableTarget(fakeEvent([input, { tagName: 'BODY' }])), true);
});

test('isEditableTarget: true for a direct TEXTAREA target', () => {
  const textarea = { tagName: 'TEXTAREA' };
  assert.equal(isEditableTarget(fakeEvent([textarea])), true);
});

test('isEditableTarget: true for a direct SELECT target', () => {
  const select = { tagName: 'SELECT' };
  assert.equal(isEditableTarget(fakeEvent([select])), true);
});

test('isEditableTarget: true for an isContentEditable element', () => {
  const div = { tagName: 'DIV', isContentEditable: true };
  assert.equal(isEditableTarget(fakeEvent([div])), true);
});

// The bug this helper fixes: a keydown fires in a textarea inside a
// shadow root (like the chat widget's .chat-input). By the time a
// window-level listener sees it, e.target has been retargeted to the
// shadow host — so the old `e.target.tagName === 'TEXTAREA'` check
// missed. composedPath() still holds the real textarea, so the walk
// catches it.
test('isEditableTarget: true for a shadow-DOM TEXTAREA (host as e.target)', () => {
  const textarea = { tagName: 'TEXTAREA' };
  const shadowHost = { tagName: 'HEALTH-CHAT' };
  // composedPath order: deepest → outermost. target is the retargeted host.
  const e = {
    target: shadowHost,
    composedPath: () => [textarea, shadowHost, { tagName: 'BODY' }],
  };
  assert.equal(isEditableTarget(e), true);
});

test('isEditableTarget: falls back to [e.target] when composedPath is missing', () => {
  const input = { tagName: 'INPUT' };
  const e = { target: input };
  assert.equal(isEditableTarget(e), true);
});

test('isEditableTarget: ignores path entries without tagName (window, document)', () => {
  const div = { tagName: 'DIV' };
  const e = fakeEvent([div, {}, null, undefined]);
  assert.equal(isEditableTarget(e), false);
});
