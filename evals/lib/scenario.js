// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/lib/scenario.js — execute one scenario file against an instance.
//
// Scenario shape (JS module exporting this object):
//   {
//     name: 'create-basic-card',
//     seeds: [manifest, ...],          // created before the run, deleted after
//     turns: [
//       { say: 'text',                 // or { chip: n } to click the nth chip
//         viewedCardId: 'id',          // optional focus context
//         expect: { ...assert vocab } },
//     ],
//     cleanupIds: ['id', ...],         // extra ids to delete after (cards the
//                                      // model is EXPECTED to create)
//   }
//
// The runner threads chat history across turns exactly like the widget
// does (user/assistant pairs; tool traffic stays server-side). A `chip`
// turn feeds the chosen offer's prompt back as the next user message,
// which is precisely what the UI does on chip click.

const { chatTurn, snapshotState, deleteManifest, createManifest } = require('./driver');
const { diffSnapshots } = require('./diff');
const { evalTurn } = require('./assert');

async function runScenario(scenario, { baseUrl, token, collector, log = () => {} }) {
  const seeded = [];
  const turnResults = [];
  let history = [];
  let lastFollowup = null;
  const scenarioStart = await snapshotState(baseUrl, token);

  try {
    for (const seed of scenario.seeds || []) {
      await createManifest(baseUrl, token, seed);
      seeded.push(seed.meta.id);
    }

    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      let userText = turn.say;
      if (turn.chip != null) {
        const offers = (lastFollowup && lastFollowup.embellishments) || [];
        const offer = offers[turn.chip];
        if (!offer) {
          turnResults.push({ turn: i, findings: [`chip: turn asked for chip #${turn.chip} but only ${offers.length} offered`] });
          break;
        }
        userText = offer.prompt;
      }

      const before = await snapshotState(baseUrl, token);
      if (collector) collector.mark();

      history.push({ role: 'user', content: userText });
      const res = await chatTurn(baseUrl, token, history, { viewedCardId: turn.viewedCardId });
      history.push({ role: 'assistant', content: res.reply });
      lastFollowup = res.followup;

      // Tool lines are written when the loop finishes, but give the log
      // pipe a beat to flush before reading.
      await new Promise(r => setTimeout(r, 500));
      const after = await snapshotState(baseUrl, token);
      const requests = collector ? collector.sinceMark() : [];
      const tools = requests.flatMap(r => r.tools);
      const diff = diffSnapshots(before, after);

      const findings = evalTurn(turn.expect, {
        reply: res.reply,
        followup: res.followup,
        status: res.status,
        tools,
        diff,
        registryErrors: after.errors,
      });
      turnResults.push({
        turn: i,
        say: userText.slice(0, 80),
        findings,
        facts: {
          replyPreview: res.reply.slice(0, 200),
          tools: tools.map(t => `${t.name}(${t.manifestId || ''})${t.ok ? '' : '!ERR'}`),
          diff,
          chips: ((res.followup || {}).embellishments || []).map(o => o.label),
          ms: res.ms,
        },
      });
      log(`  turn ${i}: ${findings.length ? 'FAIL ' + findings.join('; ') : 'ok'} (${res.ms}ms, tools: ${tools.map(t => t.name).join(',') || 'none'})`);
      if (findings.length && turn.stopOnFail !== false) break;
    }
  } finally {
    // Delete seeds, declared expectations, and ANYTHING the model created
    // that wasn't there at scenario start: repeated runs against a live
    // instance must never accumulate stray cards.
    const scenarioEnd = await snapshotState(baseUrl, token).catch(() => null);
    const strays = scenarioEnd ? diffSnapshots(scenarioStart, scenarioEnd).created : [];
    for (const id of new Set([...seeded, ...(scenario.cleanupIds || []), ...strays])) {
      await deleteManifest(baseUrl, token, id).catch(() => {});
    }
  }

  return {
    name: scenario.name,
    passed: turnResults.every(t => t.findings.length === 0) && turnResults.length === scenario.turns.length,
    turns: turnResults,
  };
}

module.exports = { runScenario };
