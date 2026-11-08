// SPDX-License-Identifier: AGPL-3.0-only
// Shared ordinary-history reads, confirmed writes and bounded GET throttling.

import { errorFromResponse } from './save-error.js';

const TTL_MS = 20000;
const dataCache = new Map();
const confirmedData = new Map();
const metaCache = new Map();
const jsonCache = new Map();
const revisions = new Map();
const scopes = new Map();
const pendingWrites = new Map();
let cooldownUntil = 0;

const dataURL = id => `/api/manifests/${encodeURIComponent(id)}/data`;
const metaURL = id => `/api/manifests/${encodeURIComponent(id)}`;

export class ReadCooldownError extends Error {
  constructor(retryAt, blocked = false) {
    super('Updates are temporarily busy. Please try again shortly.');
    this.name = 'ReadCooldownError';
    this.status = 429;
    this.transient = true;
    this.retryAt = retryAt;
    this.blocked = blocked;
  }
}

// Browser timers cannot represent every Retry-After date in one interval.
// Chunk long waits against the absolute deadline without retrying early.
export function scheduleReadRetry(retryAt, callback) {
  let cancelled = false;
  let timer;
  const wait = () => {
    if (cancelled) return;
    const remaining = retryAt - Date.now();
    timer = setTimeout(() => {
      if (cancelled) return;
      if (Date.now() >= retryAt) callback();
      else wait();
    }, Math.max(0, Math.min(remaining, 2147483647)));
  };
  wait();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

function retryDeadline(header) {
  const now = Date.now();
  if (header != null && /^\d+(?:\.\d+)?$/.test(header.trim())) {
    const deadline = now + Number(header) * 1000;
    if (Number.isFinite(deadline)) return deadline;
  }
  const parsed = header ? Date.parse(header) : NaN;
  return Number.isFinite(parsed) ? Math.max(now, parsed) : now + 1000;
}

async function getJSON(url, options = {}) {
  if (Date.now() < cooldownUntil) throw new ReadCooldownError(cooldownUntil, true);
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...options, method: 'GET' });
  } catch (error) {
    error.transient = true;
    throw error;
  }
  if (response.status === 429) {
    cooldownUntil = Math.max(cooldownUntil, retryDeadline(response.headers.get('Retry-After')));
    throw new ReadCooldownError(cooldownUntil);
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.transient = response.status >= 500 || response.status === 408;
    throw error;
  }
  try {
    return await response.json();
  } catch (error) {
    if (error.name === 'TypeError' || error.name === 'AbortError') error.transient = true;
    throw error;
  }
}

function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function manifestCacheRevision(id) {
  return revisions.get(id) || 0;
}

export function hasPendingManifestWrite(id) {
  return pendingWrites.has(id);
}

export function peekManifestData(id) {
  return confirmedData.get(id);
}

export function isManifestDataFresh(id) {
  const entry = dataCache.get(id);
  return !!entry && !entry.inflight && Date.now() - entry.fetchedAt < TTL_MS;
}

export function invalidateManifestCache(id) {
  revisions.set(id, manifestCacheRevision(id) + 1);
  dataCache.delete(id);
}

export function invalidateManifestMeta(id) {
  metaCache.delete(id);
}

function forgetOrdinary(id) {
  invalidateManifestCache(id);
  confirmedData.delete(id);
}

export async function fetchManifestData(id, current = () => true) {
  // Cache admission belongs to the shared read, independently of a reader
  // disconnecting. Each consumer still fences its own display with current().
  const pending = pendingWrites.get(id);
  if (pending) await pending.catch(() => {});
  const cached = dataCache.get(id);
  if (cached?.inflight) return cached.inflight;
  if (isManifestDataFresh(id)) return cached.data;
  const entry = { fetchedAt: 0, inflight: null };
  const promise = (async () => {
    try {
      const body = await getJSON(dataURL(id));
      // A read fenced by a write or source change must never deliver old
      // history to another consumer, even one without a display guard.
      if (dataCache.get(id) !== entry) return fetchManifestData(id, current);
      if (Object.hasOwn(body, 'projection')) {
        dataCache.delete(id);
        confirmedData.delete(id);
        throw new Error('Saved source changed; refresh the card');
      }
      const data = immutable(body.data);
      entry.data = data;
      entry.fetchedAt = Date.now();
      entry.inflight = null;
      confirmedData.set(id, data);
      return data;
    } catch (error) {
      if (dataCache.get(id) === entry) {
        dataCache.delete(id);
        if (!error.transient) confirmedData.delete(id);
      }
      throw error;
    }
  })();
  entry.inflight = promise;
  dataCache.set(id, entry);
  return promise;
}

export async function fetchSelectedManifestData(id) {
  // Selected/native responses are scoped projections, never ordinary history.
  scopes.set(id, (scopes.get(id) || 0) + 1);
  forgetOrdinary(id);
  const body = await getJSON(dataURL(id), { cache: 'no-store' });
  if (!Array.isArray(body.data) || !body.projection
      || !['saved', 'pending'].includes(body.projection.state)
      || !/^sha256:[a-f0-9]{64}$/.test(body.projection.revision)) {
    throw new Error('Saved data status is unavailable');
  }
  return body;
}

export async function fetchManifestMeta(id) {
  const cached = metaCache.get(id);
  if (cached?.inflight) return cached.inflight;
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.meta;
  const entry = { fetchedAt: 0, inflight: null };
  entry.inflight = (async () => {
    try {
      const body = await getJSON(metaURL(id));
      if (metaCache.get(id) !== entry) return fetchManifestMeta(id);
      entry.meta = body.meta || null;
      entry.fetchedAt = Date.now();
      entry.inflight = null;
      return entry.meta;
    } catch (error) {
      if (metaCache.get(id) === entry) metaCache.delete(id);
      throw error;
    }
  })();
  metaCache.set(id, entry);
  return entry.inflight;
}

function compatibleOptions(options) {
  const { ttl = TTL_MS, ...fetchOptions } = options;
  if (fetchOptions.method && fetchOptions.method.toUpperCase() !== 'GET') {
    throw new Error('Shared reads only support GET');
  }
  if (fetchOptions.body != null) throw new Error('Shared reads cannot send a body');
  const normalized = { credentials: 'same-origin', ...fetchOptions, method: 'GET' };
  const headers = [...new Headers(normalized.headers).entries()].sort(([a], [b]) => a.localeCompare(b));
  normalized.headers = headers;
  // AbortSignal is subscriber-specific and must not cancel a peer's read.
  const shared = !normalized.signal && normalized.cache !== 'no-store';
  const key = JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
  return { ttl, fetchOptions: normalized, shared, key };
}

export async function readJSON(url, options = {}) {
  const pathname = new URL(url, globalThis.location?.origin || 'http://localhost').pathname;
  if (/^\/api\/manifests\/[^/]+\/data\/?$/.test(pathname)) {
    throw new Error('Manifest history requires a scoped manifest read');
  }
  const normalized = compatibleOptions(options);
  if (!normalized.shared) return getJSON(url, normalized.fetchOptions);
  const key = `${url}\n${normalized.key}`;
  const cached = jsonCache.get(key);
  if (cached?.inflight) return cached.inflight;
  if (cached && Date.now() - cached.fetchedAt < normalized.ttl) return cached.body;
  const entry = { url, fetchedAt: 0, inflight: null };
  entry.inflight = (async () => {
    try {
      const body = await getJSON(url, normalized.fetchOptions);
      if (jsonCache.get(key) !== entry) return readJSON(url, options);
      entry.body = body;
      entry.fetchedAt = Date.now();
      entry.inflight = null;
      return body;
    } catch (error) {
      if (jsonCache.get(key) === entry) jsonCache.delete(key);
      throw error;
    }
  })();
  jsonCache.set(key, entry);
  return entry.inflight;
}

export function invalidateRead(url) {
  for (const [key, entry] of jsonCache) {
    if (entry.url === url) jsonCache.delete(key);
  }
}

export async function saveManifestData(id, data) {
  if (pendingWrites.has(id)) throw new Error('A save is already in progress. Please wait.');
  const body = JSON.stringify({ data });
  const snapshot = immutable(JSON.parse(body).data);
  const scope = scopes.get(id) || 0;
  invalidateManifestCache(id);
  const writeRevision = manifestCacheRevision(id);
  let cacheUpdated = false;
  const pending = (async () => {
    const response = await fetch(dataURL(id), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw await errorFromResponse(response);
    const confirmation = await response.json().catch(() => null);
    if (confirmation?.ok !== true) throw new Error('The save was not confirmed. Please try again.');
    cacheUpdated = (scopes.get(id) || 0) === scope
      && manifestCacheRevision(id) === writeRevision;
    invalidateManifestCache(id);
    if (cacheUpdated) {
      confirmedData.set(id, snapshot);
      dataCache.set(id, { data: snapshot, fetchedAt: Date.now(), inflight: null });
    }
  })();
  pendingWrites.set(id, pending);
  try {
    try {
      await pending;
    } finally {
      if (pendingWrites.get(id) === pending) pendingWrites.delete(id);
    }
  } catch (error) {
    globalThis.window?.dispatchEvent(new CustomEvent('manifest-data-save-failed', {
      detail: { cardId: id, error: error.message || 'Could not save. Please try again.' },
    }));
    throw error;
  }
  globalThis.window?.dispatchEvent(new CustomEvent('manifest-data-changed', {
    detail: { cardId: id, cacheUpdated },
  }));
}

// Register before component listeners. Every reader of an event sees one
// shared invalidation rather than deleting a peer's newly started request.
globalThis.window?.addEventListener('manifest-data-changed', event => {
  if (event.detail?.cacheUpdated) return;
  const id = event.detail?.cardId || event.detail?.id;
  const ids = id ? [id] : new Set([...revisions.keys(), ...dataCache.keys(), ...pendingWrites.keys()]);
  for (const changed of ids) {
    invalidateManifestCache(changed);
    invalidateManifestMeta(changed);
  }
  jsonCache.clear();
});

globalThis.window?.addEventListener('klebb-cards-changed', () => {
  const ids = new Set([...revisions.keys(), ...dataCache.keys(), ...metaCache.keys(), ...pendingWrites.keys()]);
  for (const id of ids) {
    scopes.set(id, (scopes.get(id) || 0) + 1);
    forgetOrdinary(id);
  }
  metaCache.clear();
  jsonCache.clear();
});
