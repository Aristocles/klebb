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
// A non-2xx response used to be parsed as if it were a normal reply, so the
// status was discarded and an error body with no `choices` surfaced as an empty
// answer. The status is now inspected before parsing (klebb#547).
function callGateway({ messages, tools, timeoutMs, endpointUrl, model, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = endpointUrl ? parseEndpoint(endpointUrl) : DEFAULT_ENDPOINT;
    if (!endpoint) return reject(new Error('gateway_unavailable: CHAT_ENDPOINT_URL not set'));
    const body = { model: model !== undefined ? model : ENV.CHAT_MODEL, messages };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
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
      let data = '';
      proxyRes.on('data', c => data += c);
      proxyRes.on('end', () => {
        const status = proxyRes.statusCode || 0;
        if (status < 200 || status >= 300) {
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
};
