// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// manifests/merge-patch.js
// RFC 7396 JSON Merge Patch — apply a partial document over a target.
//
// Rules:
//   - If patch is not a plain object, replace target with patch.
//   - Otherwise for each key in patch:
//       - if value is null, remove the key from target.
//       - if value is a plain object, recurse into target[key] (creating
//         an empty object first if target[key] isn't a plain object).
//       - otherwise (primitive, array), replace target[key] with value.
//
// Arrays are always REPLACED, never merged. That's the spec; it also
// matches the user-visible semantics we want for e.g. rewriting
// meta.writeable.inputs to drop a single flag on one input.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return patch;
  const base = isPlainObject(target) ? { ...target } : {};
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv === null) {
      delete base[key];
    } else if (isPlainObject(pv)) {
      base[key] = mergePatch(base[key], pv);
    } else {
      base[key] = pv;
    }
  }
  return base;
}

module.exports = { mergePatch, isPlainObject };
