// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// health-auto-export/describe.js
//
// Introspects catalogue.js at runtime to produce a human-readable
// summary of supported HAE metrics + the row fields each one emits.
// Consumed by the chat system prompt so the agent writes display
// templates referencing fields the catalogue actually produces, not
// fields it infers from HAE's raw payload schema.
//
// Introspection strategy: pass a probe entry that exposes common HAE
// field names, plus a broad set of numeric + string fallbacks. The
// catalogue's pure row() maps the probe to the output shape; we then
// read the output keys. This is more accurate than parsing source
// code and stays correct as row() evolves.

const catalogue = require('./catalogue');

// A single probe entry that's generous enough to trigger every field
// any current or plausible-future catalogue row() might copy through.
// Values are chosen so numeric() returns a finite number.
function makeProbe() {
  return {
    // Date fields (different catalogue entries pick different ones).
    date:       '2026-01-01 00:00:00 +0000',
    sleepStart: '2026-01-01 00:00:00 +0000',
    start:      '2026-01-01 00:00:00 +0000',

    // Numeric generics.
    qty: 1,

    // Sleep-specific fields.
    totalSleep: 7.5,
    asleep:     7.3,
    inBed:      8.1,
    deep:       1.2,
    rem:        1.5,
    core:       4.3,
    awake:      0.3,

    // Attribution + labels.
    source: 'probe',
    name:   'probe',
  };
}

function describeMetric(key, entry) {
  const probe = makeProbe();
  let row;
  try {
    row = entry.row(probe);
  } catch {
    row = null;
  }

  const from = entry.from || 'metrics';
  if (!row || typeof row !== 'object') {
    return `${key} (from data.${from}): row shape indeterminate`;
  }

  // Partition keys: `date` is always first; everything else alphabetical.
  const keys = Object.keys(row);
  const rest = keys.filter(k => k !== 'date').sort();
  const orderedKeys = ['date', ...rest];

  const fields = orderedKeys.join(', ');
  const source = from === 'workouts'
    ? 'data.workouts[]'
    : `data.metrics[name="${key}"].data[]`;
  const catLabel = entry.category ? `[${entry.category}] ` : '';
  return `${catLabel}${key} (reads ${source}, ${entry.aggregate}): row = { ${fields} }`;
}

// Produces the full catalogue summary block suitable for inclusion in
// a chat system prompt. Returns a single string with a header, a short
// rule, and one line per catalogue metric.
function describeCatalogue() {
  const lines = [];
  lines.push('## Health Auto Export catalogue');
  lines.push('');
  lines.push('When writing a manifest with `meta.ingest.source: "hae"`, the');
  lines.push('`display.template`, `trends.field`, and any other field');
  lines.push('references MUST only use fields from the row shape below.');
  lines.push('Klebb\'s catalogue is the authoritative source of what fields');
  lines.push('end up in `data[]`; do not invent fields from HAE\'s raw');
  lines.push('payload. Optional fields may be absent on any given row.');
  lines.push('');

  const keys = Object.keys(catalogue).sort();
  for (const key of keys) {
    lines.push(`- ${describeMetric(key, catalogue[key])}`);
  }
  return lines.join('\n');
}

module.exports = { describeCatalogue, describeMetric };
