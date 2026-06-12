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
  {
    type: 'function',
    function: {
      name: 'read_manifest_meta',
      description:
        "Return ONLY a card's meta + description + schema, NOT its data block. Cheap (~2 kB) even for cards with thousands of rows. Call this before any write to confirm the card's writeable rules and shape; it has the same role read_manifest used to play, minus the row-bulk that bloats your context. If you actually need to inspect rows, follow up with read_manifest_rows.",
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
      name: 'read_manifest_rows',
      description:
        "Return a slice of a card's data block, addressed by a tiny path language. Use INSTEAD of read_manifest when a card has lots of rows (peptides, mood logs, anything that grew over time). Path grammar (equality-only): `seg.seg[k=v]`, where `seg` is a property name (letters, digits, _, -) and `[k=v]` filters an array element by exact equality. Numeric literals are bare (1, 1.5, -3); strings are quoted (\"BPC-157\" or 'BPC-157'); true/false bare. Special filter `[index=N]` picks the Nth element of an array. A leading `[k=v]` (no property) filters an array-typed root. Empty path returns the whole data block. Examples: `items` (top-level array), `items[name=\"BPC-157\"]` (one item), `items[name=\"BPC-157\"].doses` (its doses), `[date=\"2026-05-04\"]` (one row of an array-rooted card), `[index=2].notes` (notes prop of the 3rd row). IMPORTANT auto-truncation: if the resolved value is an array longer than 10, only the first 10 rows are returned with {truncated:true, total:N}; if it's an object whose properties contain arrays longer than 10, those arrays are replaced with {omittedArray:true, count:N}. The response payload is therefore NOT the full data; re-fetch by a deeper path if you need the omitted rows. Pass {order:'desc'} to flip the truncation window to the LAST 10 rows (use this for `last dose` / `latest entry` questions). Errors return {error, code} with code in {BAD_PATH, NO_MATCH, AMBIGUOUS, WRONG_TYPE} so you can self-correct: BAD_PATH = grammar error, NO_MATCH = path resolves to nothing, AMBIGUOUS = filter matches >1 row (narrow the filter), WRONG_TYPE = wrong shape at the resolved spot.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
          path: {
            type: 'string',
            description: "Path expression in the grammar above. Empty string returns the whole data block (use sparingly; prefer a more targeted path).",
          },
          order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: "When the resolved value is an array longer than 10, controls which window is returned. 'asc' (default) returns the first 10 in their on-disk order; 'desc' returns the last 10 (i.e. the most recent rows for an append-only log). Has no effect when the array is <=10 rows.",
          },
        },
        required: ['id', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_row',
      description:
        "Append one row to the array at `path` inside a card's data block. Path resolves the SAME way read_manifest_rows resolves; see that tool's description for the full grammar. The target must be an array; appending a peptide goes to `items`, appending a dose goes to `items[name=\"BPC-157\"].doses`, appending to an array-rooted card uses `''` (empty path). Rejected if meta.writeable.fromWebapp is not true. Errors return {error, code} with the same codes as read_manifest_rows. ALWAYS call read_manifest_meta or read_manifest_rows first to confirm the card's existing shape and writeable rules; appending into a path that doesn't exist returns NO_MATCH (no auto-create; create the parent row first if needed).",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
          path: { type: 'string', description: 'Path to the array to append to. May be empty for an array-rooted card.' },
          value: { description: 'The row to append. Shape matches the existing rows in that array.' },
        },
        required: ['id', 'path', 'value'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_row',
      description:
        "Apply RFC 7396 JSON Merge Patch to ONE row identified by `path`. Nested objects deep-merge; arrays in `changes` replace wholesale; null removes a key. Path resolves the SAME way read_manifest_rows resolves. The target must be a plain object. The path MUST resolve unambiguously: if the filter matches more than one row, you get AMBIGUOUS; narrow the filter (add a second key, use [index=N], etc.). Rejected if meta.writeable.fromWebapp is not true. Errors return {error, code}. Confirm with the user EXACTLY ONCE before any update that removes data (passing `null` for an existing key, or replacing an array with a shorter one).",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
          path: { type: 'string', description: 'Path to a single row (must resolve to one plain object, not the root).' },
          changes: {
            type: 'object',
            description: 'RFC 7396 patch. Only the keys you want to change. null removes a key.',
            additionalProperties: true,
          },
        },
        required: ['id', 'path', 'changes'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_row',
      description:
        "Remove ONE row from its parent array, identified by `path`. Path resolves the SAME way read_manifest_rows resolves. The path's leaf must be an array element (a filtered segment, e.g. `items[name=\"X\"]` or `items[name=\"X\"].doses[scheduledDate=\"YYYY-MM-DD\"]`); you cannot remove a property of an object with this tool, and you cannot remove the root data value (use write_manifest_data for those). The path MUST resolve unambiguously. Rejected if meta.writeable.fromWebapp is not true. Errors return {error, code}. Confirm with the user EXACTLY ONCE before calling: removal is destructive and not undoable.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Manifest id.' },
          path: { type: 'string', description: "Path to a single row (leaf must be a filtered array element, e.g. items[name=\"X\"])." },
        },
        required: ['id', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_notification',
      description:
        "Add or update a notification on a card. Idempotent: if a notification with notification_id already exists on this card, update it; otherwise append a new one (auto-generating a snake-case id from `label` when notification_id is omitted). Use this when the user says things like 'remind me to log X every day at Y' or 'change the morning mood reminder to 9am'. Before calling, you SHOULD have read the card's existing meta.notifications.items[] (via read_manifest_meta) so you don't duplicate a similar reminder; if a similar item exists but is currently disabled, prefer offering the user a re-enable instead. Notification copy rules: title <=30 chars, body <=80 chars, second person ('How are you feeling?'), no emoji unless the card has meta.emoji set, NEVER include numerical values or content of past entries (notifications are reminders to act, not summaries). v1 trigger types are 'daily' (time:HH:MM) and 'weekly' (time:HH:MM, days:[mon|tue|wed|thu|fri|sat|sun]).",
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'string', description: 'Existing card id.' },
          notification_id: {
            type: 'string',
            description: "Item id within meta.notifications.items[]. Omit for an auto-generated slug from `label`. Must match /^[a-z0-9][a-z0-9._-]{0,63}$/.",
          },
          label: { type: 'string', description: 'Human label shown in Settings. e.g. "Evening mood log".' },
          title: { type: 'string', description: 'Notification title (<=30 chars).' },
          body: { type: 'string', description: 'Notification body (<=80 chars, second person).' },
          trigger: {
            type: 'object',
            description: 'Daily: { type:"daily", time:"HH:MM" }. Weekly: { type:"weekly", time:"HH:MM", days:[...] }.',
          },
          privacy: {
            type: 'string',
            enum: ['private', 'public'],
            description: "Default 'private'. When 'private', the wire payload says generic 'Klebb / You have a reminder.' on the lock screen and the real text appears only after the user opens Klebb.",
          },
        },
        required: ['card_id', 'label', 'title', 'body', 'trigger'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_notification',
      description:
        'Remove a notification from a card. Confirm with the user EXACTLY ONCE before calling: removal is destructive (the notification is gone, not just disabled). If the user is unsure, suggest toggling enabled:false in Settings instead.',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'string' },
          notification_id: { type: 'string' },
        },
        required: ['card_id', 'notification_id'],
        additionalProperties: false,
      },
    },
  },
];

// Auto-generate a notification id from a human label when the agent
// didn't supply one. Lowercase, ascii-only, drop anything that isn't
// matching the id regex.
function _slugifyNotificationId(label) {
  const slug = String(label || 'reminder')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'reminder';
}

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
      case 'read_manifest_meta': {
        const entry = registry.get(args.id);
        if (!entry) {
          return JSON.stringify({ error: `unknown manifest: ${args.id}` });
        }
        return JSON.stringify({
          meta: entry.meta,
          description: entry.description || null,
          schema: entry.schema || null,
        });
      }
      case 'read_manifest_rows': {
        try {
          const r = registry.readRows(args.id, args.path || '');
          const order = args.order === 'desc' ? 'desc' : 'asc';
          return JSON.stringify(_summariseReadResult(r.value, order));
        } catch (e) {
          return _toolErrorPayload(e, args);
        }
      }
      case 'append_row': {
        const gateErr = _writeableGate(args.id);
        if (gateErr) return gateErr;
        try {
          const out = registry.appendRow(args.id, args.path || '', args.value);
          recordTouch(ctx, { id: args.id, flow: 'edit' });
          return JSON.stringify({ ok: true, id: args.id, ...out });
        } catch (e) {
          return _toolErrorPayload(e, args);
        }
      }
      case 'update_row': {
        const gateErr = _writeableGate(args.id);
        if (gateErr) return gateErr;
        try {
          const out = registry.updateRow(args.id, args.path || '', args.changes);
          recordTouch(ctx, { id: args.id, flow: 'edit' });
          return JSON.stringify({ ok: true, id: args.id, after: out.after });
        } catch (e) {
          return _toolErrorPayload(e, args);
        }
      }
      case 'remove_row': {
        const gateErr = _writeableGate(args.id);
        if (gateErr) return gateErr;
        try {
          const out = registry.removeRow(args.id, args.path || '');
          recordTouch(ctx, { id: args.id, flow: 'edit' });
          return JSON.stringify({ ok: true, id: args.id, removed: out.removed, totalAfter: out.totalAfter });
        } catch (e) {
          return _toolErrorPayload(e, args);
        }
      }
      case 'read_doc': {
        return JSON.stringify(readDoc(args.path));
      }
      case 'read_report': {
        return JSON.stringify(readReport(args.name));
      }
      case 'set_notification': {
        const entry = registry.get(args.card_id);
        if (!entry) return JSON.stringify({ error: `unknown card: ${args.card_id}` });
        const existingItems = (entry.meta && entry.meta.notifications && Array.isArray(entry.meta.notifications.items))
          ? entry.meta.notifications.items
          : [];
        const itemId = args.notification_id || _slugifyNotificationId(args.label);
        const newItem = {
          id: itemId,
          label: args.label,
          title: args.title,
          body: args.body,
          trigger: args.trigger,
        };
        if (args.privacy) newItem.privacy = args.privacy;
        const idx = existingItems.findIndex(i => i.id === itemId);
        const nextItems = [...existingItems];
        if (idx >= 0) nextItems[idx] = { ...existingItems[idx], ...newItem };
        else nextItems.push(newItem);
        try {
          registry.patchManifest(args.card_id, {
            meta: { notifications: { enabled: true, items: nextItems } },
          });
          recordTouch(ctx, { id: args.card_id, flow: 'edit' });
          return JSON.stringify({
            ok: true,
            card_id: args.card_id,
            notification_id: itemId,
            created: idx < 0,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message || 'set_notification failed' });
        }
      }
      case 'remove_notification': {
        const entry = registry.get(args.card_id);
        if (!entry) return JSON.stringify({ error: `unknown card: ${args.card_id}` });
        const existingItems = (entry.meta && entry.meta.notifications && Array.isArray(entry.meta.notifications.items))
          ? entry.meta.notifications.items
          : [];
        const idx = existingItems.findIndex(i => i.id === args.notification_id);
        if (idx < 0) return JSON.stringify({ error: `unknown notification: ${args.notification_id}` });
        const nextItems = existingItems.filter(i => i.id !== args.notification_id);
        try {
          registry.patchManifest(args.card_id, {
            meta: { notifications: { enabled: entry.meta.notifications.enabled !== false, items: nextItems } },
          });
          recordTouch(ctx, { id: args.card_id, flow: 'edit' });
          return JSON.stringify({
            ok: true,
            card_id: args.card_id,
            notification_id: args.notification_id,
            remaining: nextItems.length,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message || 'remove_notification failed' });
        }
      }
      default:
        return JSON.stringify({ error: 'unknown tool: ' + name });
    }
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
}

const SUMMARY_LIMIT = 10;

// Shape the read_manifest_rows return so the model never receives an
// unbounded array. Two passes:
//   - if value is an array longer than SUMMARY_LIMIT, slice to a window
//     (head for 'asc', tail for 'desc') and emit {rows, total, truncated, window}.
//   - if value is a plain object, walk one level into its props; any
//     array property longer than SUMMARY_LIMIT collapses to
//     {omittedArray:true, count:N}. Shorter arrays and non-array props
//     are returned as-is.
//   - primitives and short arrays return as-is.
function _summariseReadResult(value, order) {
  if (Array.isArray(value)) {
    if (value.length <= SUMMARY_LIMIT) {
      return { rows: value, total: value.length, truncated: false };
    }
    const rows = order === 'desc'
      ? value.slice(-SUMMARY_LIMIT)
      : value.slice(0, SUMMARY_LIMIT);
    return { rows, total: value.length, truncated: true, window: order };
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v) && v.length > SUMMARY_LIMIT) {
        out[k] = { omittedArray: true, count: v.length };
      } else {
        out[k] = v;
      }
    }
    return { row: out };
  }
  return { value };
}

function _writeableGate(id) {
  const entry = registry.get(id);
  if (!entry) {
    return JSON.stringify({ error: `unknown manifest: ${id}` });
  }
  const w = entry.meta?.writeable;
  if (!w || !w.fromWebapp) {
    return JSON.stringify({
      error: `${id} is not writeable from the webapp (meta.writeable.fromWebapp is not true). Use patch_manifest to flip the flag first if the user wants to make it writeable.`,
    });
  }
  return null;
}

function _toolErrorPayload(e, args) {
  const payload = { error: e.message || String(e) };
  if (e && typeof e.code === 'string') payload.code = e.code;
  if (args && typeof args.path === 'string') payload.path = args.path;
  if (args && typeof args.id === 'string') payload.id = args.id;
  return JSON.stringify(payload);
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
