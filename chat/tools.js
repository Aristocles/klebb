// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/tools.js
// OpenAI-compatible tool schemas + dispatch for the Klebbius agent loop.
// Tools call into the manifest registry directly — no HTTP hop back to
// /api/manifests. Registry writes are sync atomic tmp+rename so this is
// safe to do inline inside a chat request.

const registry = require('../manifests/registry');

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'create_manifest',
      description:
        "Create a new card on the user's dashboard. Pass a full klebb.datafile.v1 manifest object. Returns {ok, id, source} on success; validation errors come back as {error} — read the message and retry with a fixed manifest (e.g. pick a different id on 'duplicate id', sanitise bad chars on 'invalid id').",
      parameters: {
        type: 'object',
        properties: {
          manifest: {
            type: 'object',
            description:
              'Full klebb.datafile.v1 manifest. Must include $schema, meta.id (matching /^[a-z0-9][a-z0-9._-]*$/), and meta.label. See the system prompt for the full field reference.',
            additionalProperties: true,
          },
        },
        required: ['manifest'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_manifest',
      description:
        'Delete a card and its manifest file. Only call after confirming intent with the user — data goes with the file. Prefer suggesting meta.enabled:false (hide without losing data) if the user is unsure.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id, e.g. "blood-pressure".' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_manifests',
      description:
        "Return a compact list of all cards currently on the user's dashboard. Useful to re-check state mid-conversation (e.g. after you just created a card, or before proposing an id to check it's not taken).",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

// Execute a single tool_call from an assistant response. Always returns a
// string (stringified JSON) — both success and failure paths. The string
// becomes the `content` of the matching {role:"tool"} message on the next
// gateway request.
function dispatchToolCall(tc) {
  const name = tc.function?.name;
  let args = {};
  try {
    args = JSON.parse(tc.function?.arguments || '{}');
  } catch (e) {
    return JSON.stringify({ error: 'invalid JSON in tool arguments: ' + e.message });
  }
  try {
    switch (name) {
      case 'create_manifest': {
        const result = registry.createManifest(args.manifest);
        return JSON.stringify({ ok: true, ...result });
      }
      case 'delete_manifest': {
        const result = registry.deleteManifest(args.id);
        return JSON.stringify({ ok: true, ...result });
      }
      case 'list_manifests': {
        const rows = registry.list().map(c => ({
          id: c.id,
          label: c.meta?.label || c.id,
          description: (c.description || '').split('\n')[0].slice(0, 200),
          enabled: c.meta?.enabled !== false,
        }));
        return JSON.stringify({ cards: rows });
      }
      default:
        return JSON.stringify({ error: 'unknown tool: ' + name });
    }
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
}

module.exports = { TOOL_DEFS, dispatchToolCall };
