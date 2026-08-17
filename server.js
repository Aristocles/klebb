// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// Fail fast on an unsupported Node before anything opens the datastore.
require('./lib/node-floor').assertNodeFloor();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');
const { isAuthenticated, isAgentRequest, isPublicPath, handleAuthRoutes, isSetup, listCredentialsForUser, deleteCredentialForUser, getSessionRecord } = require('./auth/webauthn');
const { handleAdminRoutes } = require('./auth/admin-api');
const invites = require('./auth/invites');
const PATHS = require('./config/paths');
const ENV = require('./config/env');
const registry = require('./manifests/registry');
const { convertDateKeyedToArray } = require('./scripts/migrate-date-keyed-to-array');
const { runFirstBoot } = require('./server/first-boot');
const { listTemplates, listPrompts, instantiateTemplate } = require('./server/content');
const voice = require('./voice/fish');
const voiceCache = require('./voice/cache');
const { transcodeToWav } = require('./voice/transcode');
const { sanitiseForTts } = require('./voice/sanitise-for-tts');
const { TOOL_DEFS, dispatchToolCall } = require('./chat/tools');
const { pickEmbellishments } = require('./chat/embellish');
const { buildDateContextBlock } = require('./chat/date-context');
const hae = require('./health-auto-export/ingest');
const haeDiagnostics = require('./health-auto-export/diagnostics');
const haeDiscoveries = require('./health-auto-export/discoveries');
const haeTokenStore = require('./health-auto-export/token-store');
const haeSamples = require('./health-auto-export/samples');
const haeSamplesInbox = require('./health-auto-export/samples-inbox');
const conversationsLib = require('./lib/conversations');
const { generateTitle } = require('./chat/title');

// Opened on first use: an instance whose user never opens the chat pays
// nothing. Holds its own handle on the shared database file (the samples
// store set the precedent), so shutdown must close it for the WAL
// checkpoint.
let _conversationsStore = null;
function conversationsStore() {
  if (!_conversationsStore) _conversationsStore = conversationsLib.open();
  return _conversationsStore;
}
const haeQuarantine = require('./health-auto-export/quarantine');
const { describeCatalogue: describeHaeCatalogue } = require('./health-auto-export/describe');
const userTz = require('./lib/user-tz');
const feedback = require('./lib/feedback');
const { originAllowed } = require('./lib/origin-check');
const { ambientStaleness } = require('./chat/hygiene');
const { orphanReport } = require('./lib/datastore/fields');
const hygieneState = require('./lib/hygiene-state');
const notificationsState = require('./lib/notifications-state');
const notificationsScheduler = require('./lib/notifications-scheduler');
const webPushSend = require('./lib/web-push-send');
const notificationRoutes = require('./routes/notifications');
const dataRoutes = require('./routes/data');
const importFreeze = require('./lib/import/freeze');
const { recoverAtBoot } = require('./lib/import/recover');
const { CATEGORIES: MANIFEST_CATEGORIES } = require('./config/categories');
const ccSuggestions = require('./meta/cc-suggestions');
const { describeCcSchema } = require('./chat/describe-cc-schema');
const { describeDocsCatalogue } = require('./chat/docs');
const { describeReportsCatalogue } = require('./chat/reports');
const inbox = require('./ingest/pipeline');
const gateway = require('./lib/gateway');
const { callGateway } = gateway;
const catalogue = require('./ingest/catalogue');
const reportsApi = require('./lib/reports-api');
const { ALLOWED_UPLOAD_EXTS } = require('./ingest/extract');
const { sanitiseStem } = require('./ingest/writeReport');
const { nextPsm } = require('./ingest/extractors/image');

// chat endpoint config (env-driven; see config/env.js). The key and model are
// read by lib/gateway.js, which owns the transport.
const CHAT_ENDPOINT_URL = ENV.CHAT_ENDPOINT_URL;
const DEBUG_LOG = ENV.DEBUG_LOG;
const CHAT_ITER_TIMEOUT_MS = ENV.CHAT_ITER_TIMEOUT_MS;
const CHAT_MAX_TURNS = ENV.CHAT_MAX_TURNS;
const CHAT_TURN_DEADLINE_MS = ENV.CHAT_TURN_DEADLINE_MS;
// The per-step timeout names its real cause. The old wording claimed the
// request "doesn't fit any of the tools I have", which taught users a
// capability was missing when the truth was a slow step (#600).
const STEP_TIMEOUT_MESSAGE =
  'One step of that took too long to come back, so I stopped rather than leave you waiting. A narrower request usually completes: one card at a time, or a specific slice of rows.';
// Shown when the loop runs out of turn budget having produced no text of
// its own. "Keep going" is literal: the client resends the transcript, so
// the model picks the work back up from what the history shows done.
const CAPPED_FALLBACK_MESSAGE =
  'I got partway through but ran out of steps for this turn. Say "keep going" and I\'ll pick up where I stopped.';
// Appended to partial progress on a capped turn, so finished work is kept
// and the stop is explained instead of silently swallowed.
const CAPPED_SUFFIX =
  '\n\nI had to stop there: that was as many steps as one turn allows. Say "keep going" to continue.';

// Four gateway conditions used to collapse into the single string 'No response'
// (klebb#547), so an exhausted allowance, a dead gateway, a timeout and a
// genuinely empty reply all read as the app being broken. Each now says
// something true and distinct.
//
// The allowance message deliberately states the window generically. The budget
// is a rolling period the webapp has no field for, and naming a date it cannot
// know would be a confident lie; "this month's" is true without inventing one.
// It also avoids apologising: a limit being reached is not a fault.
const CHAT_BUDGET_MESSAGE =
  "This month's AI allowance is used up, so chat is paused until it resets. Everything else in your dashboard works as normal.";
// The real "the model said nothing" case, which should be rare. Distinct from a
// transport failure so a genuinely empty reply is not read as an outage.
const EMPTY_REPLY_MESSAGE =
  'No answer came back for that one. Try rephrasing the question.';

// Forensic logging for the chat agent loop. Off by default; flip on with
// HEALTH_DEBUG=1. Emits structural facts only (durations, counts, tool
// names, manifest ids) so a journal grep can reconstruct a stuck turn
// without exposing prompt or reply bodies.
function chatLog(reqId, ...parts) {
  if (DEBUG_LOG) console.log(`[chat:${reqId}]`, ...parts);
}
// Kept as a local truthiness flag for the "chat configured?" checks below;
// the transport details now live in lib/gateway.js.
const CHAT_ENDPOINT = CHAT_ENDPOINT_URL ? gateway.parseEndpoint(CHAT_ENDPOINT_URL) : null;

const HEALTH_SYSTEM_PROMPT = ENV.HEALTH_SYSTEM_PROMPT;


const PORT = ENV.PORT;
const HOST = ENV.HOST;
const DATA_DIR = PATHS.DATA_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORTS_DIR = PATHS.REPORTS_DIR;

// Ensure writable dirs exist
PATHS.ensureWritableDirs();

// One-shot migration: if the legacy HEALTH_AUTO_EXPORT_TOKEN env var is
// set and config.json has no token yet, copy it across so existing
// instances upgrade transparently. Runs before the HTTP listener so the
// token store is consistent the moment the server accepts requests.
try {
  haeTokenStore.migrateFromEnvIfNeeded();
} catch (e) {
  console.warn('[hae] token migration error (continuing):', e.message);
}

// Configure marked for GFM (tables, etc.)
marked.setOptions({ gfm: true, breaks: true });

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// Minimum CSP for /index.html. Push provider connect-src entries unblock
// pushManager.subscribe + the SW's eventual push fetches; esm.sh stays in
// script-src because Lit imports load directly from there at runtime.
// 'unsafe-inline' for styles is required for Lit's render path; the
// inline FOUC-prevention <script> in index.html is the only inline script
// and is whitelisted by 'self' (not 'unsafe-inline').
const CSP_INDEX = [
  "default-src 'self'",
  "worker-src 'self'",
  "script-src 'self' https://esm.sh 'unsafe-inline'",
  "connect-src 'self' https://*.googleapis.com https://*.push.services.mozilla.com https://web.push.apple.com",
  "manifest-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Per-path header overrides applied on top of the static handler's
// default Content-Type. Returns the headers object (possibly empty).
// Exact-path match only — no substring or suffix logic, so a future
// upload at /data/foo-sw.js cannot inherit SW-only policy.
function staticHeadersFor(pathname) {
  const headers = {};
  if (pathname === '/sw.js' || pathname === '/manifest.json' || pathname === '/manifest.webmanifest') {
    headers['Cache-Control'] = 'no-cache';
  }
  if (pathname === '/manifest.json') {
    // Override the default application/json MIME so browsers parse the
    // file with relaxed manifest-format expectations (some older Edge
    // builds nag if Content-Type isn't application/manifest+json).
    headers['Content-Type'] = 'application/manifest+json';
  }
  if (pathname === '/' || pathname === '/index.html') {
    headers['Content-Security-Policy'] = CSP_INDEX;
  }
  return headers;
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function send404(res, msg = 'Not found') {
  sendJSON(res, { error: msg }, 404);
}

// Server-sent events writer for /api/chat streaming. Named events, one JSON
// data line each, a heartbeat comment so intermediaries do not buffer or
// idle-close the stream, and X-Accel-Buffering for the nginx some deploys
// put in front. Every write is guarded: a client that vanished mid-turn (a
// backgrounded phone) must never crash the agent loop, which is allowed to
// run to completion against a dead socket exactly like the buffered path.
function startEventStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': stream open\n\n');
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, 15000);
  return {
    send(event, data, id) {
      if (res.writableEnded || res.destroyed) return false;
      const idLine = Number.isInteger(id) ? `id: ${id}\n` : '';
      res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
      return true;
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end();
    },
  };
}

// === Detached chat turns (#602) ===
// A conversation turn runs as a server-side job that survives its client:
// iOS suspends a backgrounded tab and aborts its fetches, and without this
// the reply of an in-flight turn had nowhere to go. Every event is
// buffered per turn with an id, fanned out to each attached event stream,
// and replayable from any point, so a client that comes back mid-turn
// resumes exactly where it dropped; the reply itself is persisted to the
// conversation by the normal path whether anyone is listening or not.
// Completed turns linger briefly so a client that missed `done` can still
// replay, then evaporate; the durable copy is the conversation.
const TURN_EVENT_CAP = 5000;
const TURN_LINGER_MS = 30000;
const _activeTurns = new Map(); // conversationId -> hub

function createTurnHub(conversationId) {
  const hub = {
    seq: 0,
    firstKept: 1,
    events: [],
    listeners: new Set(),
    done: false,
    // Set by DELETE /api/chat/turn/:id; the loop checks it between
    // round-trips and between tool calls, so a stop lands at the next
    // checkpoint rather than mid-write.
    aborted: false,
    abort() { hub.aborted = true; },
    emit(event, data) {
      hub.seq += 1;
      hub.events.push({ id: hub.seq, event, data });
      if (hub.events.length > TURN_EVENT_CAP) {
        hub.events.shift();
        hub.firstKept = hub.events[0].id;
      }
      for (const es of [...hub.listeners]) {
        if (!es.send(event, data, hub.seq)) hub.listeners.delete(es);
      }
      return true;
    },
    attach(es, afterId = 0) {
      // A replay that lost its head to the event cap starts with a reset,
      // so the client drops provisional text before the surviving tail.
      if (afterId < hub.firstKept - 1) es.send('reset', {}, hub.firstKept - 1);
      for (const ev of hub.events) {
        if (ev.id > afterId) es.send(ev.event, ev.data, ev.id);
      }
      if (hub.done) return es.end();
      hub.listeners.add(es);
    },
    finish() {
      hub.done = true;
      for (const es of [...hub.listeners]) es.end();
      hub.listeners.clear();
      const t = setTimeout(() => {
        if (_activeTurns.get(conversationId) === hub) _activeTurns.delete(conversationId);
      }, TURN_LINGER_MS);
      if (typeof t.unref === 'function') t.unref();
    },
  };
  _activeTurns.set(conversationId, hub);
  return hub;
}

// Server-local "today" in the configured TZ (Node already honours process.env.TZ,
// so this uses the server's clock and timezone).
function todayIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: ENV.TZ });
}

// Given the previously stored data array and an incoming one, decide whether
// any newly-added or newly-dated row violates the manifest's
// todayAllowed / pastAllowed / futureAllowed flags. Returns an error string
// for the first violation found, or null if the write is acceptable.
//
// Semantics: a date is "new" if no prior row had that date. This catches
// both additions and date-migrations; it does not block edits to existing
// dated entries (e.g. fixing a typo on yesterday's weight stays permitted
// regardless of pastAllowed), which matches how the UI exposes edits.
function findDateAllowanceViolation(prevData, nextData, writeable) {
  const prevDates = new Set(
    (Array.isArray(prevData) ? prevData : [])
      .map(r => r && r.date)
      .filter(d => typeof d === 'string')
  );
  const today = todayIso();
  const todayAllowed  = writeable.todayAllowed !== false; // default true
  const pastAllowed   = writeable.pastAllowed === true;
  const futureAllowed = writeable.futureAllowed === true;
  for (const row of nextData) {
    const d = row && row.date;
    if (typeof d !== 'string' || prevDates.has(d)) continue;
    if (d > today && !futureAllowed) return `future-dated entry (${d}) not allowed for this card`;
    if (d < today && !pastAllowed)   return `past-dated entry (${d}) not allowed for this card`;
    if (d === today && !todayAllowed) return `today-dated entry (${d}) not allowed for this card`;
  }
  return null;
}

function readJSONFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listDatesInDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch {
    return [];
  }
}

function getDateRange(dir, start, end) {
  const result = {};
  const dates = listDatesInDir(dir);
  for (const date of dates) {
    if (date >= start && date <= end) {
      const data = readJSONFile(path.join(dir, `${date}.json`));
      if (data) result[date] = data;
    }
  }
  return result;
}

// Extract a { speak, display } JSON object from a model's raw reply.
// The model is instructed to emit pure JSON, but handle stray text/fences +
// tool-use intermixing by grabbing the LAST JSON object in the response
// (that one is always the final answer).
function extractJsonReply(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip common markdown fences
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Try direct parse first (common case: clean JSON reply)
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') return obj;
  } catch {}
  // Find all {...} blocks and try each from last to first.
  // Walk the string and track brace depth to extract balanced objects.
  const candidates = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Try from last to first (the final answer is usually last)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && typeof obj === 'object' && (typeof obj.speak === 'string' || typeof obj.display === 'string')) {
        return obj;
      }
    } catch {}
  }
  return null;
}

// callGateway now lives in lib/gateway.js so the report comprehension pass
// can reach the gateway from ingest/ without requiring this file back.
// Unchanged in behaviour, including the load-bearing error-string prefixes the
// /api/chat catch below matches on.

// Context window for conversation-aware turns: the newest stored messages
// that fit a character budget (characters are a good-enough token proxy at
// this scale). Bounds per-turn gateway cost, which otherwise grows linearly
// with conversation length; the model re-reads older state through its
// tools when it genuinely needs it. The newest message always goes through,
// however large.
const CHAT_CONTEXT_CHAR_BUDGET = 24000;
function windowTranscript(stored) {
  const out = [];
  let used = 0;
  for (let i = stored.length - 1; i >= 0; i--) {
    const m = stored[i];
    const len = (m.content || '').length;
    if (out.length && used + len > CHAT_CONTEXT_CHAR_BUDGET) break;
    out.unshift({ role: m.role, content: m.content });
    used += len;
  }
  return out;
}

// Run the OpenAI-compatible tool-calling loop. Each iteration:
//   1. call the gateway with current messages (+ TOOL_DEFS)
//   2. if finish_reason is 'tool_calls', execute each tool_call, append the
//      assistant turn and one {role:"tool"} per call, loop.
//   3. otherwise, return the assistant's text as the final reply.
// Caps at CHAT_MAX_TURNS round-trips to keep a misbehaving model from
// looping forever, and at CHAT_TURN_DEADLINE_MS of wall clock so a raised
// cap cannot stack per-iteration timeouts into a multi-minute silent
// spinner. Either budget running out returns the last text we saw (or a
// fallback) with cappedOut set; the caller tells the user how to resume.
//
// `emit(event, data)` reports live progress (status/token/reset events for
// the SSE path); it defaults to a no-op so the buffered path pays nothing.
// `streamTokens` forwards the model's content fragments as `token` events:
// off in voice mode, whose reply is a JSON envelope no one should watch
// being typed. A tokened iteration that turns out to end in tool calls
// emits `reset` so the client can drop the provisional text.
async function runAgentLoop({ systemPrompt, userMessages, reqId = '-', emit = () => {}, streamTokens = false, shouldAbort = () => false }) {
  const MAX_ITERS = CHAT_MAX_TURNS;
  const deadline = CHAT_TURN_DEADLINE_MS;
  const loopStart = Date.now();
  const messages = [{ role: 'system', content: systemPrompt }, ...userMessages];
  const ctx = { touches: [] };
  let lastAssistantText = '';
  let deadlined = false;
  let itersDone = 0;
  for (let i = 0; i < MAX_ITERS; i++) {
    if (shouldAbort()) {
      chatLog(reqId, `iter=${i} aborted`);
      return { finalText: '', cappedOut: false, aborted: true, ctx, iters: itersDone };
    }
    const elapsed = Date.now() - loopStart;
    if (deadline && elapsed >= deadline) {
      deadlined = true;
      break;
    }
    // Shrink the per-step budget to what is left of the turn, so one slow
    // step cannot blow through the deadline it sits inside.
    let iterBudget = CHAT_ITER_TIMEOUT_MS;
    if (deadline) {
      const remaining = deadline - elapsed;
      iterBudget = iterBudget ? Math.min(iterBudget, remaining) : remaining;
    }
    emit('status', { phase: 'thinking' });
    let tokensThisIter = false;
    const gwStart = Date.now();
    let gw;
    try {
      gw = await callGateway({
        messages,
        tools: TOOL_DEFS,
        timeoutMs: iterBudget,
        stream: streamTokens,
        onDelta: streamTokens
          ? ({ content }) => { if (content) { tokensThisIter = true; emit('token', { text: content }); } }
          : undefined,
      });
      itersDone = i + 1;
    } catch (e) {
      if (e && e.message === 'gateway_iter_timeout') {
        const gwMs = Date.now() - gwStart;
        // A step cut short by the turn deadline is budget exhaustion, not a
        // slow step: report it as capped so the user resumes instead of
        // narrowing a request that was fine.
        if (deadline && Date.now() - loopStart >= deadline) {
          chatLog(reqId, `iter=${i} gw=${gwMs}ms deadline`);
          deadlined = true;
          break;
        }
        chatLog(reqId, `iter=${i} gw=${gwMs}ms iter_timeout`);
        return {
          finalText: STEP_TIMEOUT_MESSAGE,
          cappedOut: false,
          iterTimedOut: true,
          ctx,
          iters: i + 1,
        };
      }
      throw e;
    }
    const gwMs = Date.now() - gwStart;
    const choice = gw.choices?.[0];
    const msg = choice?.message || {};
    const finish = choice?.finish_reason;
    const toolCount = Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0;
    // Token and cache counters per step, so a prompt-caching change can be
    // proved rather than assumed. Cache writes cost more than uncached input,
    // so a change that lands with a zero hit rate makes the bill go up; without
    // these numbers that is invisible. `usage=none` stays distinct from a row
    // of zeroes on purpose: a gateway reporting nothing and a gateway reporting
    // a genuine zero hit rate are different faults with different fixes.
    const usage = gateway.readUsage(gw);
    const usageBits = usage
      ? `in=${usage.promptTokens} out=${usage.completionTokens}`
        + ` cached=${usage.cachedTokens} cwrite=${usage.cacheWriteTokens}`
        + (usage.cost === null ? '' : ` cost=${usage.cost}`)
      : 'usage=none';
    chatLog(reqId, `iter=${i} gw=${gwMs}ms finish=${finish || '-'} tools=${toolCount} ${usageBits}`);

    if (typeof msg.content === 'string' && msg.content.trim()) {
      lastAssistantText = msg.content;
    }

    if (finish === 'tool_calls' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      // Content fragments already forwarded this iteration were commentary
      // ahead of tool calls, not the final answer: tell the client to drop
      // the provisional text before tool statuses replace it.
      if (tokensThisIter) emit('reset', {});
      // Preserve tool_calls on the round-trip; your provider rejects the
      // next turn if the assistant message is missing them.
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls,
      });
      for (const tc of msg.tool_calls) {
        if (shouldAbort()) {
          chatLog(reqId, `iter=${i} aborted mid-tools`);
          return { finalText: '', cappedOut: false, aborted: true, ctx, iters: itersDone };
        }
        const name = tc.function?.name || '-';
        let manifestId = '-';
        try {
          const args = JSON.parse(tc.function?.arguments || '{}');
          manifestId = args.id || args.manifest?.meta?.id || '-';
        } catch {}
        emit('status', { phase: 'tool', tool: name, ...(manifestId !== '-' ? { id: manifestId } : {}) });
        const tStart = Date.now();
        const result = dispatchToolCall(tc, ctx);
        const tMs = Date.now() - tStart;
        const ok = !/"error"\s*:/.test(result);
        chatLog(reqId, `tool ${name} id=${manifestId} took=${tMs}ms ${ok ? 'ok' : 'err'}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name,
          content: result,
        });
      }
      continue;
    }

    return { finalText: msg.content || lastAssistantText || '', cappedOut: false, ctx, iters: i + 1 };
  }
  return {
    finalText: lastAssistantText,
    cappedOut: true,
    deadlined,
    ctx,
    iters: itersDone,
  };
}

// Given the post-loop ctx, build a `followup` object for the chat
// response if the agent touched a manifest this turn. Returns null when
// no manifest was touched, the touched manifest no longer exists, or
// the picker has nothing eligible to offer. The last touch wins: if a
// turn created one card and patched another, we offer chips on the more
// recent operation.
function buildFollowup(ctx) {
  if (!ctx || !Array.isArray(ctx.touches) || ctx.touches.length === 0) return null;
  const last = ctx.touches[ctx.touches.length - 1];
  const entry = registry.get(last.id);
  if (!entry) return null;
  const manifest = { meta: entry.meta, data: entry.data };
  return pickEmbellishments(manifest, { flow: last.flow });
}

function withFollowup(body, followup) {
  return followup ? { ...body, followup } : body;
}

function renderReportPage(title, htmlContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Health Dashboard</title>
<style>
:root {
  --bg: #f5f7fa;
  --text: #1e293b;
  --text-muted: #64748b;
  --heading: #0ea5e9;
  --border: #e2e8f0;
  --code-bg: #e2e8f0;
  --strong: #b45309;
  --em: #475569;
  --link: #0ea5e9;
  --row-even: rgba(226, 232, 240, 0.5);
  --row-hover: rgba(14, 165, 233, 0.08);
  --quote: #64748b;
}
html[data-theme="dark"] {
  --bg: #0f0f1a;
  --text: #e0e0e0;
  --text-muted: #8888aa;
  --heading: #00d4aa;
  --border: #2a2a4a;
  --code-bg: #1a1a2e;
  --strong: #ffaa00;
  --em: #ccccdd;
  --link: #00d4aa;
  --row-even: rgba(26, 26, 46, 0.5);
  --row-hover: rgba(0, 212, 170, 0.08);
  --quote: #8888aa;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --bg: #0f0f1a;
    --text: #e0e0e0;
    --text-muted: #8888aa;
    --heading: #00d4aa;
    --border: #2a2a4a;
    --code-bg: #1a1a2e;
    --strong: #ffaa00;
    --em: #ccccdd;
    --link: #00d4aa;
    --row-even: rgba(26, 26, 46, 0.5);
    --row-hover: rgba(0, 212, 170, 0.08);
    --quote: #8888aa;
  }
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); max-width: 900px; margin: 0 auto; padding: 20px; line-height: 1.7; }
h1, h2, h3, h4 { color: var(--heading); margin-top: 1.5em; }
h1 { border-bottom: 2px solid var(--border); padding-bottom: 10px; }
h2 { border-bottom: 1px solid var(--border); padding-bottom: 6px; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: var(--text); }
pre { background: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; }
pre code { padding: 0; background: none; }
ul, ol { padding-left: 24px; }
li { margin: 4px 0; }
hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
strong { color: var(--strong); }
em { color: var(--em); }
table { width: 100%; border-collapse: collapse; margin: 16px 0; }
th { background: var(--code-bg); color: var(--heading); text-align: left; padding: 10px 12px; border: 1px solid var(--border); font-weight: 600; }
td { padding: 8px 12px; border: 1px solid var(--border); color: var(--text); }
tr:nth-child(even) { background: var(--row-even); }
tr:hover { background: var(--row-hover); }
blockquote { border-left: 3px solid var(--heading); padding-left: 16px; margin: 16px 0; color: var(--quote); }
.back-link { display: inline-block; margin-bottom: 20px; color: var(--text-muted); font-size: 0.9em; }
.back-link:hover { color: var(--heading); }
</style>
<script>
// Respect app theme preference (from localStorage key 'klebb-theme')
(function() {
  try {
    var t = localStorage.getItem('klebb-theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
</script>
</head>
<body>
<a href="/reports" class="back-link">← Back to Reports</a>
${htmlContent}
</body></html>`;
}

function serveStaticFile(res, filePath, extraHeaders = {}) {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    const headers = { 'Content-Type': mime, ...extraHeaders };
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    return false;
  }
  return true;
}

// Set when boot-time import recovery had to give up (lib/import/recover.js
// 'refuse'): neither the staged tree nor the rollback snapshot survived a
// crash mid-apply, so the home is half-applied and must not be served or
// seeded over as if it were truth.
let importRecoveryRefusedReason = null;

// Boot (recovery, seeding, the samples drain, registry init) awaits since
// #632, so the listen callback no longer parks the event loop: a request
// could land mid-boot and see a half-initialised registry. Every request
// except /healthz waits here until boot settles, which is exactly the
// queueing the synchronous boot used to impose; /healthz answers
// immediately, so a long boot drain no longer blinds container
// healthchecks (previously the whole boot blocked them).
let _booting = true;
let _bootSettled = null;
const _bootGate = new Promise(resolve => { _bootSettled = resolve; });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (_booting && pathname !== '/healthz') await _bootGate;

  // === Import write freeze (#617) ===
  // One structural gate at the top of dispatch: while the import pipeline
  // holds the freeze, everything that is not a plain GET answers 503,
  // structural-by-construction so no future mutating route can be forgotten
  // off an allowlist. GET /api/export is ALSO blocked, deliberately: it
  // would zip a mid-wipe tree. Exempt: /healthz (liveness must never lie)
  // and /api/import/* (status/apply/rollback must work mid-job).
  if (importFreeze.frozen() !== null
      && pathname !== '/healthz'
      && !pathname.startsWith('/api/import/')
      && (req.method !== 'GET' || pathname === '/api/export')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'import in progress', code: 'IMPORT_FROZEN' }));
    req.resume();
    return;
  }

  // === Import recovery refusal (#617) ===
  // A refused boot serves nothing that would present the half-applied home
  // as truth: every /api route 503s except import status (see the wreckage)
  // and rollback (the way out, when a snapshot ever reappears). /healthz
  // stays live so the container is reachable rather than flapping.
  if (importRecoveryRefusedReason !== null
      && pathname.startsWith('/api/')
      && pathname !== '/api/import/status'
      && pathname !== '/api/import/rollback') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'an interrupted import could not be recovered at boot; this instance refuses to serve',
      code: 'IMPORT_RECOVERY_FAILED',
      reason: importRecoveryRefusedReason,
    }));
    req.resume();
    return;
  }

  // Liveness probe — dependency-free, no auth, no FS reads.
  // Used by container healthchecks and external monitors. Must stay cheap.
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Build-info probe — populated at container build time from env vars.
  // Lets the browser show which branch / commit is running so testers can
  // verify they're hitting the right build. Session-gated: branch/commit
  // metadata is mild reconnaissance value on a public subdomain, and every
  // consumer (the app shell, the Settings pane) already holds a session.
  if (pathname === '/api/build') {
    if (!isAuthenticated(req) && !isAgentRequest(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    const commit = process.env.BUILD_COMMIT || null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      branch: process.env.BUILD_BRANCH || null,
      commit,
      commitShort: commit ? commit.slice(0, 7) : null,
      builtAt: process.env.BUILD_AT || null,
    }));
    return;
  }

  // Handle auth routes first
  if (pathname.startsWith('/auth/')) {
    const result = await handleAuthRoutes(req, res, pathname);
    if (result !== null) return;
  }

  // Control-plane admin API (Klebb Cloud). Carries its own KLEBB_ADMIN_TOKEN
  // bearer and is server-to-server (no browser session), so it runs before
  // the session gate. The handler enforces the token itself (401 without it).
  if (pathname.startsWith('/api/admin/')) {
    if (await handleAdminRoutes(req, res, pathname)) return;
  }

  // The HAE webhook carries its own token (managed in Settings; see
  // health-auto-export/token-store.js) and the handler enforces it. Let
  // the request through the outer auth gate so the handler can respond
  // with 501/401/200 as appropriate. No session cookie or
  // AGENT_API_TOKEN is expected from the iPhone app.
  const isHaeIngest = pathname === '/api/health-auto-export' && req.method === 'POST';

  // Redirect to setup or login if not authenticated
  if (!isAuthenticated(req) && !isHaeIngest && !isPublicPath(pathname)) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    // Redirect to login page (or setup if no credentials yet).
    // Demo mode never shows setup: the login page hosts the "Enter the demo" button.
    const redirect = (ENV.KLEBB_DEMO || isSetup()) ? '/login.html' : '/setup.html';
    res.writeHead(302, { 'Location': redirect });
    res.end();
    return;
  }

  // If setup is not done, redirect non-setup pages to setup. Skipped in demo
  // mode: the login page handles bootstrap there.
  if (!ENV.KLEBB_DEMO && !isSetup() && pathname !== '/setup.html' && !isPublicPath(pathname) && !pathname.startsWith('/api/')) {
    res.writeHead(302, { 'Location': '/setup.html' });
    res.end();
    return;
  }

  // Hide /setup.html and /register entirely in demo mode (so curious
  // visitors don't stumble onto the setup wizard).
  if (ENV.KLEBB_DEMO && (pathname === '/setup.html' || pathname === '/register')) {
    res.writeHead(302, { 'Location': '/login.html' });
    res.end();
    return;
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    const parts = pathname.slice(5).split('/'); // strip /api/

    // === Manifest endpoints (v2) ===
    // These take precedence over legacy flat endpoints when a manifest file exists.

    // GET /api/manifests — list of all registered manifests
    if (parts[0] === 'manifests' && parts.length === 1 && req.method === 'GET') {
      return sendJSON(res, { entries: registry.list(), errors: registry.errors() });
    }

    // POST /api/manifests — create a brand new card from a full manifest body.
    // Lenient on purpose: any JSON whose $schema, meta.id, meta.label satisfy
    // the load path's contract is accepted. Unknown renderer names are allowed
    // (ad-hoc escape hatch) and render as eh-unknown-card until a matching
    // renderer exists. Auth is already enforced globally at the top of the
    // request handler.
    if (parts[0] === 'manifests' && parts.length === 1 && req.method === 'POST') {
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { return sendJSON(res, { error: 'invalid JSON body' }, 400); }
        try {
          const result = registry.createManifest(parsed);
          return sendJSON(res, {
            ok: true,
            id: result.id,
            source: path.basename(result.source),
            welcomeAutoHidden: !!result.welcomeAutoHidden,
          }, 201);
        } catch (e) {
          const msg = e.message || 'create failed';
          const status = /^duplicate id/.test(msg) ? 409
            : /^invalid id/.test(msg) ? 422
            : /^invalid notifications:/.test(msg) ? 422
            : /^invalid schedule\.time_of_day/.test(msg) ? 422
            : /^invalid cadence:/.test(msg) ? 422
            : /^invalid ingest:/.test(msg) ? 422
            : /^(missing |unsupported \$schema)/.test(msg) ? 400
            : 500;
          return sendJSON(res, { error: msg }, status);
        }
      });
      return;
    }

    // DELETE /api/manifests/:id — remove a card + its file.
    if (parts[0] === 'manifests' && parts.length === 2 && req.method === 'DELETE') {
      const id = parts[1];
      if (!registry.get(id)) return send404(res, 'manifest not found');
      try {
        const result = registry.deleteManifest(id);
        return sendJSON(res, { ok: true, id: result.id });
      } catch (e) {
        return sendJSON(res, { error: e.message || 'delete failed' }, 500);
      }
    }

    // PATCH /api/manifests/:id — RFC 7396 JSON Merge Patch over meta + description.
    // Body: { meta?: {...}, description?: "..." }
    //   - Nested objects deep-merge; arrays replace; null removes.
    //   - data + $schema + meta.id are protected.
    if (parts[0] === 'manifests' && parts.length === 2 && req.method === 'PATCH') {
      const id = parts[1];
      if (!registry.get(id)) return send404(res, 'manifest not found');
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let patch;
        try {
          patch = JSON.parse(body || '{}');
        } catch (e) {
          return sendJSON(res, { error: 'invalid JSON body' }, 400);
        }
        if (ENV.KLEBB_DEMO && patch && patch.meta && Object.prototype.hasOwnProperty.call(patch.meta, 'enabled')) {
          return sendJSON(res, { error: 'demo mode: cards cannot be hidden' }, 403);
        }
        try {
          const result = registry.patchManifest(id, patch);
          return sendJSON(res, { ok: true, id: result.id });
        } catch (e) {
          const msg = e.message || 'patch failed';
          const status = /unknown manifest/.test(msg) ? 404
            : /protected field|patch must be|missing|description must/.test(msg) ? 400
            : /^invalid id/.test(msg) ? 422
            : /^invalid notifications:/.test(msg) ? 422
            : /^invalid schedule\.time_of_day/.test(msg) ? 422
            : /^invalid cadence:/.test(msg) ? 422
            : /^invalid ingest:/.test(msg) ? 422
            : 500;
          return sendJSON(res, { error: msg }, status);
        }
      });
      return;
    }

    // GET /api/views/:viewName — cards that opt into a named view
    if (parts[0] === 'views' && parts.length === 2 && req.method === 'GET') {
      const viewName = parts[1];
      const valid = ['view', 'trends', 'calendar', 'reports', 'dayDetail'];
      if (!valid.includes(viewName)) return send404(res, 'unknown view');
      return sendJSON(res, {
        cards: registry.listForView(viewName),
        errors: registry.errors(),
      });
    }

    // GET /api/manifests/:id — full manifest
    if (parts[0] === 'manifests' && parts.length === 2 && req.method === 'GET') {
      const entry = registry.get(parts[1]);
      if (!entry) return send404(res, 'manifest not found');
      return sendJSON(res, entry);
    }

    // GET /api/manifests/:id/data — data block only
    if (parts[0] === 'manifests' && parts.length === 3 && parts[2] === 'data' && req.method === 'GET') {
      const entry = registry.get(parts[1]);
      if (!entry) return send404(res, 'manifest not found');
      return sendJSON(res, { data: entry.data });
    }

    // GET /api/manifests/:id/orphans — stored row keys nothing in the
    // manifest references. Drives the Settings gear's orphan section.
    if (parts[0] === 'manifests' && parts.length === 3 && parts[2] === 'orphans' && req.method === 'GET') {
      const report = orphanReport(registry, parts[1]);
      if (report.error) return send404(res, report.error);
      return sendJSON(res, report);
    }

    // POST /api/manifests/:id/data — full rewrite (honours meta.writeable.fromWebapp)
    if (parts[0] === 'manifests' && parts.length === 3 && parts[2] === 'data' && req.method === 'POST') {
      const entry = registry.get(parts[1]);
      if (!entry) return send404(res, 'manifest not found');
      const w = entry.meta.writeable;
      if (!w || !w.fromWebapp) return sendJSON(res, { error: 'not writeable from webapp' }, 403);
      const fromAgent = isAgentRequest(req);
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!('data' in parsed)) return sendJSON(res, { error: 'missing data field in body' }, 400);

          // Reject pre-serialised data outright at the HTTP boundary.
          // The registry has a rescue path as a safety net, but a string
          // here is always a writer bug we want loud feedback on. See #342.
          if (typeof parsed.data === 'string') {
            return sendJSON(res, { error: 'data must be a JSON object or array, not a string' }, 400);
          }

          // Safety net: if an external agent still sends date-keyed data
          // (the legacy mood/notes shape), auto-convert to array on the way in.
          // Logs a warning so the offending writer can be tracked down.
          let incoming = parsed.data;
          if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
            const conv = convertDateKeyedToArray(incoming);
            if (conv.ok && conv.data.length > 0) {
              console.warn(`[manifest] auto-converted date-keyed data to array for ${parts[1]} (${conv.data.length} rows)`);
              incoming = conv.data;
            }
          }

          // Webapp writes must respect past/today/future allowances.
          // Bearer-auth agent writes bypass (backfills, schedules, etc.).
          if (!fromAgent && Array.isArray(incoming)) {
            const violation = findDateAllowanceViolation(entry.data, incoming, w);
            if (violation) return sendJSON(res, { error: violation }, 403);
          }

          registry.writeData(parts[1], incoming);
          return sendJSON(res, { ok: true, id: parts[1] });
        } catch (e) {
          return sendJSON(res, { error: e.message || 'invalid request' }, 400);
        }
      });
      return;
    }

    // POST /api/manifests/reorder — reassign meta.order across cards
    // Body: { order: ["id1", "id2", "id3", ...] }
    // Writes sparse-numbered meta.order (100, 200, 300, ...) to each listed
    // manifest. Unlisted cards keep their existing order. Unknown ids cause
    // the whole operation to fail with no writes.
    if (parts[0] === 'manifests' && parts.length === 2 && parts[1] === 'reorder' && req.method === 'POST') {
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          let parsed;
          try { parsed = JSON.parse(body || '{}'); }
          catch { return sendJSON(res, { error: 'invalid JSON body' }, 400); }
          if (!Array.isArray(parsed.order)) {
            return sendJSON(res, { error: 'order[] required' }, 400);
          }
          if (parsed.order.length === 0) {
            return sendJSON(res, { error: 'order[] must not be empty' }, 400);
          }
          const result = registry.reorderByIds(parsed.order);
          return sendJSON(res, { ok: true, ...result });
        } catch (e) {
          const msg = e.message || 'reorder failed';
          const status = /unknown manifest/.test(msg) ? 404
            : /must be|duplicate/.test(msg) ? 400
            : 500;
          return sendJSON(res, { error: msg }, status);
        }
      });
      return;
    }

    // === End manifest endpoints ===

    // === Settings endpoints ===
    //
    // No install/wizard. Files in $HEALTH_HOME/data/ are the source of truth.
    // Settings just lists them and provides per-card master enable/disable
    // (flips meta.enabled in the file).

    // GET /api/settings/cards — list all discovered cards with enabled state
    if (parts[0] === 'settings' && parts[1] === 'cards' && parts.length === 2 && req.method === 'GET') {
      const cards = registry.list().map(c => ({
        id: c.id,
        label: c.meta.label,
        emoji: c.meta.emoji || null,
        description: c.description || null,
        enabled: c.enabled,
        hasData: c.hasData,
      }));
      return sendJSON(res, { cards });
    }

    // POST /api/settings/cards/:id/enable — set meta.enabled: true
    if (parts[0] === 'settings' && parts[1] === 'cards' && parts.length === 4 && parts[3] === 'enable' && req.method === 'POST') {
      if (ENV.KLEBB_DEMO) {
        return sendJSON(res, { error: 'demo mode: cards cannot be hidden' }, 403);
      }
      try {
        registry.setMasterEnabled(parts[2], true);
        return sendJSON(res, { ok: true, enabled: true });
      } catch (e) {
        return sendJSON(res, { error: e.message }, e.message.includes('unknown') ? 404 : 500);
      }
    }

    // POST /api/settings/cards/:id/disable — set meta.enabled: false
    if (parts[0] === 'settings' && parts[1] === 'cards' && parts.length === 4 && parts[3] === 'disable' && req.method === 'POST') {
      if (ENV.KLEBB_DEMO) {
        return sendJSON(res, { error: 'demo mode: cards cannot be hidden' }, 403);
      }
      try {
        registry.setMasterEnabled(parts[2], false);
        return sendJSON(res, { ok: true, enabled: false });
      } catch (e) {
        return sendJSON(res, { error: e.message }, e.message.includes('unknown') ? 404 : 500);
      }
    }

    // POST /api/settings/cards/from-template — create a real card from a
    // shipped template. Body: { templateId }. Fills the template's
    // {{string:…}} placeholders from meta.template.defaults, derives a
    // unique id, strips meta.template, and writes the manifest.
    if (parts[0] === 'settings' && parts[1] === 'cards' && parts[2] === 'from-template' && parts.length === 3 && req.method === 'POST') {
      if (ENV.KLEBB_DEMO) {
        return sendJSON(res, { error: 'demo mode: cards cannot be created' }, 403);
      }
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { return sendJSON(res, { error: 'invalid JSON body' }, 400); }
        const templateId = parsed && parsed.templateId;
        if (typeof templateId !== 'string' || !templateId) {
          return sendJSON(res, { error: 'templateId required' }, 400);
        }
        const tmpl = listTemplates().find(t => t.id === templateId);
        if (!tmpl) return sendJSON(res, { error: 'unknown template' }, 404);
        try {
          const takenIds = registry.list().map(c => c.id);
          const { manifest } = instantiateTemplate(tmpl.manifest, takenIds);
          const result = registry.createManifest(manifest);
          return sendJSON(res, { ok: true, id: result.id }, 201);
        } catch (e) {
          const msg = e.message || 'create failed';
          const status = /^duplicate id/.test(msg) ? 409
            : /^invalid id/.test(msg) ? 422
            : /^invalid notifications:/.test(msg) ? 422
            : /^invalid schedule\.time_of_day/.test(msg) ? 422
            : /^invalid cadence:/.test(msg) ? 422
            : /^invalid ingest:/.test(msg) ? 422
            : /^(missing |unsupported \$schema|not a template)/.test(msg) ? 400
            : 500;
          return sendJSON(res, { error: msg }, status);
        }
      });
      return;
    }

    // === End settings endpoints ===

    // === Content endpoints (templates + prompts) ===
    // Served from templates/ and prompts/ at the repo root. Read at request
    // time so a contributor's newly added content is picked up without a
    // restart; the directories are small and traffic is infrequent.

    if (parts[0] === 'templates' && parts.length === 1 && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return sendJSON(res, { templates: listTemplates() });
    }

    if (parts[0] === 'prompts' && parts.length === 1 && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return sendJSON(res, { prompts: listPrompts() });
    }

    // GET /api/chat/status — is a chat endpoint configured? UI affordances
    // that depend on the agent use this to render an enabled/disabled state
    // without making an actual chat request. In demo mode the chat endpoint
    // is "configured" (the canned-reply short-circuit answers it) but
    // outbound is reported false so voice / tool affordances stay off.
    if (parts[0] === 'chat' && parts[1] === 'status' && parts.length === 2 && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      if (ENV.KLEBB_DEMO) {
        return sendJSON(res, { configured: true, demo: true });
      }
      return sendJSON(res, { configured: !!CHAT_ENDPOINT });
    }

    // === End content endpoints ===

    // GET /api/config — instance config file (not a manifest).
    if (parts.length === 1 && parts[0] === 'config') {
      const data = readJSONFile(path.join(DATA_DIR, 'config.json'));
      if (data) return sendJSON(res, data);
      return send404(res);
    }

    // GET /api/info — list all info dates
    if (parts[0] === 'info' && parts.length === 1) {
      const dates = listDatesInDir(path.join(DATA_DIR, 'info'));
      return sendJSON(res, dates);
    }

    // GET /api/info/:date
    if (parts[0] === 'info' && parts.length === 2) {
      const data = readJSONFile(path.join(DATA_DIR, 'info', `${parts[1]}.json`));
      if (data) return sendJSON(res, data);
      return send404(res);
    }

    // POST /api/health-auto-export: iPhone Health Auto Export webhook.
    //
    // Auth: Bearer <token-from-Settings>. If no token has been generated
    // (cfg.hae.token empty in $HEALTH_HOME/config.json), the endpoint
    // returns 501 (feature off). If the header is wrong or missing,
    // returns 401. Otherwise the raw payload is archived, parsed, and
    // upserted into atomic manifests (sleep-hours, steps, active-minutes,
    // workouts).
    //
    // Errors that occur AFTER auth passes are swallowed into a 200 with a
    // warning so the iPhone app's retry loop doesn't spiral. The raw
    // payload is always archived, so parse failures are debuggable later.
    if (parts[0] === 'health-auto-export' && parts.length === 1 && req.method === 'POST') {
      const token = haeTokenStore.getToken();
      if (!token) return sendJSON(res, { error: 'ingest disabled' }, 501);
      const auth = req.headers['authorization'];
      if (!auth || !auth.startsWith('Bearer ') || auth.slice(7).trim() !== token) {
        return sendJSON(res, { error: 'unauthorised' }, 401);
      }

      // 100 MB cap: enough to accept a years-long HAE manual backfill
      // push without letting a pathological client exhaust memory.
      const HAE_MAX_BODY = 100 * 1024 * 1024;
      const receivedAt = new Date().toISOString();
      // Chunks are collected as BUFFERS and decoded once, at the end.
      //
      // `body += chunk` decodes every chunk independently, so a multi-byte
      // UTF-8 sequence straddling a TCP chunk boundary becomes U+FFFD on both
      // sides, permanently: in the parsed rows AND in the "verbatim" raw
      // archive, which can then never be byte-identical to what the phone sent.
      // A device name with a curly apostrophe or an accent is enough to trigger
      // it, and nothing downstream can recover the original bytes.
      const chunks = [];
      let received = 0;
      let tooBig = false;
      const finishOversize = () => {
        if (!tooBig) return;
        haeDiagnostics.writeLastPush({
          receivedAt, payloadBytes: received,
          subscribers: [], availableUnsubscribed: [],
          warnings: [`payload exceeded ${HAE_MAX_BODY} bytes`],
        });
        if (!res.headersSent) sendJSON(res, { error: 'payload too large' }, 413);
      };
      req.on('data', c => {
        if (tooBig) return;
        received += c.length;
        if (received > HAE_MAX_BODY) {
          tooBig = true;
          // The 413 is sent from HERE, not from 'end'. Destroying the request
          // means 'end' never fires (only 'aborted' and 'close'), so a check in
          // the 'end' handler was unreachable: an oversize push got a bare TCP
          // reset with no status and no diagnostic, which reads to the phone as
          // a network blip worth retrying forever.
          finishOversize();
          // Drain rather than destroy, so the response we just wrote is
          // actually delivered before the socket closes.
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('aborted', () => { chunks.length = 0; });
      req.on('end', () => {
        if (tooBig) return;
        const body = Buffer.concat(chunks).toString('utf8');
        chunks.length = 0;

        const payloadBytes = Buffer.byteLength(body);

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          // A payload that will not parse has no samples to store, so the
          // samples table cannot hold it and the bytes are the only evidence
          // of what the phone actually sent. Quarantine it: a bounded
          // directory keeping the most recent few, not an unbounded archive.
          const quarantined = haeQuarantine.write(body);
          haeDiagnostics.writeLastPush({
            receivedAt, payloadBytes,
            subscribers: [], availableUnsubscribed: [],
            warnings: [quarantined
              ? 'parse failed, payload quarantined for inspection'
              : 'parse failed, payload could not be quarantined'],
          });
          return sendJSON(res, {
            ok: true,
            warning: quarantined
              ? 'parse failed, payload quarantined for inspection'
              : 'parse failed',
          });
        }

        // Store every sample the push carried, deduplicated by content. This
        // replaced archiving each payload to its own file: HAE re-sends a
        // rolling window, so 85% of what the file archive held was
        // byte-identical re-sends (404 MB on a real instance).
        //
        // Recorded BEFORE dispatch, so a dispatch failure still leaves the
        // samples durable and replayable. A failure here is logged, not
        // fatal: a push that reaches subscribers is worth more than one that
        // 500s because the history write failed.
        try {
          haeSamples.recordPush(payload, { receivedAt });
        } catch (e) {
          console.error('[hae] failed to record samples:', e.message);
        }

        try {
          const summary = hae.dispatch(registry, payload);
          haeDiagnostics.writeLastPush({
            receivedAt, payloadBytes,
            subscribers: summary.subscribers,
            availableUnsubscribed: summary.availableUnsubscribed,
            warnings: summary.warnings,
          });
          const subscribedMetrics = hae.findSubscribers(registry).map(s => s.metric);
          haeDiscoveries.sync({
            seen: summary.availableUnsubscribed,
            subscribed: subscribedMetrics,
          });
          const ingested = {};
          for (const s of summary.subscribers) ingested[s.id] = s.rowsWritten;
          return sendJSON(res, {
            ok: true,
            ingested,
            availableUnsubscribed: summary.availableUnsubscribed,
          });
        } catch (e) {
          console.error('[hae] dispatch failed:', e.message);
          haeDiagnostics.writeLastPush({
            receivedAt, payloadBytes,
            subscribers: [], availableUnsubscribed: [],
            warnings: [`dispatch failed: ${e.message}`],
          });
          // The samples were recorded before dispatch ran, so the push is
          // replayable even though this dispatch did not land any rows.
          return sendJSON(res, { ok: true, warning: 'dispatch failed, samples stored' });
        }
      });
      return;
    }

    // GET /api/health-auto-export/status — settings-facing diagnostic.
    // Reports whether the ingest token is configured, the effective
    // webhook URL (derived from the request host), and the most recent
    // push snapshot written by the dispatcher.
    if (parts[0] === 'health-auto-export' && parts[1] === 'status'
        && parts.length === 2 && req.method === 'GET') {
      const token = haeTokenStore.getToken();
      const host = req.headers['host'] || `${HOST}:${PORT}`;
      const scheme = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      return sendJSON(res, {
        tokenSet: !!token,
        endpointUrl: `${scheme}://${host}/api/health-auto-export`,
        lastPush: haeDiagnostics.readLastPush(),
      });
    }

    // GET /api/health-auto-export/token: return the current token (or
    // null) for the Settings UI to display. Behind the global auth gate
    // (passkey session required, same as every other /api route except
    // the ingest webhook itself).
    if (parts[0] === 'health-auto-export' && parts[1] === 'token'
        && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, {
        token: haeTokenStore.getToken(),
        lastRegeneratedAt: haeTokenStore.getLastRegeneratedAt(),
      });
    }

    // POST /api/health-auto-export/token: generate a token. Returns 409
    // if one already exists (use /regenerate to replace).
    if (parts[0] === 'health-auto-export' && parts[1] === 'token'
        && parts.length === 2 && req.method === 'POST') {
      if (haeTokenStore.getToken()) {
        return sendJSON(res, { error: 'token already set; use /regenerate' }, 409);
      }
      const token = haeTokenStore.generateToken();
      return sendJSON(res, {
        token,
        lastRegeneratedAt: haeTokenStore.getLastRegeneratedAt(),
      });
    }

    // POST /api/health-auto-export/token/regenerate: replace the
    // current token with a fresh one. The old token is invalidated
    // immediately; the iPhone HAE app must be updated before it can
    // push again.
    if (parts[0] === 'health-auto-export' && parts[1] === 'token'
        && parts[2] === 'regenerate' && parts.length === 3
        && req.method === 'POST') {
      const token = haeTokenStore.generateToken();
      return sendJSON(res, {
        token,
        lastRegeneratedAt: haeTokenStore.getLastRegeneratedAt(),
      });
    }

    // DELETE /api/health-auto-export/token: clear the token. Subsequent
    // ingest requests return 501 (feature off).
    if (parts[0] === 'health-auto-export' && parts[1] === 'token'
        && parts.length === 2 && req.method === 'DELETE') {
      haeTokenStore.clearToken();
      return sendJSON(res, { ok: true });
    }

    // === Passkey (WebAuthn credential) management ===
    // Behind the global auth gate: a valid passkey session is required. The
    // session's userId scopes which credentials are visible/removable, so a
    // request can only ever see and manage its own account's passkeys.

    // GET /api/credentials — list the current user's passkeys (non-sensitive
    // fields only; never publicKey/counter). Flags the current device.
    if (parts[0] === 'credentials' && parts.length === 1 && req.method === 'GET') {
      const session = getSessionRecord(req);
      if (!session || !session.userId) return sendJSON(res, { error: 'Unauthorized' }, 401);
      return sendJSON(res, {
        credentials: listCredentialsForUser(session.userId, session.credentialId),
      });
    }

    // POST /api/invites — mint a single-use register invite for the caller's
    // OWN account: the Settings > Security "add a device" flow. The label is
    // always the session's userId (never client input), so a passkey
    // registered on another device via the QR/link lands under the caller's
    // account. Same machinery the admin API and CLI use; standard single-use
    // + expiry rules apply. Closed in demo mode, where /register is hidden.
    if (parts[0] === 'invites' && parts.length === 1 && req.method === 'POST') {
      if (ENV.KLEBB_DEMO) return sendJSON(res, { error: 'Not available in demo mode' }, 403);
      const session = getSessionRecord(req);
      if (!session || !session.userId) return sendJSON(res, { error: 'Unauthorized' }, 401);
      const invite = invites.createInvite({ label: session.userId });
      invites.recordAuthEvent({ kind: 'self.invite.created', label: invite.label, code: invite.code });
      return sendJSON(res, {
        code: invite.code,
        label: invite.label,
        expiresAt: invite.expiresAt,
        registerUrl: `${ENV.WEBAUTHN_ORIGIN}/register?code=${encodeURIComponent(invite.code)}`,
      }, 201);
    }

    // DELETE /api/credentials/:id — remove one passkey by id. Refuses to
    // remove the last remaining credential (would re-open the instance to
    // bootstrap). Sessions bound to the removed credential are invalidated.
    if (parts[0] === 'credentials' && parts.length === 2 && req.method === 'DELETE') {
      const session = getSessionRecord(req);
      if (!session || !session.userId) return sendJSON(res, { error: 'Unauthorized' }, 401);
      const id = decodeURIComponent(parts[1]);
      const result = deleteCredentialForUser(session.userId, id);
      if (result.ok) return sendJSON(res, { ok: true, id: result.deletedId });
      if (result.reason === 'last-credential') {
        return sendJSON(res, { error: 'Cannot remove your only passkey' }, 409);
      }
      return sendJSON(res, { error: 'Passkey not found' }, 404);
    }

    // GET /api/health-auto-export/discoveries — list metrics present in
    // past HAE pushes that no manifest subscribes to. Shape (see
    // discoveries.list()):
    //   { undismissed: { supported: {<category>: [{metric, firstSeenAt}]},
    //                    unsupported: [{metric, firstSeenAt}] },
    //     dismissed: [{metric, firstSeenAt, dismissedAt}] }
    if (parts[0] === 'health-auto-export' && parts[1] === 'discoveries'
        && parts.length === 2 && req.method === 'GET') {
      return sendJSON(res, haeDiscoveries.list());
    }

    // POST /api/health-auto-export/discoveries/:metric/dismiss
    // POST /api/health-auto-export/discoveries/:metric/unhide
    if (parts[0] === 'health-auto-export' && parts[1] === 'discoveries'
        && parts.length === 4 && req.method === 'POST') {
      const metric = decodeURIComponent(parts[2]);
      const action = parts[3];
      let ok = false;
      if (action === 'dismiss') ok = haeDiscoveries.dismiss(metric);
      else if (action === 'unhide') ok = haeDiscoveries.unhide(metric);
      else return sendJSON(res, { error: 'unknown action' }, 404);
      if (!ok) return sendJSON(res, { error: 'unknown metric' }, 404);
      return sendJSON(res, { ok: true });
    }

    // --- Combination-card suggestions ---------------------------------
    // GET /api/cc-suggestions — returns { suggestions: [{category, cardIds}] }.
    // Clusters 3+ enabled atomic cards sharing a meta.category value,
    // excludes cards already used as donors in existing CCs, honours
    // dismissals.
    if (parts[0] === 'cc-suggestions' && parts.length === 1 && req.method === 'GET') {
      return sendJSON(res, ccSuggestions.list(registry));
    }

    // POST /api/cc-suggestions/:category/dismiss
    // Body: { cardIds: [...] } — the cluster's card IDs at the moment of
    // dismissal. Stored as part of the dismissal key so adding a new
    // card to the cluster later re-fires as a fresh suggestion.
    if (parts[0] === 'cc-suggestions' && parts[2] === 'dismiss'
        && parts.length === 3 && req.method === 'POST') {
      const category = decodeURIComponent(parts[1]);
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { return sendJSON(res, { error: 'invalid json' }, 400); }
        const cardIds = Array.isArray(parsed.cardIds) ? parsed.cardIds : [];
        if (cardIds.length === 0) {
          return sendJSON(res, { error: 'cardIds required' }, 400);
        }
        const ok = ccSuggestions.dismiss(category, cardIds);
        if (!ok) return sendJSON(res, { error: 'dismiss failed' }, 400);
        return sendJSON(res, { ok: true });
      });
      return;
    }

    // GET /api/hygiene — ambient, high-confidence staleness only, minus
    // anything the user has dismissed. The full multi-kind scan is pull-only
    // via the hygiene_scan chat tool; this surface is the quiet nudge.
    if (parts[0] === 'hygiene' && parts.length === 1 && req.method === 'GET') {
      const findings = hygieneState.filterDismissed(ambientStaleness(registry, todayIso()));
      return sendJSON(res, { findings });
    }

    // POST /api/hygiene/:cardId/dismiss
    // Body: { kind } — silence one finding kind for one card, permanently.
    // Mirrors the cc-suggestions dismissal model. `dismissedAt` is recorded but
    // nothing expires on it: since staleness is opt-in (meta.cadence), a
    // dismissal means the author asked to be chased and then said no, so the
    // honest reading is "stop", not "ask again later". To resume nudges, clear
    // the entry from data/_meta/hygiene-dismissed.json or drop the cadence.
    if (parts[0] === 'hygiene' && parts[2] === 'dismiss'
        && parts.length === 3 && req.method === 'POST') {
      const cardId = decodeURIComponent(parts[1]);
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { return sendJSON(res, { error: 'invalid json' }, 400); }
        const kind = typeof parsed.kind === 'string' ? parsed.kind : 'stale';
        const ok = hygieneState.dismiss(cardId, kind);
        if (!ok) return sendJSON(res, { error: 'dismiss failed' }, 400);
        return sendJSON(res, { ok: true });
      });
      return;
    }

    // POST /api/feedback — append an anonymised feedback line.
    // Body: { kind?, intent, context?, toolsConsidered? }. Fired by the
    // in-app feedback form and mirrored by Klebbius's note_feedback tool
    // (which calls appendFeedback in-process). Anonymisation happens in
    // lib/feedback; behind the same global auth gate as every other /api route.
    // Origin-allowlisted like the notification POSTs: SameSite=Lax doesn't
    // stop a sibling subdomain writing junk lines under a rider session.
    if (parts[0] === 'feedback' && parts.length === 1 && req.method === 'POST') {
      if (!originAllowed(req)) {
        return sendJSON(res, { error: 'origin not allowed' }, 403);
      }
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { return sendJSON(res, { error: 'invalid json' }, 400); }
        if (!parsed.intent || typeof parsed.intent !== 'string') {
          return sendJSON(res, { error: 'intent required' }, 400);
        }
        const result = feedback.appendFeedback(parsed);
        return sendJSON(res, result, result.logged ? 200 : 400);
      });
      return;
    }

    // Auto-export endpoints: sleep, workouts, vitals, activity
    const autoExportTypes = ['sleep', 'workouts', 'vitals', 'activity'];
    if (autoExportTypes.includes(parts[0])) {
      const dir = path.join(DATA_DIR, 'auto-export', parts[0]);

      // GET /api/{type}/range/:start/:end
      if (parts[1] === 'range' && parts.length === 4) {
        return sendJSON(res, getDateRange(dir, parts[2], parts[3]));
      }

      // GET /api/{type}/:date
      if (parts.length === 2) {
        const data = readJSONFile(path.join(dir, `${parts[1]}.json`));
        if (data) return sendJSON(res, data);
        return send404(res);
      }
    }

    // === Conversations (#603) ===
    // The datastore-backed successor to /api/chat/history: many named
    // conversations instead of one file, same single-user model. The legacy
    // endpoint below keeps working until the client cutover, then retires.
    if (parts[0] === 'conversations' && parts.length === 1 && req.method === 'GET') {
      return sendJSON(res, { conversations: conversationsStore().list() });
    }
    if (parts[0] === 'conversations' && parts.length === 1 && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let title = null;
        let messages = [];
        if (body) {
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { return sendJSON(res, { error: 'Invalid JSON' }, 400); }
          if (typeof parsed?.title === 'string') title = parsed.title.trim().slice(0, 120) || null;
          if (Array.isArray(parsed?.messages)) messages = parsed.messages;
        }
        sendJSON(res, { conversation: conversationsStore().create({ title, messages }) }, 201);
      });
      return;
    }
    if (parts[0] === 'conversations' && parts.length === 2 && req.method === 'GET') {
      const conversation = conversationsStore().get(parts[1]);
      if (!conversation) return send404(res, 'Unknown conversation');
      return sendJSON(res, { conversation });
    }
    if (parts[0] === 'conversations' && parts.length === 2 && req.method === 'PATCH') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return sendJSON(res, { error: 'Invalid JSON' }, 400); }
        if (typeof parsed?.title !== 'string') {
          return sendJSON(res, { error: 'title required' }, 400);
        }
        if (!conversationsStore().rename(parts[1], parsed.title)) {
          return send404(res, 'Unknown conversation');
        }
        sendJSON(res, { ok: true });
      });
      return;
    }
    if (parts[0] === 'conversations' && parts.length === 2 && req.method === 'DELETE') {
      if (!conversationsStore().remove(parts[1])) return send404(res, 'Unknown conversation');
      return sendJSON(res, { ok: true });
    }
    if (parts[0] === 'conversations' && parts.length === 3 && parts[2] === 'messages' && req.method === 'PUT') {
      let body = '';
      let tooBig = false;
      // Same multi-byte and size discipline as the legacy history PUT: the
      // cap is answered from the data handler so an oversized body is
      // refused as soon as it crosses the line, not after it all arrived.
      req.setEncoding('utf8');
      req.on('data', c => {
        if (tooBig) return;
        body += c;
        if (body.length > 512 * 1024) {
          tooBig = true;
          sendJSON(res, { error: 'Conversation too large' }, 413);
        }
      });
      req.on('end', () => {
        if (tooBig) return;
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return sendJSON(res, { error: 'Invalid JSON' }, 400); }
        if (!Array.isArray(parsed?.messages)) {
          return sendJSON(res, { error: 'messages array required' }, 400);
        }
        if (!conversationsStore().setMessages(parts[1], parsed.messages)) {
          return send404(res, 'Unknown conversation');
        }
        sendJSON(res, { ok: true });
      });
      return;
    }

    // GET /api/chat/turn/:conversationId — reattach to a turn (#602). A
    // client that backgrounded mid-turn reconnects here: buffered events
    // replay from Last-Event-ID (or ?after=N), then the stream goes live.
    // 204 means no turn to attach to: the client reads the conversation,
    // where any completed reply is already persisted.
    if (parts[0] === 'chat' && parts[1] === 'turn' && parts.length === 3 && req.method === 'GET') {
      const hub = _activeTurns.get(parts[2]);
      if (!hub) {
        res.writeHead(204);
        return res.end();
      }
      const afterRaw = req.headers['last-event-id']
        || new URL(req.url, 'http://local').searchParams.get('after')
        || '0';
      const after = Number.parseInt(afterRaw, 10);
      const es = startEventStream(res);
      hub.attach(es, Number.isFinite(after) && after > 0 ? after : 0);
      return;
    }

    // DELETE /api/chat/turn/:conversationId — stop the running turn. The
    // loop halts at its next checkpoint (between round-trips or tool
    // calls); the user's message stays, no reply is persisted, and the
    // one-turn lock releases so the next send goes through.
    if (parts[0] === 'chat' && parts[1] === 'turn' && parts.length === 3 && req.method === 'DELETE') {
      const hub = _activeTurns.get(parts[2]);
      if (!hub || hub.done) return send404(res, 'No turn running');
      hub.abort();
      return sendJSON(res, { ok: true });
    }

    // /api/chat/history — per-instance chat transcript so it follows the
    // user across devices. Single-user-per-instance model (WebAuthn auth),
    // so no per-user keying is needed.
    if (parts[0] === 'chat' && parts[1] === 'history' && parts.length === 2) {
      if (req.method === 'GET') {
        const existing = readJSONFile(PATHS.CHAT_HISTORY_FILE);
        const messages = Array.isArray(existing?.messages) ? existing.messages : [];
        return sendJSON(res, { messages });
      }
      if (req.method === 'PUT') {
        let body = '';
        let tooBig = false;
        // Chat history is the most likely body here to carry accented or
        // curly-quoted text, and it is large enough to arrive in several
        // chunks. Decode on the stream so a character split across a chunk
        // boundary is carried over instead of becoming replacement characters.
        req.setEncoding('utf8');
        req.on('data', c => {
          if (tooBig) return;
          body += c;
          if (body.length > 512 * 1024) {
            tooBig = true;
            // Answer here, not from 'end': req.destroy() means 'end' never
            // fires, so a check there is unreachable and the client gets a bare
            // socket reset with no status.
            if (!res.headersSent) sendJSON(res, { error: 'History too large' }, 413);
            req.resume();
          }
        });
        req.on('end', () => {
          if (tooBig) return;
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { return sendJSON(res, { error: 'Invalid JSON' }, 400); }
          const incoming = Array.isArray(parsed?.messages) ? parsed.messages : null;
          if (!incoming) return sendJSON(res, { error: 'messages array required' }, 400);
          const clean = incoming
            .filter(m => m && typeof m === 'object'
              && (m.role === 'user' || m.role === 'assistant')
              && typeof m.content === 'string')
            .map(m => {
              const out = {
                id: typeof m.id === 'string' ? m.id : `m${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: m.role,
                content: m.content,
              };
              // Preserve the embellishment chip payload that CC-create/edit
              // replies carry, so it survives a page reload or chat reopen
              // (see #191). Only shallow-validate shape; labels/prompts are
              // strings the client will show and send back.
              if (typeof m.followupText === 'string' && m.followupText) {
                out.followupText = m.followupText;
              }
              if (Array.isArray(m.embellishments) && m.embellishments.length) {
                out.embellishments = m.embellishments
                  .filter(e => e && typeof e === 'object'
                    && typeof e.label === 'string'
                    && typeof e.prompt === 'string')
                  .map(e => ({ label: e.label, prompt: e.prompt }));
                if (out.embellishments.length === 0) delete out.embellishments;
              }
              // A spoken reply keeps its play affordance across reloads
              // (#606); the audio itself re-synthesises on demand.
              if (m.hasVoice === true) out.hasVoice = true;
              return out;
            })
            .slice(-200);
          try {
            fs.mkdirSync(PATHS.CHAT_DIR, { recursive: true });
            const tmp = PATHS.CHAT_HISTORY_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ messages: clean }));
            fs.renameSync(tmp, PATHS.CHAT_HISTORY_FILE);
          } catch (e) {
            return sendJSON(res, { error: 'Could not persist history' }, 500);
          }
          return sendJSON(res, { ok: true, messages: clean });
        });
        return;
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(PATHS.CHAT_HISTORY_FILE); } catch {}
        return sendJSON(res, { ok: true });
      }
      return sendJSON(res, { error: 'Method not allowed' }, 405);
    }

    // POST /api/chat — proxy to chat gateway chat completions
    // Body: { messages: [...], voiceMode?: boolean }
    //   voiceMode=true → append "keep replies short/conversational" to system prompt
    if (parts[0] === 'chat' && parts.length === 1 && req.method === 'POST') {
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const { messages, voiceMode, viewedCardId } = parsed;
          // stream: true switches the response to server-sent events
          // (status/token/reset/reply/error/done). Everything before the
          // response shape is identical, and error statuses that fire
          // before the stream opens (400/503) stay plain JSON.
          const wantStream = parsed.stream === true;
          if (!Array.isArray(messages) || messages.length === 0) {
            return sendJSON(res, { error: 'messages required' }, 400);
          }
          if (ENV.KLEBB_DEMO) {
            const reply = `This is a public demo without an AI gateway connected, so ${ENV.CHAT_AGENT_NAME} can't answer questions or add new cards. You can still log data into the existing cards. Run your own instance (klebb.app) to chat with your own data.`;
            const payload = voiceMode ? { reply, speak: reply } : { reply };
            if (wantStream) {
              const es = startEventStream(res);
              es.send('reply', payload);
              es.send('done', {});
              es.end();
              return;
            }
            return sendJSON(res, payload);
          }

          // Conversation-aware turns (#603): with a conversationId the
          // server owns the transcript. The incoming messages are just the
          // new turn: they are persisted before the loop runs (a failed
          // turn still shows the user's message on reattach), the loop is
          // fed a context window over the stored transcript instead of
          // whatever the client resent, and the shaped reply is appended
          // after the turn, client connected or not.
          let convo = null;
          if (typeof parsed.conversationId === 'string' && parsed.conversationId) {
            convo = conversationsStore().get(parsed.conversationId);
            if (!convo) return send404(res, 'Unknown conversation');
          }

          // Build a compact card list from the live registry, so the agent
          // always knows what cards exist right now without having to call
          // /api/manifests. Keeps the system prompt self-describing.
          const cardList = registry.list().map(c => {
            const label = c.meta?.label || c.id;
            const emoji = c.meta?.emoji || '';
            const desc = (c.description || '').split('\n')[0].slice(0, 120);
            return `- ${c.id} (${emoji}${emoji ? ' ' : ''}${label})${desc ? ': ' + desc : ''}`;
          }).join('\n');
          const cardListBlock = cardList
            ? `\n\n## Currently available cards\n\n${cardList}\n`
            : '\n\n## Currently available cards\n\n(none yet)\n';

          // If the client told us which card the user just opened, name it as
          // privileged immediate context so vague references ("change the
          // target to 80kg") resolve against it before the agent considers a
          // clarifying question. Only when the id resolves to a real card.
          let viewedCardBlock = '';
          if (typeof viewedCardId === 'string' && viewedCardId) {
            const vc = registry.get(viewedCardId);
            if (vc) {
              const vlabel = vc.meta?.label || viewedCardId;
              viewedCardBlock = `\n\n## Card in focus\n\nThe user is currently looking at the "${vlabel}" card (id: ${viewedCardId}). Resolve vague references ("this card", "the target", "change it") against this card first.\n`;
            }
          }

          // Inject today's absolute date + a pre-computed weekday lookup
          // table in the server's TZ. Language models are unreliable at
          // weekday arithmetic from an ISO date, so we hand them the
          // answer rather than asking them to compute it.
          const todayBlock = buildDateContextBlock({ tz: ENV.TZ });

          // Inject the HAE catalogue's row shapes so the chat agent writes
          // display templates referencing fields the dispatcher actually
          // emits, rather than guessing from HAE's raw payload schema.
          const haeCatalogueBlock = '\n\n' + describeHaeCatalogue() + '\n';

          // Inject the combination-card manifest contract so the agent
          // writes `view.combines[]` with `sourceId` instead of
          // hallucinating view.slots[]/view.sources[] shapes.
          const ccSchemaBlock = '\n\n' + describeCcSchema() + '\n';

          // Catalogue of doc paths the read_doc tool can fetch. Lets
          // the agent pull MANIFEST-SCHEMA.md / docs/CARDS.md / etc.
          // on demand instead of relying on whatever the prompt
          // happens to inline today.
          const docsCatalogueBlock = '\n\n' + describeDocsCatalogue() + '\n';

          // Catalogue of reports the user has uploaded into
          // $HEALTH_HOME/reports/. Lets the agent pull a blood panel /
          // scan / voice memo into the turn via read_report when the
          // question calls for it.
          const reportsCatalogueBlock = '\n\n' + describeReportsCatalogue() + '\n';

          // Constrain meta.category to the canonical enum. Klebb uses the
          // field for clustering heuristics (e.g. CC suggestions); unknown
          // values are silently dropped by the registry, so agent-invented
          // values would simply be lost.
          const categoryBlock = [
            '',
            '## Manifest categories',
            '',
            'Every manifest you create SHOULD set `meta.category` to exactly',
            'one of the following values. Choose the best fit; invented',
            'values are silently dropped by the registry and the card will',
            'then be invisible to category-based features like combination-',
            'card suggestions.',
            '',
            MANIFEST_CATEGORIES.map(c => `- ${c}`).join('\n'),
            '',
            'Rules of thumb:',
            '- sleep: total hours, stages, sleep quality',
            '- recovery: HRV, resting HR, readiness-style metrics',
            '- activity: steps, exercise minutes, workouts, movement',
            '- vitals: blood pressure, SpO₂, temperature, blood glucose',
            '- body: weight, body fat, composition',
            '- mindfulness: meditation, breath work, reflection',
            '- lifestyle: mood, daily notes, qualitative journals',
            '- supplements: vitamins, peptides, stacks',
            '- medication: prescribed drugs, dosing schedules',
            '',
          ].join('\n');

          let systemPrompt = HEALTH_SYSTEM_PROMPT + todayBlock + cardListBlock + viewedCardBlock + haeCatalogueBlock + ccSchemaBlock + docsCatalogueBlock + reportsCatalogueBlock + categoryBlock;
          if (voiceMode) {
            systemPrompt = `You are ${process.env.CHAT_AGENT_NAME || 'Chat'}, a health assistant.
Voice mode is active: the user is speaking to you and will hear your reply aloud.

OUTPUT FORMAT — MANDATORY:
Reply with a single JSON object and nothing else. Schema:
{
  "speak":   "what should be spoken aloud (plain prose, no markdown, no emoji, no code, no URLs)",
  "display": "what should appear in the chat bubble (same answer, may include emoji / light markdown / short URLs)"
}

Voice-reply rules:
- speak is 1-3 short conversational sentences, 40 words MAX.
- No bullet points, no markdown, no code blocks, no headings in speak.
- Spell out abbreviations in speak (BP -> "blood pressure", HRV -> "heart rate variability", kg, lbs).
- No emoji, no URLs, no file paths in speak.
- If the answer is long, give the headline in speak + "ask me for details" — never cram.

Conversational allow-list (reply naturally, no disclaimer footer, no "let me check my data"):
- Thanks / cheers / awesome / nice / good one / ok -> a short friendly ack like "no worries" or "any time".
- Hi / hey / hello / morning / night -> a matching greeting.
- Emoji-only or one-word reactions -> a matching short reaction.

NEVER INVENT any of these phrases in either field:
- "No response from ${process.env.CHAT_AGENT_NAME || 'Chat'}" / "No response from the chat gateway" / similar
- "Gateway unavailable" / "Loading…" / "Please wait" / anything that reads like a UI state
- Error-looking lines or apologies for non-errors

Return STRICTLY the JSON object. No leading/trailing text. No markdown fences.

Original system prompt follows:

` + HEALTH_SYSTEM_PROMPT + todayBlock + cardListBlock + viewedCardBlock + haeCatalogueBlock + ccSchemaBlock + docsCatalogueBlock + reportsCatalogueBlock + categoryBlock;
          }

          if (!CHAT_ENDPOINT) {
            return sendJSON(res, { error: 'Chat endpoint not configured' }, 503);
          }

          const reqId = crypto.randomBytes(3).toString('hex');
          const turnStart = Date.now();
          chatLog(reqId, `start turns=${messages.length} voice=${!!voiceMode} stream=${wantStream} convo=${convo ? convo.id.slice(0, 8) : '-'}`);

          // One turn at a time per conversation: the second sender gets a
          // 409 BEFORE its message is persisted, so a retry after the
          // running turn finishes does not double up the transcript. The
          // check, the persist and the hub creation share one synchronous
          // span, so they cannot interleave.
          let hub = null;
          let loopMessages = messages;
          if (convo) {
            const existing = _activeTurns.get(convo.id);
            if (existing && !existing.done) {
              return sendJSON(res, {
                error: 'A reply is already being generated for this conversation.',
              }, 409);
            }
            try { conversationsStore().appendMessages(convo.id, messages); }
            catch (e) { chatLog(reqId, `convo persist failed ${e.message}`); }
            loopMessages = windowTranscript(conversationsStore().get(convo.id).messages);
            hub = createTurnHub(convo.id);
          }

          // Fire-and-forget: a conversation gets its title after the first
          // exchange completes, the turn never waits for it, and a failed
          // side-call just leaves it untitled for the next turn to retry.
          const maybeTitle = (payload) => {
            if (convo.title) return;
            const firstUser = messages.find(m => m.role === 'user');
            generateTitle({ userText: firstUser?.content, replyText: payload.reply, callGatewayFn: callGateway })
              .then((title) => {
                if (title && conversationsStore().rename(convo.id, title)) {
                  chatLog(reqId, `titled convo=${convo.id.slice(0, 8)}`);
                }
              })
              .catch((e) => chatLog(reqId, `title failed ${String(e.message || e).split(':')[0]}`));
          };
          const persistReply = (payload) => {
            if (!convo) return;
            const assistantMsg = { role: 'assistant', content: payload.reply };
            if (payload.followup?.text) assistantMsg.followupText = payload.followup.text;
            if (Array.isArray(payload.followup?.embellishments) && payload.followup.embellishments.length) {
              assistantMsg.embellishments = payload.followup.embellishments;
            }
            if (voiceMode) assistantMsg.hasVoice = true;
            if (payload.capped) assistantMsg.capped = true;
            try { conversationsStore().appendMessages(convo.id, [assistantMsg]); }
            catch (e) { chatLog(reqId, `convo persist failed ${e.message}`); }
            maybeTitle(payload);
          };

          // The buffered and streamed paths share one reply shaper and one
          // error mapper, so the SSE protocol can never drift from the JSON
          // contract on wording, followup chips, or the capped flag.
          const logDone = (out) => chatLog(reqId, `done total=${Date.now() - turnStart}ms iters=${out.iters} capped=${!!out.cappedOut}${out.deadlined ? ' deadline' : ''}${out.iterTimedOut ? ' iter_timeout' : ''}`);
          const shapeReply = ({ finalText, ctx, cappedOut }) => {
            const followup = buildFollowup(ctx);
            // `capped: true` is the machine-readable form; the appended text
            // is for today's client, which renders only the reply string.
            const flags = cappedOut ? { capped: true } : {};
            if (cappedOut) {
              finalText = finalText ? finalText + CAPPED_SUFFIX : CAPPED_FALLBACK_MESSAGE;
            }
            if (voiceMode) {
              const parsedReply = extractJsonReply(finalText);
              if (parsedReply && (parsedReply.speak || parsedReply.display)) {
                const speak = (parsedReply.speak || parsedReply.display || '').trim();
                const display = (parsedReply.display || parsedReply.speak || '').trim();
                return withFollowup({ reply: display, speak, ...flags }, followup);
              }
              const speak = finalText.replace(/\p{Extended_Pictographic}/gu, '').trim();
              return withFollowup({ reply: finalText || EMPTY_REPLY_MESSAGE, speak, ...flags }, followup);
            }
            return withFollowup({ reply: finalText || EMPTY_REPLY_MESSAGE, ...flags }, followup);
          };
          const mapError = (e) => {
            const msg = e.message || String(e);
            const cause = gateway.classifyGatewayError(e);
            // Log the distinguishing detail, so exhaustion and an outage are
            // tellable apart in the journal without reproducing them.
            chatLog(reqId, `err total=${Date.now() - turnStart}ms cause=${cause} ${msg.split(':')[0]}`);
            if (cause === 'budget') {
              // Not an error to apologise for: it is a limit being reported.
              // The reset date is deliberately not stated: the allowance is a
              // rolling window the webapp cannot see, and a wrong date is
              // worse than none.
              console.error('Chat allowance exhausted:', msg);
              return { status: 429, error: CHAT_BUDGET_MESSAGE };
            }
            if (cause === 'timeout') {
              console.error('Chat gateway timeout');
              return { status: 504, error: 'That took too long to come back. Try asking again.' };
            }
            if (cause === 'transient') {
              console.error('Chat gateway unavailable:', msg);
              return { status: 502, error: 'The AI service is not responding right now. Try again in a moment.' };
            }
            console.error('Chat parse error:', msg);
            return { status: 500, error: 'The AI service returned something unreadable. Try again in a moment.' };
          };

          // Conversation turns emit through the hub (buffered, replayable,
          // fanned out to every attached stream); plain turns emit straight
          // to their own stream, or nowhere on the buffered path. Tokens
          // stream for any consumer that could see them, including a
          // buffered conversation turn whose client may reattach mid-turn.
          if (wantStream) {
            // The stream is already 200 by the time the loop fails, so the
            // would-have-been status rides inside the error event. A client
            // that disappears mid-turn only mutes the events: the loop runs
            // to completion, same as the buffered path.
            const es = startEventStream(res);
            if (hub) hub.attach(es);
            const emit = hub ? hub.emit : es.send;
            runAgentLoop({
              systemPrompt, userMessages: loopMessages, reqId, emit,
              streamTokens: !voiceMode,
              shouldAbort: hub ? () => hub.aborted : undefined,
            })
              .then((out) => {
                logDone(out);
                if (out.aborted) {
                  // Stopped at the user's request: their message stays,
                  // no reply is invented, the lock releases.
                  emit('stopped', {});
                  emit('done', {});
                  if (hub) hub.finish(); else es.end();
                  return;
                }
                const payload = shapeReply(out);
                // Persist BEFORE the events go out: a client that
                // reconnects the moment done lands must find the reply in
                // the conversation, and a client that vanished mid-turn
                // still gets its answer stored.
                persistReply(payload);
                emit('reply', payload);
                emit('done', {});
                if (hub) hub.finish(); else es.end();
              })
              .catch((e) => {
                const { status, error } = mapError(e);
                emit('error', { error, status });
                emit('done', {});
                if (hub) hub.finish(); else es.end();
              });
            return;
          }

          runAgentLoop({
            systemPrompt,
            userMessages: loopMessages,
            reqId,
            emit: hub ? hub.emit : undefined,
            streamTokens: !!hub && !voiceMode,
            shouldAbort: hub ? () => hub.aborted : undefined,
          })
            .then((out) => {
              logDone(out);
              if (out.aborted) {
                if (hub) {
                  hub.emit('stopped', {});
                  hub.emit('done', {});
                  hub.finish();
                }
                return sendJSON(res, { stopped: true });
              }
              const payload = shapeReply(out);
              persistReply(payload);
              if (hub) {
                hub.emit('reply', payload);
                hub.emit('done', {});
                hub.finish();
              }
              sendJSON(res, payload);
            })
            .catch((e) => {
              const { status, error } = mapError(e);
              if (hub) {
                hub.emit('error', { error, status });
                hub.emit('done', {});
                hub.finish();
              }
              if (!res.headersSent) sendJSON(res, { error }, status);
            });
        } catch (e) {
          sendJSON(res, { error: 'Invalid request' }, 400);
        }
      });
      return;
    }

    // === Notifications + Web Push routes ===
    if (notificationRoutes.ROUTE_PREFIXES.includes(parts[0])) {
      const handled = await notificationRoutes.handle(req, res, parts, { registry });
      if (handled) return;
    }

    // === Export download + import routes (#617) ===
    if (dataRoutes.ROUTE_PREFIXES.includes(parts[0])) {
      const handled = await dataRoutes.handle(req, res, parts);
      if (handled) return;
    }

    // === Voice endpoints ===

    // GET /api/instance — branding + runtime identity (for frontend)
    if (parts[0] === 'instance' && parts.length === 1 && req.method === 'GET') {
      return sendJSON(res, {
        name: ENV.INSTANCE_NAME,
        chatAgent: {
          name: ENV.CHAT_AGENT_NAME,
          emoji: ENV.CHAT_AGENT_EMOJI,
        },
        demo: !!ENV.KLEBB_DEMO,
        cloud: !!ENV.KLEBB_CLOUD,
      });
    }

    // POST /api/user/tz — capture the user's IANA timezone for the
    // notifications scheduler. The browser posts this on every session
    // boot; the server only writes when the value changed.
    if (parts[0] === 'user' && parts[1] === 'tz' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { return sendJSON(res, { error: 'invalid JSON body' }, 400); }
        try {
          const result = userTz.writeUserTz(parsed.tz);
          return sendJSON(res, { ok: true, tz: result.tz, changed: result.changed });
        } catch (e) {
          if (e.code === 'INVALID_TZ') return sendJSON(res, { error: 'invalid tz' }, 400);
          return sendJSON(res, { error: e.message || 'tz write failed' }, 500);
        }
      });
      return;
    }

    // Voice is disabled in demo mode. Every /api/voice/* path returns 503
    // before falling through to the real handlers below.
    if (ENV.KLEBB_DEMO && parts[0] === 'voice') {
      return sendJSON(res, { error: 'Voice disabled in demo mode', demo: true }, 503);
    }

    // GET /api/voice/config — current Fish Audio status (backend tier, credit, voiceId)
    if (parts[0] === 'voice' && parts[1] === 'config' && parts.length === 2 && req.method === 'GET') {
      voice.getStatus().then(s => sendJSON(res, s)).catch(e => sendJSON(res, { error: e.message }, 500));
      return;
    }

    // POST /api/voice/tts — body { text } -> JSON { key, url, contentType, byteLength }
    // Generates TTS, caches the buffer, returns a GET URL the client can set
    // as an <audio> src. The GET endpoint below serves with Content-Length +
    // Range support (critical for iOS auto-play).
    if (parts[0] === 'voice' && parts[1] === 'tts' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { text, format } = JSON.parse(body);
          if (!text || typeof text !== 'string' || !text.trim()) {
            return sendJSON(res, { error: 'text required' }, 400);
          }
          // Strip markdown / URLs so Fish doesn't read syntax aloud
          // ("asterisk asterisk bold asterisk asterisk"). Cache keys
          // off the cleaned text so repeated speakings hit cache.
          const cleaned = sanitiseForTts(text);
          if (!cleaned) return sendJSON(res, { error: 'text required' }, 400);
          const capped = cleaned.slice(0, 4000);
          const fmt = format === 'wav' ? 'wav' : 'mp3';
          const voiceId = require('./voice/fish').getCurrentBackend ? undefined : undefined;
          const key = voiceCache.hashKey(capped, 'default', fmt);
          let entry = voiceCache.get(key);
          if (!entry) {
            const { buffer, contentType } = await voice.ttsBuffer({ text: capped, format: fmt });
            voiceCache.set(key, buffer, contentType || `audio/${fmt === 'wav' ? 'wav' : 'mpeg'}`);
            entry = voiceCache.get(key);
          }
          return sendJSON(res, {
            key,
            url: `/api/voice/tts/${key}`,
            contentType: entry.contentType,
            byteLength: entry.buffer.length,
          });
        } catch (e) {
          console.error('[voice] tts error:', e.message);
          return sendJSON(res, { error: e.message || 'tts failed' }, 500);
        }
      });
      return;
    }

    // GET /api/voice/tts/:key — serves cached TTS bytes with full Content-Length
    // and Range support. iOS's media pipeline probes with Range: bytes=0-1
    // before issuing the full fetch; we must honour it with 206 Partial Content
    // or auto-play silently fails.
    if (parts[0] === 'voice' && parts[1] === 'tts' && parts.length === 3 && req.method === 'GET') {
      const entry = voiceCache.get(parts[2]);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      const total = entry.buffer.length;
      const rangeHeader = req.headers['range'];

      // Handle Range: bytes=start-end (end optional)
      if (rangeHeader) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
          if (start >= total || start > end) {
            res.writeHead(416, {
              'Content-Range': `bytes */${total}`,
              'Content-Type': entry.contentType,
            });
            return res.end();
          }
          const chunk = entry.buffer.slice(start, end + 1);
          res.writeHead(206, {
            'Content-Type': entry.contentType,
            'Content-Length': chunk.length,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
          });
          return res.end(chunk);
        }
      }

      // Full response
      res.writeHead(200, {
        'Content-Type': entry.contentType,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      });
      return res.end(entry.buffer);
    }

    // POST /api/voice/asr — body: raw audio bytes -> { text }
    if (parts[0] === 'voice' && parts[1] === 'asr' && parts.length === 2 && req.method === 'POST') {
      const chunks = [];
      let total = 0;
      const MAX = 20 * 1024 * 1024;
      req.on('data', c => {
        total += c.length;
        if (total > MAX) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        try {
          let audio = Buffer.concat(chunks);
          if (audio.length === 0) return sendJSON(res, { error: 'empty audio' }, 400);

          // Fish ASR is fussy about input codec. Transcode everything to
          // 16kHz mono 16-bit WAV (the only format Fish ASR reliably accepts)
          // unless the body is already WAV.
          const incomingType = (req.headers['content-type'] || '').toLowerCase();
          const isWav =
            incomingType.includes('wav') ||
            incomingType.includes('x-wav') ||
            (audio.length >= 12 && audio.slice(0, 4).toString() === 'RIFF' && audio.slice(8, 12).toString() === 'WAVE');

          if (!isWav) {
            try {
              audio = await transcodeToWav(audio);
            } catch (tErr) {
              console.error('[voice] ffmpeg transcode failed:', tErr.message);
              return sendJSON(res, { error: 'audio transcode failed: ' + tErr.message }, 500);
            }
          }

          const { text, duration } = await voice.asr({ audio, language: 'en' });
          return sendJSON(res, { text, duration });
        } catch (e) {
          console.error('[voice] asr error:', e.message);
          return sendJSON(res, { error: e.message || 'asr failed' }, 500);
        }
      });
      return;
    }

    // === End voice endpoints ===

    // POST /api/reports/upload — body: raw file bytes, filename in a header.
    //
    // One file per request as an octet stream: no multipart parser (and so no
    // dependency), following the precedent set by POST /api/voice/asr. The
    // filename travels in X-Klebb-Filename URL-encoded, because HTTP headers
    // are latin-1 and a raw "Résultats.pdf" either corrupts or throws.
    //
    // Guard order matters: everything cheap and everything that can reject
    // happens BEFORE the body is read, so a large non-allow-listed file is
    // never streamed to disk just to be deleted.
    if (parts[0] === 'reports' && parts[1] === 'upload' && parts.length === 2 && req.method === 'POST') {
      // Reject without ever staging the body. The body is discarded with
      // resume() rather than destroy(): destroying the request tears down the
      // shared socket, so the client sees ECONNRESET instead of the status and
      // message it needs to show the user. resume() streams the remainder to
      // nowhere (no buffer, no disk), and Connection: close ends the socket
      // once the client stops talking.
      const rejectBeforeBody = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify(payload));
        req.resume();
      };

      if (ENV.KLEBB_DEMO) {
        return rejectBeforeBody(403, { error: 'Not available in demo mode' });
      }
      // Origin-allowlisted like the feedback and notification POSTs. The custom
      // header already forces a preflight for a cross-origin fetch, but a
      // sibling subdomain sharing the cookie is not cross-origin to it, and the
      // three mutating routes below have no such header to rely on at all.
      if (!originAllowed(req)) {
        return rejectBeforeBody(403, { error: 'origin not allowed' });
      }

      const rawHeader = req.headers['x-klebb-filename'];
      if (!rawHeader || typeof rawHeader !== 'string') {
        return rejectBeforeBody(400, { error: 'X-Klebb-Filename header is required' });
      }
      let decoded;
      try {
        decoded = decodeURIComponent(rawHeader);
      } catch {
        return rejectBeforeBody(400, { error: 'X-Klebb-Filename must be URL-encoded' });
      }

      // basename first (kills "../../etc/passwd" and any drive/UNC prefix),
      // then sanitise the stem, then re-attach the extension we validated.
      // The name never leaves the inbox dir even before the containment check.
      const ext = path.extname(path.basename(decoded)).toLowerCase();
      if (!ALLOWED_UPLOAD_EXTS.includes(ext)) {
        return rejectBeforeBody(400, {
          error: `Unsupported file type: ${ext || '(no extension)'} is not supported`,
          allowed: ALLOWED_UPLOAD_EXTS,
        });
      }
      const stem = sanitiseStem(path.parse(path.basename(decoded)).name);
      if (!stem) {
        return rejectBeforeBody(400, { error: 'filename is empty after sanitising' });
      }

      const q = catalogue.quota();
      if (q.remaining < 1) {
        return rejectBeforeBody(409, {
          error: `Report cap reached (${q.max}). Delete a report to upload another.`,
          used: q.used,
          max: q.max,
        });
      }

      // Staging path is unique per request rather than derived from the final
      // name: two concurrent uploads of one filename would otherwise share a
      // .part file and interleave their bytes into a corrupt hybrid.
      const partAbs = path.join(PATHS.INBOX_DIR,
        `.${stem}${ext}.${crypto.randomBytes(6).toString('hex')}.part`);
      const inboxWithSep = PATHS.INBOX_DIR + path.sep;
      if (!path.join(PATHS.INBOX_DIR, `${stem}${ext}`).startsWith(inboxWithSep)
        || !partAbs.startsWith(inboxWithSep)) {
        return rejectBeforeBody(400, { error: 'invalid filename' });
      }
      // The final name is claimed at RENAME time, not now. Resolving it up front
      // let two concurrent uploads of one filename both see the same free name
      // (neither has been renamed into place yet), and the second rename then
      // silently clobbered the first document.
      //
      // link() is the atomic claim: it fails with EEXIST rather than
      // overwriting, which rename() does not. Falls back to rename on a
      // filesystem without hard links, where the up-front race is no worse than
      // it was before.
      const claimInboxName = () => {
        for (let i = 1; i < 1000; i++) {
          const candidate = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
          const target = path.join(PATHS.INBOX_DIR, candidate);
          try {
            fs.linkSync(partAbs, target);
            try { fs.unlinkSync(partAbs); } catch {}
            return candidate;
          } catch (e) {
            if (e.code === 'EEXIST') continue;
            if (e.code === 'EPERM' || e.code === 'ENOSYS' || e.code === 'EXDEV') {
              if (fs.existsSync(target)) continue;
              fs.renameSync(partAbs, target);
              return candidate;
            }
            throw e;
          }
        }
        throw new Error('could not allocate an inbox name (1000 collisions)');
      };

      try { fs.mkdirSync(PATHS.INBOX_DIR, { recursive: true }); } catch {}

      // Reserve the slot for the duration of the body stream: a .part file is
      // dot-prefixed and so invisible to the quota's inbox count, and without
      // the reservation two concurrent uploads at used == max-1 both pass the
      // pre-check above and land max+1 reports.
      catalogue.notePendingUpload();
      let reservationHeld = true;
      const releaseReservation = () => {
        if (reservationHeld) { reservationHeld = false; catalogue.releasePendingUpload(); }
      };

      const MAX_BYTES = 15 * 1024 * 1024;
      let total = 0;
      let settled = false;
      const sink = fs.createWriteStream(partAbs);

      // Unlink only once the write handle is actually closed: an open handle
      // blocks the unlink on Windows, which would leave the .part orphan the
      // cleanup exists to prevent.
      const cleanupPart = () => {
        const unlink = () => { try { fs.unlinkSync(partAbs); } catch {} };
        if (sink.closed || sink.destroyed) return unlink();
        sink.once('close', unlink);
        sink.destroy();
      };
      // Cleanup runs on every terminal event, not just the size cap: an
      // aborted request leaves an orphan .part otherwise.
      const abandon = (statusCode, payload) => {
        if (settled) return;
        settled = true;
        releaseReservation();
        cleanupPart();
        if (statusCode) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(JSON.stringify(payload));
          req.resume();
        }
      };

      sink.on('error', e => abandon(500, { error: `could not stage upload: ${e.message}` }));
      req.on('aborted', () => abandon(null, null));
      req.on('error', () => abandon(null, null));
      // A client that walks away without an explicit abort event.
      res.on('close', () => { if (!settled) abandon(null, null); });

      req.on('data', chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BYTES) {
          return abandon(413, { error: 'File too large (15 MB limit)', maxBytes: MAX_BYTES });
        }
        sink.write(chunk);
      });

      req.on('end', () => {
        if (settled) return;
        if (total === 0) return abandon(400, { error: 'empty upload' });
        sink.end(() => {
          if (settled) return;
          settled = true;
          let safeName;
          try {
            // Atomic within one filesystem. Until this claim the drain never
            // sees the file (dot-prefixed); after it, the file is complete by
            // construction, which is why no mtime-stability wait is needed.
            safeName = claimInboxName();
          } catch (e) {
            releaseReservation();
            cleanupPart();
            return sendJSON(res, { error: `could not stage upload: ${e.message}` }, 500);
          }
          // The file is now visible to quota()'s inbox count, so the
          // reservation must go at the same instant or it double-counts.
          releaseReservation();
          inbox.enqueue(path.join(PATHS.INBOX_DIR, safeName));
          const after = catalogue.quota();
          return sendJSON(res, {
            accepted: true,
            filename: safeName,
            used: after.used,
            max: after.max,
          }, 202);
        });
      });
      return;
    }

    // GET /api/reports — quota + reports + in-flight + failures
    if (parts[0] === 'reports' && parts.length === 1 && req.method === 'GET') {
      try {
        return sendJSON(res, reportsApi.envelope());
      } catch (e) {
        console.warn('[reports] list failed:', e.message);
        return sendJSON(res, { quota: { used: 0, max: ENV.REPORTS_MAX, remaining: 0 }, reports: [], processing: [], failed: [] });
      }
    }

    // GET /api/reports/:name/source — the archived original, for the OCR
    // compare view. Inline rather than a download, and never cached: it is the
    // most sensitive artefact in the instance (the only copy that still carries
    // the patient's identifiers).
    if (parts[0] === 'reports' && parts.length === 3 && parts[2] === 'source' && req.method === 'GET') {
      const name = decodeURIComponent(parts[1]);
      const found = reportsApi.readReportFile(name);
      if (found.error) return send404(res, found.notFound ? 'Report not found' : found.error);
      if (!found.header) return send404(res, 'This report has no archived original');
      const abs = reportsApi.resolveSource(found.header);
      if (!abs || !fs.existsSync(abs)) return send404(res, 'Original file not found');
      let stat;
      try { stat = fs.statSync(abs); } catch { return send404(res, 'Original file not found'); }
      res.writeHead(200, {
        'Content-Type': reportsApi.sourceContentType(abs),
        'Content-Length': stat.size,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
      });
      return fs.createReadStream(abs).pipe(res);
    }

    // GET /api/reports/:name/text — the extracted text alone, for the compare
    // view. /report/<name> renders a whole styled HTML page, so the client
    // cannot use it here: stripping frontmatter out of rendered markup with a
    // regex leaks the header into the pane the human is meant to be checking.
    if (parts[0] === 'reports' && parts.length === 3 && parts[2] === 'text' && req.method === 'GET') {
      const found = reportsApi.readReportFile(decodeURIComponent(parts[1]));
      if (found.error) return send404(res, found.notFound ? 'Report not found' : found.error);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store',
      });
      return res.end(reportsApi.bodyText(found.text));
    }

    // POST /api/reports/:name/verify — the human has compared the OCR text
    // against the original and it reads correctly.
    if (parts[0] === 'reports' && parts.length === 3 && parts[2] === 'verify' && req.method === 'POST') {
      if (ENV.KLEBB_DEMO) return sendJSON(res, { error: 'Not available in demo mode' }, 403);
      if (!originAllowed(req)) return sendJSON(res, { error: 'origin not allowed' }, 403);
      const result = reportsApi.verifyReport(decodeURIComponent(parts[1]));
      if (result.error) {
        return sendJSON(res, { error: result.error }, result.status || (result.notFound ? 404 : 400));
      }
      return sendJSON(res, result);
    }

    // POST /api/reports/:name/reprocess — re-extract the archived original and
    // re-comprehend, overwriting the SAME report. Body may carry {psm} to pick
    // an OCR rung; the default advances one rung from whatever was recorded.
    if (parts[0] === 'reports' && parts.length === 3 && parts[2] === 'reprocess' && req.method === 'POST') {
      if (ENV.KLEBB_DEMO) return sendJSON(res, { error: 'Not available in demo mode' }, 403);
      if (!originAllowed(req)) return sendJSON(res, { error: 'origin not allowed' }, 403);
      const name = decodeURIComponent(parts[1]);
      let body = '';
      // utf8 decoding is installed on the STREAM, so a multi-byte character
      // split across TCP chunks is carried over rather than becoming two
      // replacement characters. Without it, `body += chunk` decodes each
      // chunk independently and silently corrupts accented or curly-quoted
      // text in any sufficiently large request.
      req.setEncoding('utf8');
      req.on('data', c => body += c);
      req.on('end', () => {
        const found = reportsApi.readReportFile(name);
        if (found.error) {
          return sendJSON(res, { error: found.error }, found.notFound ? 404 : 400);
        }
        if (!found.header) {
          return sendJSON(res, { error: 'this report was authored by hand; there is nothing to reprocess' }, 403);
        }
        const source = reportsApi.resolveSource(found.header);
        if (!source || !fs.existsSync(source)) {
          // The report itself is left alone: losing it because its original is
          // missing would be a strictly worse outcome than a failed retry.
          return sendJSON(res, { error: 'the original file for this report is no longer available, so it cannot be reprocessed' }, 404);
        }
        let requested = null;
        try { requested = JSON.parse(body || '{}').psm ?? null; } catch {}
        const psm = Number.isInteger(requested) ? requested : nextPsm(found.header.ocrPsm);
        inbox.enqueue(source, {
          psm,
          overwriteName: name,
          archiveName: path.basename(source),
        });
        return sendJSON(res, { accepted: true, name, psm }, 202);
      });
      return;
    }

    // DELETE /api/reports/:name — remove the report and its archived original,
    // freeing a quota slot.
    if (parts[0] === 'reports' && parts.length === 2 && req.method === 'DELETE') {
      if (ENV.KLEBB_DEMO) return sendJSON(res, { error: 'Not available in demo mode' }, 403);
      if (!originAllowed(req)) return sendJSON(res, { error: 'origin not allowed' }, 403);
      let result;
      try {
        result = reportsApi.deleteReport(decodeURIComponent(parts[1]));
      } catch (e) {
        return sendJSON(res, { error: `could not delete report: ${e.message}` }, 500);
      }
      if (result.error) {
        return sendJSON(res, { error: result.error }, result.status || (result.notFound ? 404 : 400));
      }
      const q = catalogue.quota();
      return sendJSON(res, { ...result, used: q.used, max: q.max });
    }

    return send404(res);
  }

  // /register -> serve setup.html (keeps the URL clean for invite links)
  if (pathname === '/register') {
    const fp = path.join(PUBLIC_DIR, 'setup.html');
    return serveStaticFile(res, fp) || send404(res);
  }

  // Report routes: /report/<name> serves REPORTS_DIR/<name>.md as styled HTML
  if (pathname.startsWith('/report/')) {
    const reportName = pathname.replace('/report/', '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!reportName) return send404(res, 'Report not found');

    // Try multiple naming patterns
    const candidates = [
      path.join(REPORTS_DIR, `${reportName}.md`),
      path.join(REPORTS_DIR, `${reportName.toUpperCase()}.md`),
      path.join(REPORTS_DIR, reportName.replace(/^debrief-/, 'DEBRIEF-') + '.md'),
    ];

    let md = null;
    for (const candidate of candidates) {
      try {
        if (candidate.startsWith(REPORTS_DIR)) {
          md = fs.readFileSync(candidate, 'utf8');
          break;
        }
      } catch {}
    }

    if (!md) return send404(res, 'Report not found');

    // A report body is untrusted text. It is the extracted content of an
    // uploaded document whenever comprehension degrades to `raw`, and the
    // model's output otherwise, and `marked` passes raw HTML straight through.
    // Escaping the angle brackets before parsing keeps markdown formatting
    // (headings, lists, tables all still render) while making an embedded
    // <script> inert. The CSP below is defence in depth: it forbids inline
    // script and any outbound connection, so even a future sanitiser slip
    // cannot exfiltrate the archived original, which is the one artefact still
    // carrying the patient's identifiers.
    const safeMd = md.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const content = marked.parse(safeMd);
    const html = renderReportPage(reportName, content);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
    });
    res.end(html);
    return;
  }

  // schedule.mjs lives at the repo root so the server (CJS) and the
  // browser can share one source file. Exact-path carve-out: only this
  // file is served from outside PUBLIC_DIR; no general /lib/* window.
  if (pathname === '/lib/schedule.mjs') {
    const schedulePath = path.join(__dirname, 'lib', 'schedule.mjs');
    if (serveStaticFile(res, schedulePath)) return;
    return send404(res);
  }

  // Static file serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send404(res);
  }

  // Demo mode does not deliver Web Push: 404 the SW so registration on the
  // public demo fails harmlessly instead of capturing a subscription that
  // would later be ignored. Manifest stays served (the demo can install
  // as a PWA, it just won't get push).
  if (pathname === '/sw.js' && ENV.KLEBB_DEMO) {
    return send404(res);
  }

  const extraHeaders = staticHeadersFor(pathname);
  if (serveStaticFile(res, filePath, extraHeaders)) return;

  // SPA fallback: serve index.html for client-side routes. Apply the
  // index-only headers (CSP) so deep-linked routes get the same policy.
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  serveStaticFile(res, indexPath, staticHeadersFor('/'));
});

server.listen(PORT, HOST, async () => {
  console.log(`Health dashboard running at http://${HOST}:${PORT} (TZ=${ENV.TZ})`);

  // First-boot passkey bootstrap. When the credential store is empty:
  //   - self-hosted: print the /register URL so the operator (reading the
  //     logs) can claim the instance. First-visitor bootstrap is open.
  //   - Cloud (KLEBB_CLOUD=1): don't print; the control plane mints an
  //     invite and emails the claim link to the customer's own subdomain.
  try {
    if (!isSetup() && !ENV.KLEBB_DEMO) {
      if (ENV.KLEBB_CLOUD) {
        console.log('[bootstrap] no passkeys yet; awaiting a control-plane invite (Cloud mode).');
      } else {
        console.log(`[bootstrap] no passkeys yet. Register the first one at ${ENV.WEBAUTHN_ORIGIN}/register`);
      }
    }
  } catch {}

  // Import crash recovery (#617). MUST run before first-boot seeding and
  // before the samples drain: a crash mid-apply leaves a half-wiped or
  // half-copied tree, and a boot that seeded a welcome card over it (or
  // drained a half-staged samples file) would present the wreckage as
  // truth. On 'refuse', the rest of boot is skipped and the request gate
  // above serves 503 IMPORT_RECOVERY_FAILED for everything but /healthz,
  // import status and rollback.
  try {
    const rec = await recoverAtBoot({ home: PATHS.HEALTH_HOME });
    if (rec.action === 'refuse') {
      importRecoveryRefusedReason = rec.reason;
      console.error('[import] BOOT RECOVERY FAILED:', rec.reason);
      console.error('[import] refusing to serve; only /healthz, /api/import/status and /api/import/rollback answer');
    } else if (rec.action === 'resumed') {
      console.log(`[import] resumed an interrupted import from the ${rec.source}: ${rec.result.state}`);
    }
  } catch (e) {
    importRecoveryRefusedReason = `boot recovery threw: ${e.message}`;
    console.error('[import] BOOT RECOVERY FAILED:', e.message);
  }

  // First-boot welcome card. Only seeds when HEALTH_HOME/data is empty.
  if (!importRecoveryRefusedReason) {
    try {
      runFirstBoot({ dataDir: PATHS.DATA_DIR });
    } catch (e) {
      console.warn('[first-boot] error (continuing):', e.message);
    }
  }

  // HAE push history from an exported tree: data/auto-export/samples.json is a
  // one-way import inbox, exactly like a card file's `data` block. Runs BEFORE
  // registry.init(), because init replays HAE-backed cards from the samples
  // table and would otherwise find it empty on the first boot of a restore.
  if (!importRecoveryRefusedReason) {
    try {
      const imported = await haeSamplesInbox.drain();
      if (imported) {
        console.log(`[hae] imported ${imported.pushes} push(es) from samples.json; `
          + `${imported.inserted} new sample(s)`);
      }
    } catch (e) {
      console.warn('[hae] samples import failed:', e.message);
    }
  }

  // Initialise manifest registry (discovers + watches data files). Skipped
  // on a refused boot: loading the half-applied cards would dress the
  // wreckage up as a working registry behind the 503 gate.
  if (!importRecoveryRefusedReason) {
    try {
      const stats = registry.init();
      console.log(`[manifest] loaded ${stats.count} card(s); ${stats.errors} error(s)`);
    } catch (e) {
      console.error('[manifest] init failed:', e.message);
    }
  }

  // Drain the inbox: anything left behind by a crash mid-extract, plus the
  // operator door (`docker cp` + restart). Uploads enqueue directly.
  // Failures inside the pipeline land in inbox/_failed/, so a bad file
  // should never wedge boot.
  if (!importRecoveryRefusedReason) {
    try {
      const { queued } = inbox.start();
      console.log(`[ingest] inbox drained; ${queued} file(s) queued`);
    } catch (e) {
      console.warn('[ingest] drain failed:', e.message);
    }
  }

  // Notifications scheduler: 1-minute tick, evaluates triggers, fires
  // due notifications. Disabled in demo mode (the demo doesn't deliver
  // push). The dispatch path is logging-only in v3.0.0; PR #386 wires
  // up the real Web Push send.
  if (!ENV.KLEBB_DEMO && !importRecoveryRefusedReason) {
    try {
      registry.onDelete((id) => notificationsState.pruneCard(id));
      notificationsScheduler.setDispatch(webPushSend.dispatch);
      notificationsScheduler.start(registry);
      console.log('[notifications] scheduler started');
    } catch (e) {
      console.warn('[notifications] scheduler init failed:', e.message);
    }
  }

  // Open the request gate: every block above catches its own failures, so
  // this line is always reached and parked requests resume in order.
  _booting = false;
  _bootSettled();
});

// Graceful shutdown: stop the scheduler so the test harness's SIGTERM
// doesn't leave a stray timer keeping the process alive.
// SIGTERM/SIGINT: stop the scheduler so a stray timer cannot keep the process
// alive, then CLOSE THE DATASTORE. Closing checkpoints the WAL into klebb.db,
// so a `docker stop` followed by a plain copy of db/ cannot miss recent writes.
// Guarded and synchronous: an exit that hangs on shutdown is worse than one that
// skips a checkpoint, so anything that throws is logged and we still exit.
function _shutdown() {
  try { notificationsScheduler.stop(); } catch {}
  try { registry.closeStore(); } catch (e) {
    console.warn('[shutdown] datastore close failed:', e.message);
  }
  // A second handle on the same database file, so it needs its own close for
  // the WAL to be fully checkpointed into klebb.db.
  try { haeSamples.close(); } catch (e) {
    console.warn('[shutdown] samples close failed:', e.message);
  }
  // Third handle, same reason.
  try { if (_conversationsStore) _conversationsStore.close(); } catch (e) {
    console.warn('[shutdown] conversations close failed:', e.message);
  }
  process.exit(0);
}
process.on('SIGTERM', _shutdown);
process.on('SIGINT', _shutdown);
