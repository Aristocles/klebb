#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/run.js — drive the Klebbius scenario corpus against an instance
// with a REAL model behind it and report pass rates. These are
// evaluations, not CI tests: the model is probabilistic, so scenarios run
// N times and the report shows rates, never a single red/green.
//
// Modes:
//   Self-spawned sandbox (needs CHAT_ENDPOINT_URL/CHAT_API_KEY/CHAT_MODEL
//   in the environment, e.g. pointed at a LiteLLM gateway):
//     node evals/run.js
//   Remote instance (tool capture needs --log-cmd tailing that instance's
//   HEALTH_DEBUG=1 output; omit it to run reply/chip/state checks only):
//     node evals/run.js --base-url https://name.example.com --token <AGENT_API_TOKEN> \
//       [--log-cmd "ssh host 'docker logs -f --tail 0 klebb-name'"]
//
// Options:
//   --reps N          repetitions per scenario (default 3)
//   --only <substr>   run only scenarios whose name contains substr
//   --model <name>    model for the cost estimate; also sets CHAT_MODEL in
//                     sandbox mode (default sonnet-5). In remote mode the
//                     instance's own config picks the model; this only labels
//                     the estimate.
//   --yes, -y         skip the pre-run cost confirmation prompt (automation)
//   --out <file>      write the full JSON report here
//   --list            print scenario names and exit
//
// Before a run above a small cost threshold, the runner prints an estimate and
// waits for a y/N confirmation (a real model answers, so a full run costs real
// money). A single-scenario smoke runs without prompting.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScenario } = require('./lib/scenario');
const { createLogCollector } = require('./lib/toollog');
const { estimateRun, needsConfirm, formatEstimate, DEFAULT_MODEL } = require('./lib/cost');

const SCENARIOS = [
  ...require('./scenarios/happy'),
  ...require('./scenarios/features'),
  ...require('./scenarios/adversarial'),
];

function parseArgs(argv) {
  const args = { reps: 3, only: null, baseUrl: null, token: null, logCmd: null, out: null, list: false, model: DEFAULT_MODEL, yes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reps') args.reps = parseInt(argv[++i], 10);
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--base-url') args.baseUrl = argv[++i].replace(/\/$/, '');
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--log-cmd') args.logCmd = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--list') args.list = true;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--yes' || a === '-y') args.yes = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

// Block on a y/N prompt on the controlling TTY. Returns true only on an
// explicit 'y'/'yes'. Any non-interactive stdin (piped, no TTY) returns false
// so an unattended run never spends without --yes.
function confirmPrompt(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(false); return; }
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(/^\s*y(es)?\s*$/i.test(String(d)));
    });
    process.stdin.resume();
  });
}

// Spawn a sandboxed server with HEALTH_DEBUG=1, reusing the gateway config
// from the calling environment. Mirrors tests/helpers/sandbox.js but keeps
// the real CHAT_* env (that's the point: a real model answers). `model`
// overrides CHAT_MODEL so the runner's --model flag actually picks what the
// sandbox agent talks to (remote-instance mode can't: the instance owns that).
async function spawnSandbox(model) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-eval-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 'eval-agent-token-' + Math.random().toString(36).slice(2);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      HEALTH_HOME: root,
      PORT: String(port),
      HOST: '127.0.0.1',
      HEALTH_ORIGIN: `http://127.0.0.1:${port}`,
      HEALTH_RP_ID: '127.0.0.1',
      AGENT_API_TOKEN: token,
      HEALTH_DEBUG: '1',
      HEALTH_HOME_WARNED: '1',
      KLEBB_SKIP_HOME_ENV: '1',
      SESSION_SECRET: 'eval-' + Math.random().toString(36).slice(2),
      ...(model ? { CHAT_MODEL: model } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collector = createLogCollector();
  proc.stdout.on('data', c => collector.feed(c));
  proc.stderr.on('data', c => collector.feed(c));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) { proc.kill(); throw new Error('sandbox server did not start'); }
    await new Promise(r => setTimeout(r, 200));
  }
  return {
    baseUrl, token, collector,
    kill: () => { try { proc.kill(); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}

// Attach a log-follower subprocess (docker logs -f / journalctl -f over
// ssh) whose output feeds the collector. Best-effort: if it dies, tool
// assertions degrade to "no tools observed".
function attachLogCmd(cmd, collector) {
  const proc = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', c => collector.feed(c));
  proc.stderr.on('data', c => collector.feed(c));
  return () => { try { proc.kill(); } catch {} };
}

async function main() {
  const args = parseArgs(process.argv);
  let list = SCENARIOS;
  if (args.only) list = list.filter(s => s.name.includes(args.only));
  if (args.list) { list.forEach(s => console.log(s.name)); return; }
  if (list.length === 0) { console.error('no scenarios matched'); process.exit(2); }

  // Spend gate: the corpus drives a real model, so show the estimated cost and
  // require confirmation before anything spins up. A small smoke run (below the
  // threshold) proceeds silently; a full run must be confirmed or pass --yes.
  const est = estimateRun(list, args.reps, args.model);
  console.log(formatEstimate(est, { remote: !!args.baseUrl }));
  if (needsConfirm(est) && !args.yes) {
    const ok = await confirmPrompt('Proceed with this run? [y/N] ');
    if (!ok) { console.log('aborted (no spend). Pass --yes to skip this prompt.'); process.exit(3); }
  }

  let target, cleanup = () => {};
  let collector = null;
  if (args.baseUrl) {
    if (!args.token) { console.error('--base-url needs --token'); process.exit(2); }
    if (args.logCmd) {
      collector = createLogCollector();
      const stop = attachLogCmd(args.logCmd, collector);
      cleanup = stop;
      await new Promise(r => setTimeout(r, 1500));
    } else {
      console.log('NOTE: no --log-cmd; tool-call assertions are skipped (reply/chip/state checks still run)');
    }
    target = { baseUrl: args.baseUrl, token: args.token, collector };
  } else {
    if (!process.env.CHAT_ENDPOINT_URL || !process.env.CHAT_API_KEY) {
      console.error('sandbox mode needs CHAT_ENDPOINT_URL + CHAT_API_KEY (+ CHAT_MODEL) in the environment');
      process.exit(2);
    }
    const sandbox = await spawnSandbox(args.model);
    target = sandbox;
    collector = sandbox.collector;
    cleanup = sandbox.kill;
  }

  // When there is no tool-log source, strip tool expectations so scenarios
  // degrade gracefully instead of failing on "required tool not observed".
  const stripTools = !collector;
  const report = { startedAt: new Date().toISOString(), target: args.baseUrl || 'sandbox', reps: args.reps, scenarios: [] };

  for (const scenario of list) {
    const runs = [];
    console.log(`\n=== ${scenario.name} (${args.reps} rep${args.reps === 1 ? '' : 's'}) ===`);
    const effective = stripTools
      ? { ...scenario, turns: scenario.turns.map(t => ({ ...t, expect: { ...t.expect, tools: undefined } })) }
      : scenario;
    for (let rep = 0; rep < args.reps; rep++) {
      try {
        const result = await runScenario(effective, { ...target, collector, log: m => console.log(m) });
        runs.push(result);
        console.log(`  rep ${rep + 1}: ${result.passed ? 'PASS' : 'FAIL'}`);
      } catch (e) {
        runs.push({ name: scenario.name, passed: false, turns: [], error: e.message });
        console.log(`  rep ${rep + 1}: ERROR ${e.message}`);
      }
    }
    const passes = runs.filter(r => r.passed).length;
    report.scenarios.push({ name: scenario.name, passRate: `${passes}/${args.reps}`, passes, reps: args.reps, runs });
  }

  console.log('\n================ PASS RATES ================');
  let sound = true;
  for (const s of report.scenarios) {
    console.log(`${s.passRate.padStart(5)}  ${s.name}`);
    if (s.passes < s.reps) sound = false;
  }
  console.log('============================================');

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`full report: ${args.out}`);
  }
  cleanup();
  process.exit(sound ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
