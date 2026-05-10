// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// config/categories.js
//
// Canonical list of manifest category values. An optional `meta.category`
// field on a manifest groups it for downstream heuristics (e.g. surfacing
// combination-card suggestions when three cards share a category). The
// field is optional; absent means "no category", i.e. invisible to
// category-based heuristics but still fully functional as a card.
//
// The enum is intentionally small and non-overlapping. Extensions should
// be deliberate — adding a new category fragments the clustering signal,
// so prefer mapping new card concepts onto an existing category where
// the fit is reasonable.
//
// Anything outside this enum is silently dropped at load time
// (validateManifestShape) so the chat agent can't fragment the set by
// inventing values like `wellness` or `heart-health`.

const CATEGORIES = Object.freeze([
  'sleep',
  'recovery',
  'activity',
  'vitals',
  'body',
  'mindfulness',
  'lifestyle',
  'supplements',
  'medication',
]);

const CATEGORY_SET = new Set(CATEGORIES);

function isValidCategory(value) {
  return typeof value === 'string' && CATEGORY_SET.has(value);
}

module.exports = { CATEGORIES, isValidCategory };
