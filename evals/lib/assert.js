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
//   registryClean:    true   (no loader/validation errors after the turn)
//   chips:            { present: true|false, labelsInclude: [substr...],
//                       maxCount: n }
//   http:             { status: 200 }

function evalTurn(expect, facts) {
  const findings = [];
  const e = expect || {};
  const { reply, followup, status, tools, diff, registryErrors } = facts;

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

module.exports = { evalTurn };
