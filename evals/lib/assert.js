// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/lib/assert.js — evaluate a scenario's expectations against what a
// turn actually did. Pure: takes captured facts, returns finding strings
// (empty array = turn passed).
//
// Expectation vocabulary (all optional, all deterministic):
//   reply:            { match: [regex...], noMatch: [regex...] }
//   tools:            { required: [name...], forbidden: [name...],
//                       allowOnly: [name...], noErrors: true }
//   state:            { created: [id...], noCreates: true, deleted: [id...],
//                       noDeletes: true, modifiedOnly: [id...],
//                       noChanges: true }
//   cardShape:        { <cardId|'$created'>: { <pathExpr>: <matcher>, ... } }
//                       Reads the post-turn snapshot and asserts the SHAPE a
//                       card ended up in — the "how it changed", not just the
//                       "which changed" that state/diff gives you. pathExpr
//                       uses the same tiny grammar the chat tools use
//                       (manifests/path.js): dotted properties + equality
//                       filters, e.g. 'meta.trends.enabled',
//                       'meta.view.combines[index=0].sourceId',
//                       'data[date="2026-07-05"].value'. '$created' resolves
//                       to the single card created this turn (the model picks
//                       its id). A matcher is an object combining any of:
//                         exists:    true | false
//                         equals:    deep-equal to this value
//                         oneOf:     deep-equal to one of these values
//                         type:      'array'|'object'|'string'|'number'|'boolean'|'null'
//                         length:    exact length (array/string)
//                         minLength: minimum length (array/string)
//   registryClean:    true   (no loader/validation errors after the turn)
//   chips:            { present: true|false, labelsInclude: [substr...],
//                       maxCount: n }
//   http:             { status: 200 }

const { isDeepStrictEqual } = require('util');
const { parsePath, resolvePath } = require('../../manifests/path');

function evalTurn(expect, facts) {
  const findings = [];
  const e = expect || {};
  const { reply, followup, status, tools, diff, registryErrors, snapshot } = facts;

  if (e.http && e.http.status && status !== e.http.status) {
    findings.push(`http: expected ${e.http.status}, got ${status}`);
  }

  if (e.reply) {
    for (const pattern of e.reply.match || []) {
      if (!new RegExp(pattern, 'i').test(reply)) findings.push(`reply: missing /${pattern}/i`);
    }
    for (const pattern of e.reply.noMatch || []) {
      if (new RegExp(pattern, 'i').test(reply)) findings.push(`reply: matched forbidden /${pattern}/i`);
    }
  }

  if (e.tools) {
    const names = tools.map(t => t.name);
    for (const name of e.tools.required || []) {
      if (!names.includes(name)) findings.push(`tools: required ${name} not called (called: ${names.join(',') || 'none'})`);
    }
    for (const name of e.tools.forbidden || []) {
      if (names.includes(name)) findings.push(`tools: forbidden ${name} was called`);
    }
    if (e.tools.allowOnly) {
      for (const name of names) {
        if (!e.tools.allowOnly.includes(name)) findings.push(`tools: ${name} outside allowOnly [${e.tools.allowOnly.join(',')}]`);
      }
    }
    if (e.tools.noErrors) {
      for (const t of tools.filter(t => !t.ok)) findings.push(`tools: ${t.name} (id=${t.manifestId}) returned an error`);
    }
  }

  if (e.state && diff) {
    const s = e.state;
    if (s.noChanges && (diff.created.length || diff.deleted.length || diff.modified.length)) {
      findings.push(`state: expected no changes, saw created=[${diff.created}] deleted=[${diff.deleted}] modified=[${diff.modified}]`);
    }
    if (s.noCreates && diff.created.length) findings.push(`state: unexpected creates [${diff.created}]`);
    if (s.noDeletes && diff.deleted.length) findings.push(`state: unexpected deletes [${diff.deleted}]`);
    for (const id of s.created || []) {
      if (!diff.created.includes(id)) findings.push(`state: expected create of ${id} (created: [${diff.created}])`);
    }
    for (const id of s.deleted || []) {
      if (!diff.deleted.includes(id)) findings.push(`state: expected delete of ${id}`);
    }
    if (s.modifiedOnly) {
      const stray = diff.modified.filter(id => !s.modifiedOnly.includes(id));
      if (stray.length) findings.push(`state: modified outside allowlist [${stray}]`);
      if (diff.created.length) findings.push(`state: modifiedOnly but created [${diff.created}]`);
      if (diff.deleted.length) findings.push(`state: modifiedOnly but deleted [${diff.deleted}]`);
    }
  }

  if (e.cardShape) {
    findings.push(...evalCardShape(e.cardShape, { snapshot, diff }));
  }

  if (e.registryClean && registryErrors && registryErrors.length) {
    findings.push(`registry: ${registryErrors.length} loader error(s) after turn: ${JSON.stringify(registryErrors).slice(0, 200)}`);
  }

  if (e.chips) {
    const offers = (followup && followup.embellishments) || [];
    if (e.chips.present === true && offers.length === 0) findings.push('chips: expected followup chips, got none');
    if (e.chips.present === false && offers.length > 0) findings.push(`chips: expected none, got ${offers.length}`);
    for (const substr of e.chips.labelsInclude || []) {
      if (!offers.some(o => (o.label || '').toLowerCase().includes(substr.toLowerCase()))) {
        findings.push(`chips: no label containing "${substr}" (labels: ${offers.map(o => o.label).join(' | ') || 'none'})`);
      }
    }
    if (e.chips.maxCount != null && offers.length > e.chips.maxCount) {
      findings.push(`chips: ${offers.length} offers exceeds max ${e.chips.maxCount}`);
    }
  }

  return findings;
}

// Assert the resulting shape of one or more cards against the post-turn
// snapshot. This is the "how did it change" oracle: state/diff tell you a
// card was modified, cardShape tells you it ended up with the right fields.
// Deterministic — it reads the same /api/manifests snapshot the differ uses.
function evalCardShape(spec, { snapshot, diff }) {
  const findings = [];
  const cards = (snapshot && snapshot.cards) || null;
  if (!cards) {
    return ['cardShape: no snapshot available (needs a live/sandbox target, not a stubbed run)'];
  }
  for (const [cardKey, pathSpecs] of Object.entries(spec)) {
    let id = cardKey;
    if (cardKey === '$created') {
      const created = (diff && diff.created) || [];
      if (created.length !== 1) {
        findings.push(`cardShape[$created]: expected exactly one created card, saw [${created.join(',') || 'none'}]`);
        continue;
      }
      id = created[0];
    }
    const card = cards[id];
    if (!card) {
      findings.push(`cardShape[${cardKey}]: no card "${id}" in the post-turn store`);
      continue;
    }
    for (const [pathExpr, matcher] of Object.entries(pathSpecs)) {
      findings.push(...matchAtPath(cardKey, card, pathExpr, matcher));
    }
  }
  return findings;
}

// Resolve `pathExpr` against a card's { meta, data } and run the matcher.
// The path roots at that wrapper object, so its first segment is 'meta' or
// 'data' (e.g. 'meta.trends.enabled', 'data[date="..."].value').
function matchAtPath(cardKey, card, pathExpr, matcher) {
  const findings = [];
  const prefix = `cardShape[${cardKey}].${pathExpr}`;

  let resolved;
  let missing = false;
  try {
    const segments = parsePath(pathExpr);
    resolved = resolvePath({ meta: card.meta, data: card.data }, segments);
  } catch (err) {
    if (err && (err.code === 'NO_MATCH' || err.code === 'BAD_PATH' || err.code === 'WRONG_TYPE')) {
      missing = true;
    } else {
      return [`${prefix}: path error: ${err.message}`];
    }
  }

  const found = !missing;
  const value = found ? resolved.value : undefined;

  if (matcher.exists === true && !found) {
    findings.push(`${prefix}: expected to exist, but path resolves to nothing`);
    return findings; // nothing more to check
  }
  if (matcher.exists === false) {
    if (found) findings.push(`${prefix}: expected NOT to exist, but found ${preview(value)}`);
    return findings;
  }
  // For any value-shaped matcher, a missing path is a failure.
  const valueMatchers = ['equals', 'oneOf', 'type', 'length', 'minLength'];
  if (!found && valueMatchers.some(k => matcher[k] !== undefined)) {
    findings.push(`${prefix}: expected a value to match, but path resolves to nothing`);
    return findings;
  }

  if (matcher.equals !== undefined && !isDeepStrictEqual(value, matcher.equals)) {
    findings.push(`${prefix}: expected equals ${preview(matcher.equals)}, got ${preview(value)}`);
  }
  if (matcher.oneOf !== undefined) {
    if (!matcher.oneOf.some(v => isDeepStrictEqual(value, v))) {
      findings.push(`${prefix}: expected one of ${preview(matcher.oneOf)}, got ${preview(value)}`);
    }
  }
  if (matcher.type !== undefined && typeName(value) !== matcher.type) {
    findings.push(`${prefix}: expected type ${matcher.type}, got ${typeName(value)}`);
  }
  if (matcher.length !== undefined) {
    const len = lengthOf(value);
    if (len !== matcher.length) findings.push(`${prefix}: expected length ${matcher.length}, got ${len === null ? 'not-lengthable' : len}`);
  }
  if (matcher.minLength !== undefined) {
    const len = lengthOf(value);
    if (len === null || len < matcher.minLength) findings.push(`${prefix}: expected minLength ${matcher.minLength}, got ${len === null ? 'not-lengthable' : len}`);
  }
  return findings;
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function lengthOf(v) {
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  return null;
}

function preview(v) {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined) s = String(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

module.exports = { evalTurn, evalCardShape };
