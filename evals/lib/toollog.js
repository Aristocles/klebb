// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/lib/toollog.js — parse the HEALTH_DEBUG=1 chat forensic lines into
// structured tool-call records. Works on any stream of log text: a spawned
// server's stdout, `docker logs`, or journald output.
//
// Line shapes (see chatLog call sites in server.js):
//   [chat:ab12cd] start turns=3 voice=false
//   [chat:ab12cd] tool create_manifest id=sleep-log took=12ms ok
//   [chat:ab12cd] tool patch_manifest id=weight took=3ms err
//   [chat:ab12cd] done total=8123ms iters=3 capped=false

const { spawn } = require('child_process');

const TOOL_RE = /\[chat:([0-9a-f]+)\] tool (\S+) id=(\S+) took=(\d+)ms (ok|err)/;
const START_RE = /\[chat:([0-9a-f]+)\] start /;
const DONE_RE = /\[chat:([0-9a-f]+)\] done total=(\d+)ms iters=(\d+) capped=(\w+)/;

// Parse a blob of log text into per-request records:
//   { reqId, tools: [{name, manifestId, ms, ok}], totalMs, iters, capped }
function parseChatLog(text) {
  const requests = new Map();
  const ensure = (reqId) => {
    if (!requests.has(reqId)) requests.set(reqId, { reqId, tools: [], totalMs: null, iters: null, capped: null });
    return requests.get(reqId);
  };
  for (const line of String(text).split('\n')) {
    let m = line.match(TOOL_RE);
    if (m) {
      ensure(m[1]).tools.push({ name: m[2], manifestId: m[3] === '-' ? null : m[3], ms: Number(m[4]), ok: m[5] === 'ok' });
      continue;
    }
    m = line.match(START_RE);
    if (m) { ensure(m[1]); continue; }
    m = line.match(DONE_RE);
    if (m) {
      const r = ensure(m[1]);
      r.totalMs = Number(m[2]);
      r.iters = Number(m[3]);
      r.capped = m[4] === 'true';
    }
  }
  return [...requests.values()];
}

// Collector over an incremental text source: call feed(chunk) as output
// arrives, then sinceMark() returns only requests whose lines appeared
// after the last mark() call. Lets the runner attribute tool calls to the
// specific chat turn it just sent.
function createLogCollector() {
  let buffer = '';
  let markOffset = 0;
  return {
    feed(chunk) { buffer += String(chunk); },
    mark() { markOffset = buffer.length; },
    sinceMark() { return parseChatLog(buffer.slice(markOffset)); },
    all() { return parseChatLog(buffer); },
  };
}

// Attach a log-follower subprocess (docker logs -f / journalctl -f over
// ssh) whose output feeds the collector. A follower that starts then dies
// mid-run must NOT silently degrade to "no tools observed": that reads as
// a tool regression on required-tools scenarios and a vacuous pass on
// forbidden-tools ones (#503). captureAlive() lets the runner mark turns
// INCONCLUSIVE the moment the follower is gone.
function attachLogCmd(cmd, collector) {
  const proc = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', c => collector.feed(c));
  proc.stderr.on('data', c => collector.feed(c));
  let alive = true;
  proc.on('exit', () => { alive = false; });
  proc.on('error', () => { alive = false; });
  return {
    stop: () => { try { proc.kill(); } catch {} },
    captureAlive: () => alive,
  };
}

module.exports = { parseChatLog, createLogCollector, attachLogCmd };
