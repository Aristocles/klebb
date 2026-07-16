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

const { chatTurn, snapshotState, deleteManifest, createManifest, fetchData } = require('./driver');
const { diffSnapshots } = require('./diff');
const { evalTurn } = require('./assert');

// The set of card ids a scenario asserts data on: every seed + cleanup id,
// plus every non-'$created' id named in any turn's cardShape. '$created' is
// resolved per-turn (its id emerges from the diff), so it's excluded here.
function collectDataIds(scenario) {
  const ids = new Set([...(scenario.seeds || []).map(s => s.meta.id), ...(scenario.cleanupIds || [])]);
  for (const turn of scenario.turns || []) {
    const shape = turn.expect && turn.expect.cardShape;
    if (!shape) continue;
    for (const key of Object.keys(shape)) {
      if (key !== '$created') ids.add(key);
    }
  }
  return [...ids];
}

function turnUsesCreated(turn) {
  return !!(turn.expect && turn.expect.cardShape && turn.expect.cardShape.$created);
}

// Tool evidence is unreliable when a turn asserts on tools but the capture
// source died mid-run: required-tools read as false regressions and
// forbidden-tools pass vacuously. Such turns are INCONCLUSIVE — neither
// direction of the tool findings can be trusted (#503). Reply/chip/state
// assertions are unaffected: they come from HTTP, not the log follower.
function toolCaptureUnreliable(expect, captureAlive) {
  return !!(expect && expect.tools) && typeof captureAlive === 'function' && !captureAlive();
}

async function runScenario(scenario, { baseUrl, token, collector, captureAlive, log = () => {} }) {
  const seeded = [];
  const turnResults = [];
  let inconclusive = false;
  let history = [];
  let lastFollowup = null;
  // Only fetch data for the cards this scenario actually asserts on. Bounds
  // the snapshot's request count to a small constant so a full corpus run
  // stays under the instance's per-IP rate limit. Ids named in a turn's
  // cardShape plus every seeded/cleanup id; '$created' is unknown until the
  // turn runs, so created cards are folded in at snapshot time below.
  const dataIds = collectDataIds(scenario);
  const scenarioStart = await snapshotState(baseUrl, token, dataIds);

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

      const before = await snapshotState(baseUrl, token, dataIds);
      if (collector) collector.mark();

      history.push({ role: 'user', content: userText });
      const res = await chatTurn(baseUrl, token, history, { viewedCardId: turn.viewedCardId });
      history.push({ role: 'assistant', content: res.reply });
      lastFollowup = res.followup;

      // Tool lines are written when the loop finishes, but give the log
      // pipe a beat to flush before reading.
      await new Promise(r => setTimeout(r, 500));
      const after = await snapshotState(baseUrl, token, dataIds);
      const requests = collector ? collector.sinceMark() : [];
      const tools = requests.flatMap(r => r.tools);
      const diff = diffSnapshots(before, after);

      // A '$created' cardShape needs the just-created card's data, but its id
      // isn't knowable until the diff exists. Fetch data for cards created
      // this turn and merge it in (usually one card).
      if (turnUsesCreated(turn) && diff.created.length) {
        await Promise.all(diff.created.map(async (id) => {
          if (after.cards[id] && after.cards[id].data === undefined) {
            after.cards[id].data = await fetchData(baseUrl, token, id).catch(() => undefined);
          }
        }));
      }

      // Dead capture + tool expectations = untrustworthy either way. Strip
      // the tool block so its findings can't fire, and mark the run
      // inconclusive instead of letting it read as PASS or FAIL.
      const captureDead = toolCaptureUnreliable(turn.expect, captureAlive);
      if (captureDead) inconclusive = true;
      const effectiveExpect = captureDead
        ? { ...turn.expect, tools: undefined }
        : turn.expect;

      const findings = evalTurn(effectiveExpect, {
        reply: res.reply,
        followup: res.followup,
        status: res.status,
        tools,
        diff,
        snapshot: after,
        registryErrors: after.errors,
      });

      // Engagement guard: a live model always produces SOMETHING (reply text
      // or a tool call). A turn with neither means the model never ran (gateway
      // down, budget exhausted, timeout) — the request came back empty. Without
      // this, a negative-assertion scenario ("must NOT write / must NOT delete")
      // passes vacuously on a dead gateway: no model, no write, "pass". Flag it
      // as a finding so the failure is loud, not silent.
      if (!res.reply.trim() && tools.length === 0) {
        findings.unshift(`engagement: model produced no reply and no tool call (status ${res.status}, ${res.ms}ms) — gateway down / budget exhausted / timed out, not a real turn`);
      }
      turnResults.push({
        turn: i,
        say: userText.slice(0, 80),
        findings,
        captureDead,
        facts: {
          replyPreview: res.reply.slice(0, 200),
          tools: tools.map(t => `${t.name}(${t.manifestId || ''})${t.ok ? '' : '!ERR'}`),
          diff,
          chips: ((res.followup || {}).embellishments || []).map(o => o.label),
          ms: res.ms,
        },
      });
      const verdict = findings.length ? 'FAIL ' + findings.join('; ')
        : captureDead ? 'ok (INCONCLUSIVE: tool capture dead, tool assertions skipped)'
        : 'ok';
      log(`  turn ${i}: ${verdict} (${res.ms}ms, tools: ${tools.map(t => t.name).join(',') || 'none'})`);
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
    inconclusive,
    turns: turnResults,
  };
}

module.exports = { runScenario, toolCaptureUnreliable };
