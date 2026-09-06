// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// lib/gateway.js
// One POST to the configured OpenAI-compatible chat-completions endpoint.
//
// Lifted out of server.js unchanged so callers outside the request path can
// reach the gateway too: the report comprehension pass runs from ingest/, and
// requiring server.js back would be a cycle. Config comes from config/env.js
// by default and can be overridden per call, which is what lets a test point
// one call at a stub without touching the process env.
//
// The error strings below are load-bearing, not decorative: /api/chat
// string-matches them to choose a status code, so renaming one silently turns
// a gateway timeout into a 500 "failed to parse response".

const http = require('http');
const https = require('https');
const ENV = require('./../config/env');

// Per-hop ceiling. A single gateway call that runs this long is not going to
// come back usefully.
const GATEWAY_HARD_TIMEOUT_MS = 180000;

function parseEndpoint(url) {
  if (!url) return null;
  const u = new URL(url);
  return {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    transport: u.protocol === 'https:' ? https : http,
  };
}

const DEFAULT_ENDPOINT = ENV.CHAT_ENDPOINT_URL ? parseEndpoint(ENV.CHAT_ENDPOINT_URL) : null;

// A gateway that has run out of allowance answers 429 with a message saying so.
// A 429 WITHOUT that marker is ordinary rate limiting, which is transient and
// must not be reported as an exhausted allowance: telling someone their
// allowance is gone when it is not sends them chasing a limit that is fine.
//
// Matched against the deployed gateway's own wording (its BudgetExceededError
// carries status 429 and one of these message templates). Any
// OpenAI-compatible gateway may be configured, so detection is best-effort by
// design: an unrecognised 429 falls back to transient rather than inventing a
// budget concept the gateway may not have.
const BUDGET_MARKERS = [
  'budget has been exceeded',
  'exceededbudget',
  'exceeded budget',
  'insufficient_quota',
  'quota exceeded',
];

function looksLikeBudgetExhaustion(status, rawBody) {
  if (status !== 429) return false;
  const hay = String(rawBody || '').toLowerCase();
  return BUDGET_MARKERS.some(m => hay.includes(m));
}

// Normalise the `usage` block into one shape, because the gateways in front of
// us do not agree on where cache counters live. Measured against both:
//
//   gateway A: prompt_tokens_details.cached_tokens / .cache_write_tokens
//              (plus a `cost` field), nothing at the top level
//   gateway B: prompt_tokens_details.cached_tokens / .cache_creation_tokens
//              AND top-level cache_read_input_tokens / cache_creation_input_tokens
//
// `prompt_tokens_details.cached_tokens` is the only field present on both, so
// it is preferred and the top-level names are the fallback. Reading only the
// top-level pair reports zero on gateway A, which is indistinguishable from
// caching being switched off, so a "cache is not working" panic would be
// chasing a reporting bug. `??` rather than `||` on purpose: a present, real 0
// must win over the fallback.
//
// Returns null when the response carries no usage at all, so callers can tell
// "not reported" apart from "reported as zero".
function readUsage(response) {
  const u = response && response.usage;
  if (!u || typeof u !== 'object') return null;
  const det = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object')
    ? u.prompt_tokens_details
    : {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cachedTokens: num(det.cached_tokens ?? u.cache_read_input_tokens),
    cacheWriteTokens: num(
      det.cache_write_tokens ?? det.cache_creation_tokens ?? u.cache_creation_input_tokens,
    ),
    cost: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null,
  };
}

// Assemble OpenAI-style streaming deltas into the buffered response shape.
// Content arrives as string fragments; tool calls arrive as fragments keyed
// by `index` (id and name usually on the first fragment, arguments split
// across many). The result is byte-identical in shape to a non-streaming
// response, so the agent loop consumes either without knowing which ran.
function createDeltaAssembler(onDelta) {
  const acc = { content: '', toolCalls: [], finishReason: null, sawChunk: false, usage: null };
  return {
    take(parsed) {
      // Usage rides a trailing chunk of its own when `stream_options
      // .include_usage` is set, and that chunk carries an EMPTY choices array.
      // Capturing it above the guard below is load-bearing: return on the
      // missing choice first and every token count is silently discarded.
      if (parsed && parsed.usage && typeof parsed.usage === 'object') acc.usage = parsed.usage;
      const choice = parsed?.choices?.[0];
      if (!choice) return;
      acc.sawChunk = true;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        acc.content += delta.content;
        if (onDelta) onDelta({ content: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const frag of delta.tool_calls) {
          const i = Number.isInteger(frag.index) ? frag.index : 0;
          if (!acc.toolCalls[i]) acc.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          const slot = acc.toolCalls[i];
          if (frag.id) slot.id = frag.id;
          if (frag.function?.name) slot.function.name += frag.function.name;
          if (frag.function?.arguments) slot.function.arguments += frag.function.arguments;
        }
      }
      if (choice.finish_reason) acc.finishReason = choice.finish_reason;
    },
    sawChunk() { return acc.sawChunk; },
    result() {
      const message = { role: 'assistant', content: acc.content };
      const calls = acc.toolCalls.filter(Boolean);
      if (calls.length) message.tool_calls = calls;
      const out = { choices: [{ finish_reason: acc.finishReason, message }] };
      if (acc.usage) out.usage = acc.usage;
      return out;
    },
  };
}

// POST one chat-completions payload to the configured gateway and return the
// parsed JSON response. Promise rejects with a typed Error so the caller can
// map to the right HTTP status:
//   'gateway_unavailable: <msg>'  -> 502
//   'gateway_timeout'             -> 504
//   'gateway_budget: <msg>'       -> 429, allowance exhausted (see above)
//   'gateway_http_<code>: <msg>'  -> upstream said no; 5xx/429 are transient
//   'gateway_parse: <msg>'        -> 500
// Preserves the existing transport options (no keep-alive, self-signed TLS
// tolerated, 180s per-hop timeout).
//
// With `stream: true` the request asks the gateway for server-sent events,
// `onDelta({content})` fires per content fragment, and the resolved value is
// the assembled response in the same shape as the buffered mode, so callers
// are agnostic. Node's socket timeout is idle-based, which is the right
// semantic for a stream: a healthy long generation keeps resetting it, a
// stalled one still trips it. Errors keep the exact typed contract above; a
// gateway that ignores `stream: true` and answers plain JSON is tolerated.
//
// A non-2xx response used to be parsed as if it were a normal reply, so the
// status was discarded and an error body with no `choices` surfaced as an empty
// answer. The status is now inspected before parsing (klebb#547).
function callGateway({ messages, tools, timeoutMs, endpointUrl, model, apiKey, stream, onDelta, maxTokens } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = endpointUrl ? parseEndpoint(endpointUrl) : DEFAULT_ENDPOINT;
    if (!endpoint) return reject(new Error('gateway_unavailable: CHAT_ENDPOINT_URL not set'));
    const body = { model: model !== undefined ? model : ENV.CHAT_MODEL, messages };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    // Only when a caller states a ceiling. The chat path deliberately sends
    // none (the gateway's default applies); the vision transcription path
    // needs an explicit one so `finish_reason: "length"` is a signal it can
    // trust rather than whatever the gateway happened to default to.
    if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    if (stream) {
      body.stream = true;
      // A streaming response carries no usage block unless it is asked for, so
      // without this the token and cache counters go missing on the path that
      // serves nearly every chat call. Gateways that do not recognise the field
      // ignore it, so it is safe to send unconditionally.
      body.stream_options = { include_usage: true };
    }
    const payload = JSON.stringify(body);
    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey !== undefined ? apiKey : ENV.CHAT_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
        'Connection': 'close',
      },
      rejectUnauthorized: false,
      agent: false,
    };
    const proxyReq = endpoint.transport.request(options, (proxyRes) => {
      const status = proxyRes.statusCode || 0;
      const isError = status < 200 || status >= 300;
      const assembler = (stream && !isError) ? createDeltaAssembler(onDelta) : null;
      let data = '';
      let sseBuffer = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', (c) => {
        if (!assembler) { data += c; return; }
        sseBuffer += c.replace(/\r\n/g, '\n');
        // SSE frames are blank-line separated; a frame's payload is the
        // concatenation of its `data:` lines. Anything else (comments,
        // event names, unparseable fragments) is skipped: robustness over
        // strictness, the assembler tracks whether anything real arrived.
        let sep;
        while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
          const frame = sseBuffer.slice(0, sep);
          sseBuffer = sseBuffer.slice(sep + 2);
          const payloadLines = frame.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim());
          if (!payloadLines.length) continue;
          const raw = payloadLines.join('\n');
          if (raw === '[DONE]') continue;
          try { assembler.take(JSON.parse(raw)); } catch { /* skip fragment */ }
        }
      });
      proxyRes.on('end', () => {
        if (isError) {
          // Prefer the gateway's own message; it is what carries the budget
          // marker. Truncated because an HTML error page from a misconfigured
          // proxy would otherwise land whole in the journal.
          let detail = '';
          try {
            const parsed = JSON.parse(data);
            detail = parsed?.error?.message || parsed?.message || '';
          } catch { /* not JSON: fall back to the raw body */ }
          if (!detail) detail = String(data || '').slice(0, 300);
          if (looksLikeBudgetExhaustion(status, data)) {
            return reject(new Error('gateway_budget: ' + detail));
          }
          return reject(new Error(`gateway_http_${status}: ` + detail));
        }
        if (assembler) {
          if (assembler.sawChunk()) return resolve(assembler.result());
          // The gateway ignored `stream: true` and answered plain JSON (or
          // sent nothing usable). Fall back to parsing the raw body before
          // declaring it unreadable.
          try { return resolve(JSON.parse(sseBuffer)); }
          catch (e) { return reject(new Error('gateway_parse: ' + e.message)); }
        }
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

// Whether a gateway is configured at all. /api/chat/status reports this, and
// the comprehension pass uses it to skip straight to a raw report instead of
// waiting out a connection to nowhere.
function isConfigured() {
  return !!DEFAULT_ENDPOINT;
}

// Classify a rejected callGateway error into the cause a caller should act on.
// One place to change, so /api/chat and the report comprehension pass cannot
// drift apart on what a 429 means.
//   'budget'    allowance for the period is used up (positive marker seen)
//   'timeout'   per-hop or per-iteration timeout
//   'transient' unreachable, 5xx, bare 429 (plain rate limiting), unknown
//   'parse'     2xx whose body was not JSON
function classifyGatewayError(err) {
  const msg = String((err && err.message) || err || '');
  if (msg.startsWith('gateway_budget')) return 'budget';
  if (msg.startsWith('gateway_timeout') || msg.startsWith('gateway_iter_timeout')) return 'timeout';
  if (msg.startsWith('gateway_unavailable')) return 'transient';
  if (msg.startsWith('gateway_parse')) return 'parse';
  const http = msg.match(/^gateway_http_(\d{3})/);
  // Every upstream refusal is transient from the user's point of view: a 401
  // (bad key) or 400 is a misconfiguration for the operator to fix, and neither
  // is the user's allowance. Never claim budget without the marker.
  if (http) return 'transient';
  return 'transient';
}

module.exports = {
  callGateway, isConfigured, parseEndpoint, GATEWAY_HARD_TIMEOUT_MS,
  classifyGatewayError, looksLikeBudgetExhaustion, BUDGET_MARKERS,
  readUsage, createDeltaAssembler,
};
