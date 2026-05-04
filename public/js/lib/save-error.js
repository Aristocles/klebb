// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/save-error.js
//
// Build a human-readable Error from a failed fetch Response. Prefers the
// server's `{ error: "..." }` JSON payload (the shape every Klebb API
// endpoint returns on non-2xx); falls back to plain text, then status.
//
// Use from renderers:
//   if (!r.ok) throw await errorFromResponse(r);
// then render err.message directly. The operator then sees the real reason
// (e.g. "403: future-dated entry (2026-05-05) not allowed for this card")
// instead of a generic "HTTP 403".

export async function errorFromResponse(r) {
  let detail = '';
  try {
    const body = await r.clone().json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {
    try {
      const txt = await r.text();
      if (txt) detail = txt.slice(0, 200);
    } catch {
      // ignore; fall through to status-only message
    }
  }
  return new Error(detail ? `${r.status}: ${detail}` : `HTTP ${r.status}`);
}
