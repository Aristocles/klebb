// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/lib/driver.js — talk to a running Klebb instance the way the chat
// widget does. Pure HTTP against public surfaces: no test hooks in the app.

const DEFAULT_TURN_TIMEOUT_MS = 120000;

// One chat turn. `history` is the full prior [{role, content}...] thread;
// the server is stateless per request, so the caller threads history.
// Returns { reply, followup, status, ms }.
async function chatTurn(baseUrl, token, history, { viewedCardId = null, timeoutMs = DEFAULT_TURN_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(viewedCardId ? { messages: history, viewedCardId } : { messages: history }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status,
    reply: body.reply || '',
    followup: body.followup || null,
    error: body.error || null,
    ms: Date.now() - started,
  };
}

// Full manifest-store snapshot: id -> { meta, data } plus registry errors.
// This is the deterministic oracle: whatever the model did, the resulting
// state is machine-checkable.
async function snapshotState(baseUrl, token) {
  const res = await fetch(`${baseUrl}/api/manifests`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`snapshot failed: HTTP ${res.status}`);
  const body = await res.json();
  const cards = {};
  for (const entry of body.entries || []) {
    cards[entry.id] = { meta: entry.meta, data: entry.data };
  }
  return { cards, errors: body.errors || [] };
}

async function deleteManifest(baseUrl, token, id) {
  const res = await fetch(`${baseUrl}/api/manifests/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  return res.ok;
}

async function createManifest(baseUrl, token, manifest) {
  const res = await fetch(`${baseUrl}/api/manifests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(manifest),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`seed create failed: ${body.error || res.status}`);
  return body.id;
}

module.exports = { chatTurn, snapshotState, deleteManifest, createManifest };
