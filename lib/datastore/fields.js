// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/datastore/fields.js
// Manifest-derived field references + the orphan report.
//
// The manifest never declares the data shape; rows keep every key forever
// and the meta only controls what is referencable/rendered. This module
// derives the set of field names a card's meta actually references
// (inputs, display templates, trends, thresholds, calendar markers, report
// columns, checkOffForm fields, HAE catalogue row shape, donor-side combo
// accessors) and diffs it against the keys stored on the card's DATED log
// rows. Keys that hold data but are referenced by nothing are ORPHANS:
// still stored, never rendered, and restorable by re-adding the field to
// the manifest.
//
// Scope: dated rows only. Roster items (peptides/supplements items[]),
// category lists, and free documents are hand-curated content whose keys
// renderers read by convention, not via meta references — reporting on
// them would be noise. The capture-field lifecycle the report exists for
// (an input was removed, its logged values linger) lives on dated rows.
//
// Aliases: meta.data.aliases = { oldKey: newKey } marks a rename without
// rewriting rows. An old key whose alias target is referenced does not
// count as an orphan.

'use strict';

// Row keys that renderers/servers stamp mechanically and no manifest ever
// declares. Never orphans. Single exported constant per the write-path
// table in docs/CARDS.md.
const STRUCTURAL_KEYS = new Set([
  'date', 'added', 'takenAt', 'scheduledDate', 'offSchedule', 'takenDates',
  'time', 'id', 'createdAt', 'deletedAt', 'source',
]);

// {key}, {key:modifier}, {key|default}, {key?yes:no}, dotted paths. The
// leading segment of a dotted path is the row field being referenced.
const TOKEN_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)/g;

function addTemplateTokens(out, template) {
  if (typeof template !== 'string') return;
  let m;
  while ((m = TOKEN_RE.exec(template)) !== null) out.add(m[1]);
}

function addIfString(out, v) {
  if (typeof v === 'string' && v) out.add(v.split('.')[0]);
}

// Union of every field name `meta` references. Pure; never reads data.
function referencedFields(meta) {
  const out = new Set();
  if (!meta || typeof meta !== 'object') return out;

  const view = meta.view || {};
  const display = view.display || {};

  for (const input of (meta.writeable && Array.isArray(meta.writeable.inputs) ? meta.writeable.inputs : [])) {
    if (input && typeof input.key === 'string') out.add(input.key);
  }

  addTemplateTokens(out, display.template);
  addTemplateTokens(out, display.secondary);
  addTemplateTokens(out, display.secondaryTemplate);
  addIfString(out, display.primaryField);
  if (display.trendArrow) addIfString(out, display.trendArrow.field);
  for (const t of (Array.isArray(display.thresholds) ? display.thresholds : [])) {
    if (t) addIfString(out, t.ifField);
  }
  if (display.emojiMap && typeof display.emojiMap === 'object') {
    // Keyed shape only: emojiMap[field][value]. The flat shape's keys are
    // VALUES (e.g. "1".."5"), not field names.
    for (const [k, v] of Object.entries(display.emojiMap)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out.add(k);
    }
  }

  const trends = meta.trends || {};
  addIfString(out, trends.field);
  addIfString(out, trends.xAxis);
  for (const f of (Array.isArray(trends.fields) ? trends.fields : [])) addIfString(out, f);
  for (const s of (Array.isArray(trends.series) ? trends.series : [])) {
    if (s) addIfString(out, s.field);
  }

  const calendar = meta.calendar || {};
  if (calendar.marker && typeof calendar.marker === 'object') {
    addIfString(out, calendar.marker.field);
  }

  const reports = meta.reports || {};
  for (const c of (Array.isArray(reports.columns) ? reports.columns : [])) {
    if (c) addIfString(out, c.field);
  }
  if (reports.sort) addIfString(out, reports.sort.field);

  const cof = view.checkOffForm || {};
  for (const key of ['currentDoseFields', 'previousDoseFields']) {
    for (const f of (Array.isArray(cof[key]) ? cof[key] : [])) addIfString(out, f);
  }

  addIfString(out, view.dateField);

  // HAE-backed cards: the catalogue row shape is the reference set for
  // whatever the dispatcher writes. Introspected via the same probe the
  // chat prompt uses, so it stays correct as catalogue row() evolves.
  const ing = meta.ingest;
  if (ing && ing.source === 'hae' && ing.metric) {
    try {
      const catalogue = require('../../health-auto-export/catalogue');
      const { describeMetric } = require('../../health-auto-export/describe');
      const entry = catalogue[ing.metric];
      if (entry) {
        const desc = describeMetric(ing.metric, entry);
        const shape = desc.match(/row = \{ ([^}]*) \}/);
        if (shape) for (const f of shape[1].split(',')) out.add(f.trim());
      }
    } catch {}
  }

  return out;
}

// Fields other cards reach INTO this card via combines[].accessor. Donor-side
// references: walk every manifest, collect accessors pointing at `id`.
function combinesReferences(id, allManifests) {
  const out = new Set();
  for (const other of allManifests) {
    const combines = other && other.meta && other.meta.view && other.meta.view.combines;
    if (!Array.isArray(combines)) continue;
    for (const c of combines) {
      if (c && c.sourceId === id && typeof c.accessor === 'string' && c.accessor) {
        out.add(c.accessor.split('.')[0]);
      }
    }
  }
  return out;
}

// meta.data.aliases = { oldKey: newKey }. Stored under meta so it rides the
// normal patch surface; validated leniently (non-object -> empty).
function aliasMap(meta) {
  const aliases = meta && meta.data && meta.data.aliases;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return {};
  const out = {};
  for (const [k, v] of Object.entries(aliases)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

// Collect keys from the card's DATED rows: the root array, or each
// array-valued key of an object-shaped block, considering only containers
// where at least one row carries the resolved date field. Roster items,
// category lists, rest keys, and free documents are content, not fields.
function storedDatedKeys(data, dateField = 'date') {
  const keys = new Set();
  const addIfDated = rows => {
    const dated = rows.some(r => r && typeof r === 'object' && !Array.isArray(r)
      && typeof r[dateField] === 'string');
    if (!dated) return;
    for (const r of rows) {
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        for (const k of Object.keys(r)) keys.add(k);
      }
    }
  };
  if (Array.isArray(data)) {
    addIfDated(data);
  } else if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) addIfDated(v);
    }
  }
  return keys;
}

// The report. `registry` needs get(id) + list().
function orphanReport(registry, id) {
  const entry = registry.get(id);
  if (!entry) return { error: `unknown manifest: ${id}` };
  const meta = entry.meta || {};
  const dateField = (meta.view && typeof meta.view.dateField === 'string' && meta.view.dateField.trim())
    || 'date';

  const referenced = referencedFields(meta);
  const donors = combinesReferences(id, registry.list());
  const aliases = aliasMap(meta);
  const stored = storedDatedKeys(entry.data, dateField);

  const orphans = [];
  for (const key of stored) {
    if (STRUCTURAL_KEYS.has(key) || key === dateField) continue;
    if (referenced.has(key) || donors.has(key)) continue;
    // Aliased rename: old key projects onto a referenced new key.
    const target = aliases[key];
    if (target && (referenced.has(target) || donors.has(target))) continue;
    orphans.push(key);
  }
  orphans.sort();

  return {
    id,
    orphans,
    referenced: [...referenced].sort(),
    aliases,
  };
}

// Rewrite rows renaming `fromKey` -> `toKey` across every row of the card's
// data (root array rows and rows in every object-key container; the rest
// keys and doc shapes are content, not fields, and are left alone).
// Full-replace via registry.writeData so the swap is one datastore
// transaction with the usual shape checks. Refuses to clobber: any row
// already carrying `toKey` aborts before writing.
function renameDataField(registry, id, fromKey, toKey) {
  if (!fromKey || !toKey || typeof fromKey !== 'string' || typeof toKey !== 'string') {
    return { error: 'from_key and to_key must be non-empty strings' };
  }
  if (fromKey === toKey) return { error: 'from_key and to_key are identical' };
  if (STRUCTURAL_KEYS.has(fromKey)) {
    return { error: `"${fromKey}" is a structural key and cannot be renamed` };
  }
  const entry = registry.get(id);
  if (!entry) return { error: `unknown manifest: ${id}` };
  const data = entry.data;

  const renameRows = rows => rows.map(r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)
        || !Object.prototype.hasOwnProperty.call(r, fromKey)) return r;
    if (Object.prototype.hasOwnProperty.call(r, toKey)) {
      throw new Error(`a row already has "${toKey}"; refusing to clobber`);
    }
    const next = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === fromKey) next[toKey] = v;
      else next[k] = v;
    }
    return next;
  });
  const countRenames = (before, after) => {
    let n = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) n++;
    return n;
  };

  let staged;
  let renamed = 0;
  try {
    if (Array.isArray(data)) {
      staged = renameRows(data);
      renamed = countRenames(data, staged);
    } else if (data && typeof data === 'object') {
      staged = {};
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) {
          const next = renameRows(v);
          renamed += countRenames(v, next);
          staged[k] = next;
        } else {
          staged[k] = v;
        }
      }
    } else {
      return { error: `${id} has no row-shaped data to rename fields in` };
    }
  } catch (e) {
    return { error: e.message };
  }
  if (renamed === 0) return { error: `no row carries "${fromKey}"` };

  registry.writeData(id, staged);
  return { ok: true, id, from: fromKey, to: toKey, rowsRenamed: renamed };
}

module.exports = {
  referencedFields,
  combinesReferences,
  aliasMap,
  storedDatedKeys,
  orphanReport,
  renameDataField,
  STRUCTURAL_KEYS,
};
