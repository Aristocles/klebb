// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const index = require('./source-index');
let currentBoundary = () => null;
let blocked = () => true;
let stopped = true;
let immediate = null;
const pending = new Set();
const timers = new Map();
function schedule(sourceStoreId) {
  if (stopped) return;
  const timer = timers.get(sourceStoreId);
  if (timer) { clearTimeout(timer); timers.delete(sourceStoreId); }
  pending.add(sourceStoreId);
  if (!immediate) immediate = setImmediate(drain);
}
function retry(sourceStoreId, at) {
  if (stopped || at === null) return;
  const timer = setTimeout(() => { timers.delete(sourceStoreId); schedule(sourceStoreId); },
    Math.max(0, at - Date.now()));
  timer.unref();
  timers.set(sourceStoreId, timer);
}
function drain() {
  immediate = null;
  const batch = [...pending];
  pending.clear();
  for (const sourceStoreId of batch) {
    if (stopped || blocked()) continue;
    let boundary;
    let admitted = false;
    try {
      boundary = currentBoundary();
      if (!boundary) continue;
      const attempt = index.prepareAttempt(boundary, sourceStoreId);
      if (typeof attempt === 'number') { retry(sourceStoreId, attempt); continue; }
      if (!attempt) continue;
      admitted = true;
      index.publishSource(boundary, sourceStoreId);
    } catch (error) {
      try {
        if (admitted && !blocked() && boundary) {
          retry(sourceStoreId, index.recordFailure(boundary, sourceStoreId, error));
        }
      } catch {}
      // Deliberately fixed and payload-free; durable raw ACKs remain unchanged.
      console.warn('[health-connect] source index unavailable');
    }
  }
}
function startSourceIndex(getBoundary, isBlocked) {
  stopSourceIndex();
  currentBoundary = getBoundary;
  blocked = isBlocked;
  stopped = false;
  if (blocked()) return;
  try {
    const boundary = currentBoundary();
    for (const source of index.savedSources(boundary)) schedule(source.sourceStoreId);
  } catch { console.warn('[health-connect] source index unavailable'); }
}
function stopSourceIndex() {
  stopped = true;
  if (immediate) clearImmediate(immediate);
  immediate = null;
  pending.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
module.exports = { scheduleSourceIndex: schedule, startSourceIndex, stopSourceIndex };
