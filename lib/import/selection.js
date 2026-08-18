// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/import/selection.js
// Per-artefact selection for an import: which of an archive's cards, reports
// and Apple Health history come back.
//
// The model is filtered REPLACE, not merge. The wipe stays unconditional and
// total; a selection only narrows what is restored afterwards. An unticked
// artefact is NOT protected on the target: it is deleted with everything else.
//
//   const items = buildItems(root, plan);              // the selectable universe
//   const { selection, errors } = normaliseSelection(items, fromRequest);
//   const filtered = filterPlan(plan, items, selection);
//   const sets = copySets(plan, filtered, selection);   // what the copy may write
//
// A null selection means everything, and is the compatibility path: callers
// that never heard of selection (the CLI, the Cloud restore endpoint) get the
// wholesale copy they always got, with no predicate in the way.
//
// Two rules keep this safe. Validation is set membership against the tree's
// own plan rather than string parsing, so a traversal path cannot survive
// normalisation: an id or report key the archive does not already contain is
// a refusal. And every path the copy may write is derived from the FILTERED
// PLAN, which is the same object verification compares against, so the copy
// and the verify cannot disagree about what was selected.

'use strict';

const fs = require('fs');
const path = require('path');

const { parseReportHeader } = require('../../ingest/catalogue');

const ARCHIVE_PREFIX = 'reports/_archive/';
const SAMPLES_FILE = 'data/auto-export/samples.json';

// Enough to hold any frontmatter block a report carries. A block that ran
// past this would simply not parse, costing the preview its "+ original"
// hint, never correctness.
const HEADER_BYTES = 64 * 1024;

function finding(severity, scope, ref, code, message) {
  return { phase: 'select', severity, scope, ref, code, message };
}

// Client-supplied strings end up in findings that reach a log and the UI.
function clip(value) {
  const s = String(value);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function readHead(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// The archived original a report's frontmatter claims, mirroring
// lib/reports-api.js resolveSource(): basename only, and it counts only when
// the archive actually holds it. Both together make a claimed path incapable
// of reaching outside reports/_archive/.
function originalFor(header, archives) {
  const claimed = header && (header.archivePath || header.sourceFile);
  if (!claimed) return null;
  const base = path.basename(String(claimed));
  if (!base || base === '.' || base === '..') return null;
  const rel = ARCHIVE_PREFIX + base;
  return archives.has(rel) ? rel : null;
}

function bytesOf(root, files) {
  let total = 0;
  for (const rel of files) {
    try {
      total += fs.statSync(path.join(root, ...rel.split('/'))).size;
    } catch {}
  }
  return total;
}

// The selectable universe, derived from the validation plan. Cards come
// straight from it; reports are grouped so an ingested report and the
// original it was read from move together, because restoring one without the
// other loses the ability to verify it.
function buildItems(root, plan) {
  const cards = plan.cards.map(c => ({
    id: c.id,
    file: c.file,
    label: c.label || c.id,
    rows: c.rows || 0,
    hae: !!c.hae,
    data: c.data,
  }));

  const archives = new Set(plan.reports.filter(r => r.startsWith(ARCHIVE_PREFIX)));
  const claimed = new Set();
  const reports = [];
  for (const rel of plan.reports) {
    if (rel.startsWith(ARCHIVE_PREFIX)) continue;
    const header = parseReportHeader(readHead(path.join(root, ...rel.split('/'))));
    const original = originalFor(header, archives);
    const files = original ? [rel, original] : [rel];
    if (original) claimed.add(original);
    reports.push({
      key: rel,
      label: (header && header.title) || path.basename(rel).replace(/\.md$/i, ''),
      files,
      original,
      bytes: bytesOf(root, files),
    });
  }
  // An archived original no report claims becomes its own item rather than
  // riding along invisibly: every file under reports/ then belongs to exactly
  // one item, so a filtered import can reach all of them and none can be
  // silently unrestorable.
  for (const rel of archives) {
    if (claimed.has(rel)) continue;
    reports.push({
      key: rel,
      label: path.basename(rel),
      files: [rel],
      original: null,
      unlinked: true,
      bytes: bytesOf(root, [rel]),
    });
  }

  return { cards, reports, history: { pushes: plan.samplesPushes } };
}

// Resolve one family. An absent key means the whole family is included: the
// safe direction, since the wipe is unconditional and an unmentioned family
// read as "none" would delete it on the strength of an omission. An explicit
// empty array is a real "none".
function pickFamily(value, universe, scope, errors) {
  if (value === undefined || value === null) return universe.slice();
  if (!Array.isArray(value)) {
    errors.push(finding('refusal', scope, 'selection', 'SELECTION_INVALID',
      `selection.${scope} must be an array of identifiers`));
    return [];
  }
  const known = new Set(universe);
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      errors.push(finding('refusal', scope, 'selection', 'SELECTION_INVALID',
        `selection.${scope} holds a non-string entry`));
      continue;
    }
    if (!known.has(raw)) {
      errors.push(finding('refusal', scope, clip(raw), 'SELECTION_INVALID',
        `"${clip(raw)}" is not in this archive`));
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

// Returns { selection, errors }. A concrete selection (every family resolved
// to an explicit list) or null for "everything"; errors is non-empty only
// when the request was refused, in which case selection is null and the
// caller must not treat that as the compatibility path.
function normaliseSelection(items, wire) {
  if (wire === undefined || wire === null) return { selection: null, errors: [] };
  if (typeof wire !== 'object' || Array.isArray(wire)) {
    return {
      selection: null,
      errors: [finding('refusal', 'tree', 'selection', 'SELECTION_INVALID',
        'selection must be an object with cards, reports and history keys')],
    };
  }

  const errors = [];
  const cards = pickFamily(wire.cards, items.cards.map(c => c.id), 'cards', errors);
  const reports = pickFamily(wire.reports, items.reports.map(r => r.key), 'reports', errors);
  let history = true;
  if (wire.history !== undefined && wire.history !== null) {
    if (typeof wire.history !== 'boolean') {
      errors.push(finding('refusal', 'samples', 'selection', 'SELECTION_INVALID',
        'selection.history must be true or false'));
    } else {
      history = wire.history;
    }
  }
  if (errors.length) return { selection: null, errors };

  // Refused rather than run, because the wipe comes first: an import that
  // restores nothing is a total wipe reported as a successful import. Only
  // reachable through an explicit selection, so an archive that genuinely
  // holds nothing still imports as it always did.
  const restores = cards.length > 0 || reports.length > 0
    || (history && items.history.pushes > 0);
  if (!restores) {
    return {
      selection: null,
      errors: [finding('refusal', 'tree', 'selection', 'SELECTION_EMPTY',
        'nothing is selected: an import replaces everything on this instance, so this would leave it empty')],
    };
  }

  return { selection: { cards, reports, history }, errors: [] };
}

// The plan an import of `selection` would carry out. Verification is plan
// driven, so narrowing the plan is what makes the verify selection-aware.
function filterPlan(plan, items, selection) {
  if (!selection) return plan;
  const ids = new Set(selection.cards);
  const byKey = new Map(items.reports.map(r => [r.key, r]));
  const files = new Set();
  for (const key of selection.reports) {
    const item = byKey.get(key);
    if (!item) continue;
    for (const rel of item.files) files.add(rel);
  }
  return {
    ...plan,
    cards: plan.cards.filter(c => ids.has(c.id)),
    reports: plan.reports.filter(r => files.has(r)),
    samplesPushes: selection.history ? plan.samplesPushes : 0,
  };
}

// What the copy step may write, derived from the filtered plan. `cardUniverse`
// is every card file the archive has, so a card-named file the plan does NOT
// list (a legacy shape the loader skips, say) stays other-data and is copied
// either way rather than vanishing because nothing could select it.
function copySets(plan, filtered, selection) {
  return {
    cardUniverse: new Set(plan.cards.map(c => c.file)),
    cards: new Set(filtered.cards.map(c => c.file)),
    reports: new Set(filtered.reports),
    samples: !selection || selection.history !== false,
  };
}

// Copy predicate over POSIX-relative tree paths. Anything that is not a
// selectable artefact is instance shape rather than content (info files,
// ingest state, an archive manifest) and rides along.
function accepts(sets, rel) {
  if (rel === SAMPLES_FILE) return sets.samples;
  if (sets.cardUniverse.has(rel)) return sets.cards.has(rel);
  if (rel.startsWith('reports/')) return sets.reports.has(rel);
  return true;
}

module.exports = {
  buildItems,
  normaliseSelection,
  filterPlan,
  copySets,
  accepts,
  SAMPLES_FILE,
  ARCHIVE_PREFIX,
};
