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
//
// Data lives in the datastore now, so GET /api/manifests is meta-only. When
// the caller passes `dataIds` (the cards a scenario actually asserts on) we
// fetch each of those cards' data blocks (GET /api/manifests/:id/data) and
// merge them in. Without the data, the differ is data-blind (a pure row write
// leaves meta untouched and reads as "no change") and cardShape can't reach
// into data[...]. We fetch ONLY the cards of interest, not the whole store,
// so request volume stays a small constant regardless of how many cards the
// instance holds — that keeps a full corpus run under the instance's per-IP
// rate limit. A non-ok per-card fetch throws so a partial snapshot can never
// produce a false diff.
async function snapshotState(baseUrl, token, dataIds = null) {
  const res = await fetch(`${baseUrl}/api/manifests`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`snapshot failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const entries = body.entries || [];
  const want = dataIds ? new Set(dataIds) : null;
  const cards = {};
  await Promise.all(entries.map(async (entry) => {
    const fetchIt = entry.hasData && (!want || want.has(entry.id));
    const data = fetchIt ? await fetchData(baseUrl, token, entry.id) : undefined;
    cards[entry.id] = { meta: entry.meta, data };
  }));
  return { cards, errors: body.errors || [] };
}

async function fetchData(baseUrl, token, id) {
  const res = await fetch(`${baseUrl}/api/manifests/${encodeURIComponent(id)}/data`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`data fetch for ${id} failed: HTTP ${res.status}`);
  const body = await res.json();
  return body.data;
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

module.exports = { chatTurn, snapshotState, fetchData, deleteManifest, createManifest };
