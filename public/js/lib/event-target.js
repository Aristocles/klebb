// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/event-target.js
// Helpers for inspecting event targets across shadow-DOM boundaries.

// Returns true if the event originated from (or bubbled through) an
// editable element anywhere in the composed path. Window-level keydown
// listeners need this because e.target retargets to the shadow host for
// events fired inside a shadow root, so a plain e.target.tagName check
// misses inputs inside web components (e.g. the chat widget's textarea).
export function isEditableTarget(e) {
  const path = e.composedPath ? e.composedPath() : [e.target];
  for (const t of path) {
    if (!t || !t.tagName) continue;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
  }
  return false;
}
