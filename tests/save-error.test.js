// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/save-error.test.js
// Unit tests for public/js/lib/save-error.js.
//
// The bug behind this helper: writeable renderers were throwing
// `HTTP 403` on any non-2xx from /api/manifests/:id/data, hiding the
// server's actual `{ error: "..." }` payload. A klebbtest instance
// running in UTC rejected today's writes as "future-dated" and the
// operator couldn't see why without DevTools. This helper exposes the
// server's reason string in the thrown Error.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorFromResponse } from '../public/js/lib/save-error.js';

// Minimal Response stand-in matching the bits the helper uses.
// (node:test runs in Node, which has a real Response, but constructing
// one with a specific status + JSON body cleanly is easier this way.)
function makeResponse({ status, body, contentType = 'application/json' }) {
  return {
    status,
    clone() { return makeResponse({ status, body, contentType }); },
    async json() {
      if (contentType !== 'application/json') throw new Error('not json');
      if (typeof body === 'string') return JSON.parse(body);
      return body;
    },
    async text() {
      if (typeof body === 'string') return body;
      return JSON.stringify(body);
    },
  };
}

test('errorFromResponse: prefers server-sent error string', async () => {
  const r = makeResponse({
    status: 403,
    body: { error: 'future-dated entry (2026-05-05) not allowed for this card' },
  });
  const err = await errorFromResponse(r);
  assert.ok(err instanceof Error);
  assert.equal(err.message, '403: future-dated entry (2026-05-05) not allowed for this card');
});

test('errorFromResponse: falls back to HTTP status when body lacks error', async () => {
  const r = makeResponse({ status: 500, body: {} });
  const err = await errorFromResponse(r);
  assert.equal(err.message, 'HTTP 500');
});

test('errorFromResponse: uses text body when JSON parse fails', async () => {
  const r = makeResponse({
    status: 502,
    body: 'upstream gateway timeout',
    contentType: 'text/plain',
  });
  const err = await errorFromResponse(r);
  assert.equal(err.message, '502: upstream gateway timeout');
});

test('errorFromResponse: truncates very long text bodies', async () => {
  const long = 'x'.repeat(500);
  const r = makeResponse({ status: 500, body: long, contentType: 'text/plain' });
  const err = await errorFromResponse(r);
  assert.equal(err.message.length <= '500: '.length + 200, true);
});

test('errorFromResponse: non-string error field falls back to status', async () => {
  const r = makeResponse({ status: 400, body: { error: { nested: 'obj' } } });
  const err = await errorFromResponse(r);
  assert.equal(err.message, 'HTTP 400');
});
