// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/tools.js
// OpenAI-compatible tool schemas + dispatch for the Klebbius agent loop.
// Tools call into the manifest registry directly — no HTTP hop back to
// /api/manifests. Registry writes are sync atomic tmp+rename so this is
// safe to do inline inside a chat request.

const registry = require('../manifests/registry');
const { readDoc } = require('./docs');
const { readReport } = require('./reports');

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'create_manifest',
      description:
        "Create a new card on the user's dashboard. Pass a full klebb.datafile.v1 manifest object. Returns {ok, id, source} on success; validation errors come back as {error} — read the message and retry with a fixed manifest (e.g. pick a different id on 'duplicate id', sanitise bad chars on 'invalid id'). IMPORTANT: per-renderer data shape matters: e.g. schedule-card items live in data.items[], NOT meta.schedule. Do NOT set optional embellishments (meta.prompt, meta.calendar, meta.trends, meta.reports, meta.view.display.thresholds) unless the user explicitly asked for them; the webapp offers the user follow-up chips after a successful create so they can opt in. Use today's absolute date (provided in the system prompt) for any date field; never guess the year from training data.",
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
      name: 'hide_card',
      description:
        "Hide a card from every view (Today, Trends, Calendar, Reports) by setting meta.enabled:false. The card's manifest file and data are preserved — use this instead of delete_manifest when the user wants to stop seeing a card but might want it back. The card stays visible in Settings so the user can re-enable it.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_card',
      description:
        "Unhide a previously-hidden card by setting meta.enabled:true. Reverses hide_card. No-op if the card is already enabled.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
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
  {
    type: 'function',
    function: {
      name: 'read_manifest',
      description:
        "Return the full content of a single card: meta, description, schema, and the data block. Use this before any write (write_manifest_data or patch_manifest) so you can see what you're about to change and preserve everything you don't want to touch. Also the right tool for answering 'what did I log for X', 'what's my threshold', etc.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_manifest_data',
      description:
        "Replace a card's entire data block. This is a full rewrite, not a row-level patch — to add/edit/delete a row, first call read_manifest to get the current data, mutate the array (or object) in memory, then pass the whole new value here. Rejected if meta.writeable.fromWebapp is false (ingest-only cards). Destructive-feeling writes (removing rows) must be confirmed with the user exactly once before calling this.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
          data: {
            description:
              "The full new data value. Shape matches what read_manifest returned: usually an array of rows like [{date, ...}], but some cards use {items:[...]}, {markdown:'...'}, etc. Pass whatever shape the card uses.",
          },
        },
        required: ['id', 'data'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description:
        "Fetch the full text of one of Klebb's shipped documentation files (README, MANIFEST-SCHEMA, docs/*, etc.). The system prompt lists every available path under '## Available docs' with a one-line summary; pass one of those paths verbatim. Use this when the user asks about schema fields, renderer contracts, deploy steps, or any other topic where the docs are authoritative — you'll get the same version the running app shipped with, so you won't be misled by training-data drift or by what's on main. Unknown or non-allowlisted paths return {error}; do not retry with traversal sequences or absolute paths.",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "Repo-relative POSIX path of the doc to read, exactly as it appears in the system prompt's catalogue (e.g. 'MANIFEST-SCHEMA.md' or 'docs/CARDS.md').",
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_report',
      description:
        "Fetch the full text of one of the user's ingested reports. The system prompt lists every report under '## Available reports' with its name, source format, and ingestion date; pass one of those names verbatim (no .md extension, no slashes). Reports are raw text extracted from PDFs, scans, notes, or audio the user has dropped into their inbox: blood panels, scan reports, voice memos, and similar. Use this when the user asks 'what does my latest blood panel show', 'summarise the MRI report', or any other question where the answer is in one of those files. Returns {name, path, content, ingestedAt, sourceFormat, truncated}; unknown or invalid names return {error}.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              "Report name as listed in the system prompt's catalogue, without the .md extension (e.g. '2026-05-22-bloods-april-fast').",
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_manifest',
      description:
        "Edit a card's meta or description in place without touching its data. Uses RFC 7396 JSON Merge Patch: nested objects deep-merge, arrays replace wholesale, null removes a key. Use this for any meta-only change — thresholds, labels, emoji maps, input types, writeable flags. The data block is preserved byte-for-byte. You CANNOT change $schema or meta.id via this tool; for those, delete_manifest + create_manifest is the path (and data will be lost). ALWAYS call read_manifest first so you're patching over the real current meta. Destructive-feeling patches (removing inputs from a writeable card, flipping writeable.fromWebapp from true to false on a card that has data) must be confirmed with the user exactly once before calling this.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
          patch: {
            type: 'object',
            description:
              "Partial manifest. Only meta and description are patchable. Example: {meta: {writeable: {inputs: [{key:'mood', type:'emoji-picker', emojis:['😩','😴','😐','🙂','😄'], emitIndex:true, required:true, autoSubmit:false}, ...]}}} — note that meta.writeable.inputs is an ARRAY, so the WHOLE array replaces. You have to include every input you want to keep.",
            additionalProperties: true,
          },
        },
        required: ['id', 'patch'],
        additionalProperties: false,
      },
    },
  },
];

// Execute a single tool_call from an assistant response. Always returns a
// string (stringified JSON) — both success and failure paths. The string
// becomes the `content` of the matching {role:"tool"} message on the next
// gateway request.
//
// Optional `ctx` collects side-effects the caller can inspect after the
// loop resolves. Today that's `ctx.touches`: an ordered list of successful
// create / patch / write_data calls, used to drive the post-turn
// embellishment chips. Kept as a plain array (last entry is the newest).
function dispatchToolCall(tc, ctx) {
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
        recordTouch(ctx, { id: result.id, flow: 'create' });
        return JSON.stringify({ ok: true, ...result });
      }
      case 'delete_manifest': {
        const result = registry.deleteManifest(args.id);
        return JSON.stringify({ ok: true, ...result });
      }
      case 'hide_card': {
        registry.setMasterEnabled(args.id, false);
        return JSON.stringify({ ok: true, id: args.id, enabled: false });
      }
      case 'show_card': {
        registry.setMasterEnabled(args.id, true);
        return JSON.stringify({ ok: true, id: args.id, enabled: true });
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
      case 'read_manifest': {
        const entry = registry.get(args.id);
        if (!entry) {
          return JSON.stringify({ error: `unknown manifest: ${args.id}` });
        }
        return JSON.stringify({
          meta: entry.meta,
          description: entry.description || null,
          schema: entry.schema || null,
          data: entry.data,
        });
      }
      case 'write_manifest_data': {
        const entry = registry.get(args.id);
        if (!entry) {
          return JSON.stringify({ error: `unknown manifest: ${args.id}` });
        }
        const w = entry.meta?.writeable;
        if (!w || !w.fromWebapp) {
          return JSON.stringify({ error: `${args.id} is not writeable from the webapp (meta.writeable.fromWebapp is not true). Use patch_manifest to flip the flag first if the user wants to make it writeable.` });
        }
        registry.writeData(args.id, args.data);
        recordTouch(ctx, { id: args.id, flow: 'edit' });
        return JSON.stringify({ ok: true, id: args.id });
      }
      case 'patch_manifest': {
        const result = registry.patchManifest(args.id, args.patch);
        recordTouch(ctx, { id: args.id, flow: 'edit' });
        return JSON.stringify({ ok: true, ...result });
      }
      case 'read_doc': {
        return JSON.stringify(readDoc(args.path));
      }
      case 'read_report': {
        return JSON.stringify(readReport(args.name));
      }
      default:
        return JSON.stringify({ error: 'unknown tool: ' + name });
    }
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
}

// Record a manifest-touch for post-turn consumers. If the same id is
// touched twice in one turn (e.g. create then patch), keep the original
// flow — a create-then-patch is still fundamentally a create and the
// chips that come back should read as such.
function recordTouch(ctx, touch) {
  if (!ctx || !Array.isArray(ctx.touches)) return;
  const existing = ctx.touches.find(t => t.id === touch.id);
  if (existing) return;
  ctx.touches.push(touch);
}

module.exports = { TOOL_DEFS, dispatchToolCall };
