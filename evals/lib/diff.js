// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/lib/diff.js — compare two manifest-store snapshots. Pure.

// Returns { created: [id], deleted: [id], modified: [id], untouched: [id] }.
function diffSnapshots(before, after) {
  const beforeIds = new Set(Object.keys(before.cards));
  const afterIds = new Set(Object.keys(after.cards));
  const created = [...afterIds].filter(id => !beforeIds.has(id)).sort();
  const deleted = [...beforeIds].filter(id => !afterIds.has(id)).sort();
  const modified = [];
  const untouched = [];
  for (const id of beforeIds) {
    if (!afterIds.has(id)) continue;
    if (JSON.stringify(before.cards[id]) !== JSON.stringify(after.cards[id])) modified.push(id);
    else untouched.push(id);
  }
  modified.sort(); untouched.sort();
  return { created, deleted, modified, untouched };
}

module.exports = { diffSnapshots };
