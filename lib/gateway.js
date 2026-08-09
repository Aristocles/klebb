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

// POST one chat-completions payload to the configured gateway and return the
// parsed JSON response. Promise rejects with a typed Error so the caller can
// map to the right HTTP status:
//   'gateway_unavailable: <msg>'  -> 502
//   'gateway_timeout'             -> 504
//   'gateway_parse: <msg>'        -> 500
// Preserves the existing transport options (no keep-alive, self-signed TLS
// tolerated, 180s per-hop timeout).
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

module.exports = { callGateway, isConfigured, parseEndpoint, GATEWAY_HARD_TIMEOUT_MS };
