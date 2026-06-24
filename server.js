// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');
const { isAuthenticated, isAgentRequest, isPublicPath, handleAuthRoutes, isSetup } = require('./auth/webauthn');
const PATHS = require('./config/paths');
const ENV = require('./config/env');
const registry = require('./manifests/registry');
const { convertDateKeyedToArray } = require('./scripts/migrate-date-keyed-to-array');
const { runFirstBoot } = require('./server/first-boot');
const { listTemplates, listPrompts } = require('./server/content');
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
const { describeCatalogue: describeHaeCatalogue } = require('./health-auto-export/describe');
const userTz = require('./lib/user-tz');
const feedback = require('./lib/feedback');
const notificationsState = require('./lib/notifications-state');
const notificationsScheduler = require('./lib/notifications-scheduler');
const webPushSend = require('./lib/web-push-send');
const notificationRoutes = require('./routes/notifications');
const { CATEGORIES: MANIFEST_CATEGORIES } = require('./config/categories');
const ccSuggestions = require('./meta/cc-suggestions');
const { describeCcSchema } = require('./chat/describe-cc-schema');
const { describeDocsCatalogue } = require('./chat/docs');
const { describeReportsCatalogue } = require('./chat/reports');
const inbox = require('./ingest/pipeline');

// chat endpoint config (env-driven; see config/env.js)
const CHAT_ENDPOINT_URL = ENV.CHAT_ENDPOINT_URL;
const CHAT_API_KEY = ENV.CHAT_API_KEY;
const CHAT_MODEL = ENV.CHAT_MODEL;
const DEBUG_LOG = ENV.DEBUG_LOG;
const CHAT_ITER_TIMEOUT_MS = ENV.CHAT_ITER_TIMEOUT_MS;
const GATEWAY_HARD_TIMEOUT_MS = 180000;
const NO_TOOL_FITS_REFUSAL =
  "I can't do that in one step right now: it doesn't fit any of the tools I have, and the workaround would have to rewrite the whole card (which times out on cards this size). If you tell me which slice of the card you want changed, I can usually do that with a row-level edit.";

// Forensic logging for the chat agent loop. Off by default; flip on with
// HEALTH_DEBUG=1. Emits structural facts only (durations, counts, tool
// names, manifest ids) so a journal grep can reconstruct a stuck turn
// without exposing prompt or reply bodies.
function chatLog(reqId, ...parts) {
  if (DEBUG_LOG) console.log(`[chat:${reqId}]`, ...parts);
}
const CHAT_ENDPOINT = CHAT_ENDPOINT_URL ? (() => {
  const u = new URL(CHAT_ENDPOINT_URL);
  return {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    transport: u.protocol === 'https:' ? https : http,
  };
})() : null;

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

// Legacy-aware helper: returns the data block if the file is a v2 manifest,
// otherwise the raw parsed content. Lets legacy endpoints keep working
// after migration without rewriting each handler.
function readLegacyJSONFile(filePath) {
  const data = readJSONFile(filePath);
  if (data && typeof data === 'object' && data.$schema === 'klebb.datafile.v1') {
    return data.data;
  }
  return data;
}

// Legacy-aware write: preserves meta/description/schema when writing back
// to a v2 manifest file; otherwise writes the raw value.
function writeLegacyJSONFile(filePath, newData) {
  const existing = readJSONFile(filePath);
  if (existing && typeof existing === 'object' && existing.$schema === 'klebb.datafile.v1') {
    const merged = { ...existing, data: newData };
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, filePath);
    return;
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(newData, null, 2));
  fs.renameSync(tmp, filePath);
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

function getWeightRange(start, end) {
  const weights = readJSONFile(path.join(DATA_DIR, 'weight.json'));
  if (!weights) return [];
  // Unwrap v2 manifest
  const arr = (weights && weights.$schema === 'klebb.datafile.v1') ? weights.data : weights;
  if (!Array.isArray(arr)) return [];
  return arr.filter(w => w.date >= start && w.date <= end);
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

// POST one chat-completions payload to the configured gateway and return the
// parsed JSON response. Promise rejects with a typed Error so the caller can
// map to the right HTTP status:
//   'gateway_unavailable: <msg>'  -> 502
//   'gateway_timeout'             -> 504
//   'gateway_parse: <msg>'        -> 500
// Preserves the existing transport options (no keep-alive, self-signed TLS
// tolerated, 180s per-hop timeout).
function callGateway({ messages, tools, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (!CHAT_ENDPOINT) return reject(new Error('gateway_unavailable: CHAT_ENDPOINT_URL not set'));
    const body = { model: CHAT_MODEL, messages };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const payload = JSON.stringify(body);
    const options = {
      hostname: CHAT_ENDPOINT.hostname,
      port: CHAT_ENDPOINT.port,
      path: CHAT_ENDPOINT.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHAT_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
        'Connection': 'close',
      },
      rejectUnauthorized: false,
      agent: false,
    };
    const proxyReq = CHAT_ENDPOINT.transport.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', c => data += c);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('gateway_parse: ' + e.message)); }
      });
    });
    proxyReq.on('error', (e) => reject(new Error('gateway_unavailable: ' + e.message)));
    const effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0)
      ? Math.min(timeoutMs, GATEWAY_HARD_TIMEOUT_MS)
      : GATEWAY_HARD_TIMEOUT_MS;
    const isSoftCap = effectiveTimeout < GATEWAY_HARD_TIMEOUT_MS;
    proxyReq.setTimeout(effectiveTimeout, () => {
      proxyReq.destroy();
      reject(new Error(isSoftCap ? 'gateway_iter_timeout' : 'gateway_timeout'));
    });
    proxyReq.write(payload);
    proxyReq.end();
  });
}

// Run the OpenAI-compatible tool-calling loop. Each iteration:
//   1. call the gateway with current messages (+ TOOL_DEFS)
//   2. if finish_reason is 'tool_calls', execute each tool_call, append the
//      assistant turn and one {role:"tool"} per call, loop.
//   3. otherwise, return the assistant's text as the final reply.
// Caps at MAX_ITERS to keep a misbehaving model from looping forever; if we
// hit the cap we return the last text we saw (or a fallback).
async function runAgentLoop({ systemPrompt, userMessages, reqId = '-' }) {
  const MAX_ITERS = 5;
  const messages = [{ role: 'system', content: systemPrompt }, ...userMessages];
  const ctx = { touches: [] };
  let lastAssistantText = '';
  for (let i = 0; i < MAX_ITERS; i++) {
    const gwStart = Date.now();
    let gw;
    try {
      gw = await callGateway({ messages, tools: TOOL_DEFS, timeoutMs: CHAT_ITER_TIMEOUT_MS });
    } catch (e) {
      if (e && e.message === 'gateway_iter_timeout') {
        const gwMs = Date.now() - gwStart;
        chatLog(reqId, `iter=${i} gw=${gwMs}ms iter_timeout`);
        return {
          finalText: NO_TOOL_FITS_REFUSAL,
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
    chatLog(reqId, `iter=${i} gw=${gwMs}ms finish=${finish || '-'} tools=${toolCount}`);

    if (typeof msg.content === 'string' && msg.content.trim()) {
      lastAssistantText = msg.content;
    }

    if (finish === 'tool_calls' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      // Preserve tool_calls on the round-trip; your provider rejects the
      // next turn if the assistant message is missing them.
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls,
      });
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name || '-';
        let manifestId = '-';
        try {
          const args = JSON.parse(tc.function?.arguments || '{}');
          manifestId = args.id || args.manifest?.meta?.id || '-';
        } catch {}
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
    finalText: lastAssistantText ||
      "I wasn't able to finish that in one turn. Please re-ask or be more specific.",
    cappedOut: true,
    ctx,
    iters: MAX_ITERS,
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

// Synthesise the legacy injection-log.json shape { 'YYYY-MM-DD': { 'PeptideName': { taken: true, time: ISO } } }
// from the v2 peptides.json data.items[].doses[]. Called by the legacy
// injection-log endpoints after migration has archived the original file.
function synthesiseLegacyInjectionLog() {
  const raw = readJSONFile(path.join(DATA_DIR, 'peptides.json'));
  if (!raw) return {};
  const items = (raw && raw.$schema === 'klebb.datafile.v1')
    ? ((raw.data && raw.data.items) || [])
    : (raw.peptides || []);
  const result = {};
  for (const item of items) {
    if (!Array.isArray(item.doses)) continue;
    for (const d of item.doses) {
      if (!d.takenAt || !d.scheduledDate) continue;
      if (!result[d.scheduledDate]) result[d.scheduledDate] = {};
      result[d.scheduledDate][item.name] = { taken: true, time: d.takenAt };
    }
  }
  return result;
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
<a href="/" class="back-link">← Back to Dashboard</a>
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Liveness probe — dependency-free, no auth, no FS reads.
  // Used by container healthchecks and external monitors. Must stay cheap.
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Build-info probe — populated at container build time from env vars.
  // Lets the browser show which branch / commit is running so testers can
  // verify they're hitting the right build. No auth: read-only metadata.
  if (pathname === '/api/build') {
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

    // POST /api/manifests/:id/data — full rewrite (honours meta.writeable.fromWebapp)
    if (parts[0] === 'manifests' && parts.length === 3 && parts[2] === 'data' && req.method === 'POST') {
      const entry = registry.get(parts[1]);
      if (!entry) return send404(res, 'manifest not found');
      const w = entry.meta.writeable;
      if (!w || !w.fromWebapp) return sendJSON(res, { error: 'not writeable from webapp' }, 403);
      const fromAgent = isAgentRequest(req);
      let body = '';
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

    // Simple JSON file endpoints
    const simpleFiles = {
      'config': 'config.json',
      'supplements': 'supplements.json',
      'weight': 'weight.json',
      'bloods': 'bloods.json',
      'appointments': 'appointments.json',
      'goals': 'goals.json',
      'peptides': 'peptides.json',
    };

    if (parts.length === 1 && simpleFiles[parts[0]]) {
      const data = readJSONFile(path.join(DATA_DIR, simpleFiles[parts[0]]));
      if (data) {
        // Transparent v2 unwrap: if the file is a v2 manifest, return only
        // the data block to keep legacy clients (and the current UI) happy.
        if (data && typeof data === 'object' && data.$schema === 'klebb.datafile.v1') {
          let payload = data.data;
          // Special-case: the legacy frontend expects peptides.json to have
          // 'peptides' and 'injection_groups' keys. The v2 manifest uses
          // 'items' and 'groups'. Alias them back here for the legacy UI.
          if (parts[0] === 'peptides' && payload && typeof payload === 'object') {
            const aliased = {
              ...payload,
              peptides: Array.isArray(payload.items) ? payload.items : (payload.peptides || []),
              injection_groups: Array.isArray(payload.groups)
                ? payload.groups.map(g => ({
                    name: g.label || g.name || g.id,
                    peptides: g.items || g.peptides || [],
                    timing: g.timing,
                    draw_order: g.draw_order,
                    max_units: g.max_units,
                    notes: g.notes,
                  }))
                : (payload.injection_groups || []),
            };
            return sendJSON(res, aliased);
          }
          return sendJSON(res, payload);
        }
        return sendJSON(res, data);
      }
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
      let body = '';
      let tooBig = false;
      req.on('data', c => {
        body += c;
        if (body.length > HAE_MAX_BODY) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) {
          haeDiagnostics.writeLastPush({
            receivedAt, payloadBytes: body.length,
            subscribers: [], availableUnsubscribed: [],
            warnings: [`payload exceeded ${HAE_MAX_BODY} bytes`],
          });
          return sendJSON(res, { error: 'payload too large' }, 413);
        }

        // Archive the raw payload unconditionally. Stamp carries
        // milliseconds so rapid successive pushes don't clobber each
        // other's archive file.
        const rawDir = path.join(PATHS.AUTO_EXPORT_DIR, 'raw');
        try { fs.mkdirSync(rawDir, { recursive: true }); } catch {}
        const stamp = new Date().toISOString().replace(/[:.]/g, '');
        const rawFile = path.join(rawDir, `${stamp}.json`);
        try { fs.writeFileSync(rawFile, body); } catch (e) {
          console.error('[hae] failed to archive raw payload:', e.message);
        }

        const payloadBytes = Buffer.byteLength(body);

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          haeDiagnostics.writeLastPush({
            receivedAt, payloadBytes,
            subscribers: [], availableUnsubscribed: [],
            warnings: ['parse failed, raw saved'],
          });
          return sendJSON(res, { ok: true, warning: 'parse failed, raw saved' });
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
          return sendJSON(res, { ok: true, warning: 'dispatch failed, raw saved' });
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

    // GET /api/health-auto-export/discoveries — list metrics present in
    // past HAE pushes that no manifest subscribes to. Shape:
    //   { undismissed: [{metric, firstSeenAt}], dismissed: [{metric, ...}] }
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

    // POST /api/feedback — append an anonymised feature-request line.
    // Body: { intent, context?, toolsConsidered? }. Fired by Klebbius (via
    // the note_feature_request tool) when a request is genuinely unsupported,
    // so the operator can review unmet needs. Anonymisation happens in
    // lib/feedback; behind the same global auth gate as every other /api route.
    if (parts[0] === 'feedback' && parts.length === 1 && req.method === 'POST') {
      let body = '';
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

    // GET /api/weight/range/:start/:end
    if (parts[0] === 'weight' && parts[1] === 'range' && parts.length === 4) {
      return sendJSON(res, getWeightRange(parts[2], parts[3]));
    }

    // GET /api/injection-log — get all injection check-offs
    // Prefers legacy injection-log.json if present; otherwise synthesises the
    // legacy shape from peptides.items[].doses[] (after migration).
    if (parts[0] === 'injection-log' && parts.length === 1 && req.method === 'GET') {
      const legacy = readLegacyJSONFile(path.join(DATA_DIR, 'injection-log.json'));
      if (legacy && Object.keys(legacy).length > 0) {
        return sendJSON(res, legacy);
      }
      return sendJSON(res, synthesiseLegacyInjectionLog());
    }

    // GET /api/injection-log/range/:start/:end — get injection log for date range
    if (parts[0] === 'injection-log' && parts[1] === 'range' && parts.length === 4 && req.method === 'GET') {
      let data = readLegacyJSONFile(path.join(DATA_DIR, 'injection-log.json')) || {};
      if (Object.keys(data).length === 0) {
        data = synthesiseLegacyInjectionLog();
      }
      const [, , start, end] = parts;
      const result = {};
      for (const [date, entries] of Object.entries(data)) {
        if (date >= start && date <= end) result[date] = entries;
      }
      return sendJSON(res, result);
    }

    // POST /api/injection-log/:date — toggle an injection check-off
    // Body: { "peptide": "BPC-157", "taken": true }
    if (parts[0] === 'injection-log' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { peptide, taken } = JSON.parse(body);
          if (!peptide) return sendJSON(res, { error: 'peptide required' }, 400);
          const filePath = path.join(DATA_DIR, 'injection-log.json');
          const data = readLegacyJSONFile(filePath) || {};
          const date = parts[1];
          if (!data[date]) data[date] = {};
          if (taken) {
            data[date][peptide] = { taken: true, time: new Date().toISOString() };
          } else {
            delete data[date][peptide];
            if (Object.keys(data[date]).length === 0) delete data[date];
          }
          writeLegacyJSONFile(filePath, data);

          // Write-through to v2 peptides manifest (if present) so the new
          // schedule-timeline/adherence-report see the same check-offs.
          try {
            const peptidesPath = path.join(DATA_DIR, 'peptides.json');
            const raw = readJSONFile(peptidesPath);
            if (raw && raw.$schema === 'klebb.datafile.v1') {
              const items = Array.isArray(raw.data?.items) ? raw.data.items : [];
              const item = items.find(i => i.name === peptide);
              if (item) {
                item.doses = Array.isArray(item.doses) ? item.doses : [];
                const idx = item.doses.findIndex(d => d.scheduledDate === date);
                if (taken) {
                  const now = new Date().toISOString();
                  if (idx >= 0) item.doses[idx] = { ...item.doses[idx], takenAt: now };
                  else item.doses.push({ scheduledDate: date, takenAt: now });
                } else if (idx >= 0) {
                  item.doses.splice(idx, 1);
                }
                const tmp = peptidesPath + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
                fs.renameSync(tmp, peptidesPath);
              }
            }
          } catch (syncErr) {
            console.warn('[sync] peptides manifest update failed:', syncErr.message);
          }

          return sendJSON(res, { ok: true, date, peptide, taken: !!taken });
        } catch (e) {
          console.error('injection-log POST error:', e.message);
          return sendJSON(res, { error: e.message || 'Invalid request' }, 400);
        }
      });
      return;
    }

    // GET /api/injection-log/:date — get injection check-offs for a specific date
    if (parts[0] === 'injection-log' && parts.length === 2 && req.method === 'GET') {
      const data = readLegacyJSONFile(path.join(DATA_DIR, 'injection-log.json'));
      let dateLog = (data || {})[parts[1]] || null;
      if (!dateLog) {
        // Fallback to synthesised view
        const synth = synthesiseLegacyInjectionLog();
        dateLog = synth[parts[1]] || {};
      }
      return sendJSON(res, dateLog);
    }

    // GET /api/calendar/health — fetch health-related events from Google Calendar
    // GET /api/mood/range/:start/:end — get mood for date range
    if (parts[0] === 'mood' && parts[1] === 'range' && parts.length === 4 && req.method === 'GET') {
      const data = readLegacyJSONFile(path.join(DATA_DIR, 'mood.json')) || {};
      const [, , start, end] = parts;
      const result = {};
      for (const [date, entry] of Object.entries(data)) {
        if (date >= start && date <= end) result[date] = entry;
      }
      return sendJSON(res, result);
    }

    // GET /api/mood/:date — get mood check-in for a date
    if (parts[0] === 'mood' && parts.length === 2 && req.method === 'GET') {
      const data = readLegacyJSONFile(path.join(DATA_DIR, 'mood.json'));
      const entry = (data || {})[parts[1]] || null;
      return sendJSON(res, entry);
    }

    // POST /api/mood/:date — save mood check-in
    if (parts[0] === 'mood' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { mood, notes, wakeUps } = JSON.parse(body);
          if (!mood) return sendJSON(res, { error: 'mood required' }, 400);
          const filePath = path.join(DATA_DIR, 'mood.json');
          let data = {};
          try { data = readLegacyJSONFile(filePath) || {}; } catch {}
          const entry = { mood, notes: notes || '', time: new Date().toISOString() };
          if (wakeUps !== null && wakeUps !== undefined) entry.wakeUps = wakeUps;
          data[parts[1]] = entry;
          try {
            writeLegacyJSONFile(filePath, data);
          } catch (writeErr) {
            // If file doesn't exist or isn't writable, try creating it fresh
            console.error('Mood write error, attempting create:', writeErr.message);
            writeLegacyJSONFile(filePath, data);
          }
          return sendJSON(res, { ok: true });
        } catch (e) {
          console.error('Mood POST error:', e.message);
          return sendJSON(res, { error: e.message || 'Invalid request' }, 400);
        }
      });
      return;
    }

    // DELETE /api/mood/:date
    if (parts[0] === 'mood' && parts.length === 2 && req.method === 'DELETE') {
      try {
        const filePath = path.join(DATA_DIR, 'mood.json');
        let data = {};
        try { data = readLegacyJSONFile(filePath) || {}; } catch {}
        delete data[parts[1]];
        writeLegacyJSONFile(filePath, data);
        return sendJSON(res, { ok: true });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 400);
      }
    }

    // GET /api/notes/:date
    if (parts[0] === 'notes' && parts.length === 2 && req.method === 'GET') {
      const filePath = path.join(DATA_DIR, 'daily-notes.json');
      const data = readLegacyJSONFile(filePath) || {};
      return sendJSON(res, data[parts[1]] || { text: '' });
    }

    // POST /api/notes/:date
    if (parts[0] === 'notes' && parts.length === 2 && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body);
          const filePath = path.join(DATA_DIR, 'daily-notes.json');
          let data = {};
          try { data = readLegacyJSONFile(filePath) || {}; } catch {}
          if (text && text.trim()) {
            data[parts[1]] = { text: text.trim(), updated: new Date().toISOString() };
          } else {
            delete data[parts[1]];
          }
          writeLegacyJSONFile(filePath, data);
          return sendJSON(res, { ok: true });
        } catch (e) {
          return sendJSON(res, { error: e.message }, 400);
        }
      });
      return;
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
        req.on('data', c => {
          body += c;
          if (body.length > 512 * 1024) { tooBig = true; req.destroy(); }
        });
        req.on('end', () => {
          if (tooBig) return sendJSON(res, { error: 'History too large' }, 413);
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
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const { messages, voiceMode } = parsed;
          if (!Array.isArray(messages) || messages.length === 0) {
            return sendJSON(res, { error: 'messages required' }, 400);
          }
          if (ENV.KLEBB_DEMO) {
            const reply = `This is a public demo without an AI gateway connected, so ${ENV.CHAT_AGENT_NAME} can't answer questions or add new cards. You can still log data into the existing cards. Run your own instance (klebb.app) to chat with your own data.`;
            return sendJSON(res, voiceMode ? { reply, speak: reply } : { reply });
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

          // Catalogue of reports the user has ingested into
          // $HEALTH_HOME/reports/ via the inbox watcher. Lets the
          // agent pull a blood panel / scan / voice memo into the
          // turn via read_report when the question calls for it.
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

          let systemPrompt = HEALTH_SYSTEM_PROMPT + todayBlock + cardListBlock + haeCatalogueBlock + ccSchemaBlock + docsCatalogueBlock + reportsCatalogueBlock + categoryBlock;
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

` + HEALTH_SYSTEM_PROMPT + todayBlock + cardListBlock + haeCatalogueBlock + ccSchemaBlock + docsCatalogueBlock + reportsCatalogueBlock + categoryBlock;
          }

          // Prepend system prompt
          const fullMessages = [
            { role: 'system', content: systemPrompt },
            ...messages,
          ];

          if (!CHAT_ENDPOINT) {
            return sendJSON(res, { error: 'Chat endpoint not configured' }, 503);
          }

          const reqId = crypto.randomBytes(3).toString('hex');
          const turnStart = Date.now();
          chatLog(reqId, `start turns=${messages.length} voice=${!!voiceMode}`);

          runAgentLoop({ systemPrompt, userMessages: messages, reqId })
            .then(({ finalText, ctx, cappedOut, iterTimedOut, iters }) => {
              const followup = buildFollowup(ctx);
              chatLog(reqId, `done total=${Date.now() - turnStart}ms iters=${iters} capped=${!!cappedOut}${iterTimedOut ? ' iter_timeout' : ''}`);
              if (voiceMode) {
                const parsedReply = extractJsonReply(finalText);
                if (parsedReply && (parsedReply.speak || parsedReply.display)) {
                  const speak = (parsedReply.speak || parsedReply.display || '').trim();
                  const display = (parsedReply.display || parsedReply.speak || '').trim();
                  return sendJSON(res, withFollowup({ reply: display, speak }, followup));
                }
                const speak = finalText.replace(/\p{Extended_Pictographic}/gu, '').trim();
                return sendJSON(res, withFollowup({ reply: finalText || 'No response', speak }, followup));
              }
              sendJSON(res, withFollowup({ reply: finalText || 'No response' }, followup));
            })
            .catch((e) => {
              const msg = e.message || String(e);
              chatLog(reqId, `err total=${Date.now() - turnStart}ms ${msg.split(':')[0]}`);
              if (msg.startsWith('gateway_timeout')) {
                console.error('Chat gateway timeout');
                if (!res.headersSent) sendJSON(res, { error: 'Request timed out' }, 504);
                return;
              }
              if (msg.startsWith('gateway_unavailable')) {
                console.error('Chat proxy error:', msg);
                if (!res.headersSent) sendJSON(res, { error: 'Gateway unavailable' }, 502);
                return;
              }
              console.error('Chat parse error:', msg);
              if (!res.headersSent) sendJSON(res, { error: 'Failed to parse response' }, 500);
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
      });
    }

    // POST /api/user/tz — capture the user's IANA timezone for the
    // notifications scheduler. The browser posts this on every session
    // boot; the server only writes when the value changed.
    if (parts[0] === 'user' && parts[1] === 'tz' && parts.length === 2 && req.method === 'POST') {
      let body = '';
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

    // GET /api/reports — list available report files
    if (parts[0] === 'reports' && parts.length === 1) {
      try {
        // Exclude system prompt / internal files
        const EXCLUDED = new Set(['PEPI_SYSTEM_PROMPT_FOR_ONYX.md', 'PROFILE.md']);
        const files = fs.readdirSync(REPORTS_DIR)
          .filter(f => f.endsWith('.md') && !f.startsWith('.') && !EXCLUDED.has(f));
        const reports = files.map(f => {
          const name = f.replace(/\.md$/, '');
          const content = fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8');
          const titleMatch = content.match(/^#\s+(.+)/m);
          const title = titleMatch ? titleMatch[1] : name;
          // Extract date from filename if present
          const dateMatch = name.match(/\d{4}-\d{2}-\d{2}/);
          return {
            name,
            title,
            date: dateMatch ? dateMatch[0] : null,
            url: `/report/${name}`,
          };
        }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        return sendJSON(res, reports);
      } catch {
        return sendJSON(res, []);
      }
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

    const content = marked.parse(md);
    const html = renderReportPage(reportName, content);
    res.writeHead(200, { 'Content-Type': 'text/html' });
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

server.listen(PORT, HOST, () => {
  console.log(`Health dashboard running at http://${HOST}:${PORT} (TZ=${ENV.TZ})`);

  // First-boot welcome card. Only seeds when HEALTH_HOME/data is empty.
  try {
    runFirstBoot({ dataDir: PATHS.DATA_DIR });
  } catch (e) {
    console.warn('[first-boot] error (continuing):', e.message);
  }

  // Initialise manifest registry (discovers + watches data files)
  try {
    const stats = registry.init();
    console.log(`[manifest] loaded ${stats.count} card(s); ${stats.errors} error(s)`);
  } catch (e) {
    console.error('[manifest] init failed:', e.message);
  }

  // Start the inbox watcher: drains anything left behind from a
  // previous boot, then watches $HEALTH_HOME/inbox/ for new drops.
  // Failures inside the pipeline land in inbox/_failed/, so a
  // broken watcher should never wedge boot.
  try {
    inbox.start();
    console.log('[ingest] inbox watcher started');
  } catch (e) {
    console.warn('[ingest] watcher init failed:', e.message);
  }

  // Notifications scheduler: 1-minute tick, evaluates triggers, fires
  // due notifications. Disabled in demo mode (the demo doesn't deliver
  // push). The dispatch path is logging-only in v3.0.0; PR #386 wires
  // up the real Web Push send.
  if (!ENV.KLEBB_DEMO) {
    try {
      registry.onDelete((id) => notificationsState.pruneCard(id));
      notificationsScheduler.setDispatch(webPushSend.dispatch);
      notificationsScheduler.start(registry);
      console.log('[notifications] scheduler started');
    } catch (e) {
      console.warn('[notifications] scheduler init failed:', e.message);
    }
  }
});

// Graceful shutdown: stop the scheduler so the test harness's SIGTERM
// doesn't leave a stray timer keeping the process alive.
function _shutdown() {
  try { notificationsScheduler.stop(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', _shutdown);
process.on('SIGINT', _shutdown);
