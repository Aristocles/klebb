# Chat agent integration

Klebb ships with a chat widget that can write to cards and answer
questions about your data. The widget is **agent-agnostic**: it talks to an
an OpenAI-compatible chat-completions endpoint, which can be backed by whatever model
you configure.

This doc covers:
1. How the chat widget is configured
2. How server-to-server writes from an external agent work
3. What's NOT included (and what you'd need to build)

---

## 1. Chat widget — OpenAI-compatible endpoint

The in-page chat widget (`health-chat.js`) posts user messages to
whatever endpoint you configure and renders the response. Klebb speaks
the OpenAI chat-completions shape, so any endpoint that accepts that
shape works: a self-hosted gateway (LiteLLM, or similar), a cloud
provider's OpenAI-compat endpoint (your provider, Groq, Together,
DeepInfra), a local runtime (Ollama, vLLM, llama.cpp), or OpenAI /
OpenRouter directly.

Configure via environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `CHAT_ENDPOINT_URL` | — | Full URL of the chat-completions endpoint, e.g. `https://api.openai.com/v1/chat/completions` |
| `CHAT_API_KEY` | — | Bearer token sent as `Authorization: Bearer <key>` |
| `CHAT_MODEL` | — | Model name the endpoint expects (e.g. `gpt-4o-mini`, `llama3.1`, whatever your provider returns from its models list) |
| `HEALTH_SYSTEM_PROMPT` | built-in | System prompt sent with each turn |
| `CHAT_AGENT_NAME` | `Chat` | Display name shown in the chat UI |
| `CHAT_AGENT_EMOJI` | `💬` | Emoji/char shown as the agent avatar |

The URL scheme (`http://` vs `https://`) picks the transport. Host, port,
and path all come from the URL, so the endpoint doesn't have to live at
`/v1/chat/completions` — point at whatever path your provider uses.

If `CHAT_ENDPOINT_URL` is unset, the chat widget is disabled and
`POST /api/chat` returns `503`.

### Tools the agent can call

The server passes a small set of tools to the chat-completions
endpoint on every turn. If your model supports tool-use, the loop in
`chat/tools.js` dispatches each call inline; if your model doesn't,
the tools are simply unused.

| Tool | Purpose |
|------|---------|
| `create_manifest` / `delete_manifest` / `patch_manifest` | Author and edit cards |
| `read_manifest` / `list_manifests` / `write_manifest_data` | Inspect and update card data |
| `read_manifest_meta` / `read_manifest_rows` / `append_row` / `update_row` / `remove_row` / `reorder_rows` | Targeted reads + row-level mutations |
| `hide_card` / `show_card` | Master enable/disable |
| `set_notification` / `remove_notification` | Add, update, or remove a Web Push reminder on a card. `set_notification` is idempotent by `(card_id, notification_id)`; `remove_notification` requires one-shot user confirmation. v1 trigger types: `daily` and `weekly`. The validator enforces title <= 30, body <= 80, label <= 80, items[] <= 10 per card; the system prompt forbids including numerical values or past-entry content in the body (notifications are reminders to act, not summaries). |
| `read_doc` | Fetch any allowlisted in-repo doc (README, MANIFEST-SCHEMA, this file, etc.) |
| `read_report` | Fetch any ingested report from `$HEALTH_HOME/reports/`. The agent gets the catalogue automatically in its system prompt; see [`REPORTS.md`](REPORTS.md) for how reports get there. |
| `get_recent_activity` | One-pass recency summary of every card (`rowCount`, `lastEntryDate`, `ageDays`, `lastNDelta`). The agent calls it before answering "how's my tracking" questions and before authoring a card (to match sibling conventions). |
| `hygiene_scan` | On-demand dashboard health check: stale / oversized / orphaned-input findings. Report-only; never mutates. `stale` is opt-in per card: only cards declaring `meta.cadence.expectDays` are ever reported, so a card with no declared cadence being quiet is not a finding. |
| `validate_manifest` | Dry-run a candidate manifest (no write). Returns `{ok}` or `{ok:false, errors:[{path,message}]}`. The system prompt directs the agent to call it before every create/patch. |
| `note_feature_request` | Logs an anonymised unmet-capability intent to `data/_meta/feedback.jsonl` when a request is genuinely unsupported (paraphrased intent only, no user data). |

### Refusal when no tool fits

The system prompt explicitly tells the model to refuse fast when the
user's request can't be carried out by any of the available tools in a
single generation. This is the answer to "the model tried to fudge a
reorder through `write_manifest_data`, the gateway timed out at 180s,
the user saw three minutes of dead air".

The standard refusal copy is one or two short sentences:

> I can't do that in one step right now: \<one-line reason\>. \<Optional:
> name the closest workaround the user CAN do, or what tool would be needed.\>

Examples:

- "I can't reorder rows in one step right now: there's no reorder
  primitive, and the only tool that could do it would have to rewrite
  the whole data block (which times out on cards this size). You can
  re-order this card by editing the manifest file directly for now."
- "I can't merge two cards in one call: there's no cross-card
  transaction tool. I can copy rows from one to the other if you read
  them out yourself first."

Any future tool addition should keep the refusal pattern and tighten
it: when a new primitive lands (e.g. `reorder_rows`), the refusal text
for that intent stops applying and the agent should reach for the new
tool instead.

### Turn budgets: iterations, per-step time, total time

The agent loop has three budgets, all env-tunable:

- **`CHAT_MAX_TURNS`** (default `12`): gateway round-trips per turn. One
  round-trip may batch several tool calls, but the prompt's own
  validate-before-create / read-before-append workflow means multi-card
  requests legitimately need many round-trips. When the cap is hit the
  reply keeps any progress text the model produced, appends how to
  resume ("keep going" works because the client resends the transcript),
  and carries `capped: true` for the client.
- **`CHAT_ITER_TIMEOUT_MS`** (default `60000`, `0` disables): soft
  per-iteration budget under the transport's hard 180s per-hop ceiling.
  A single step running past it aborts the in-flight gateway call and
  answers with timeout copy (HTTP 200), emitting
  `[chat:<id>] iter=N gw=<ms>ms iter_timeout` in debug logs.
- **`CHAT_TURN_DEADLINE_MS`** (default `240000`, `0` disables): total
  wall clock for the whole turn. Without it, a raised iteration cap
  could stack per-step timeouts into a multi-minute silent spinner. The
  loop stops starting new round-trips past the deadline (shrinking the
  last step's budget to what remains) and answers with the same capped
  reply, never a 5xx.

### Streaming (`stream: true`)

`POST /api/chat` with `stream: true` in the body switches the response
to server-sent events, so the client can show live progress instead of
a spinner for the whole agent loop. The request is otherwise identical;
error statuses that fire before the stream opens (400, 503) stay plain
JSON, so clients should check the response `Content-Type`.

Events, in order of appearance:

| Event | Data | Meaning |
|-------|------|---------|
| `status` | `{phase:'thinking'}` | a gateway round-trip started |
| `status` | `{phase:'tool', tool, id?}` | a tool call is executing (`id` = manifest id when known) |
| `token` | `{text}` | a fragment of the assistant's text, in order |
| `reset` | `{}` | drop text streamed so far: it preceded tool calls and was not the answer |
| `reply` | same object the buffered mode returns (`reply`, `speak?`, `followup?`, `capped?`) | the final payload |
| `error` | `{error, status}` | the classified failure copy plus the status the buffered mode would have sent |
| `done` | `{}` | terminator; always the last event |

Voice-mode turns (`voiceMode: true`) emit no `token` events: the model's
raw output is a JSON speak/display envelope nobody should watch being
typed. Status events still flow, and the `reply` event carries the same
`{reply, speak}` shape as the buffered path.

The gateway leg streams too (`stream: true` on the upstream call), and
the per-step timeout becomes an idle timeout there: a healthy long
generation keeps resetting it, a stalled one still trips it. A gateway
that ignores `stream: true` and answers buffered JSON is tolerated.

Comment heartbeats (`: ping`) are sent every 15s, and the response sets
`X-Accel-Buffering: no` so an nginx in front does not buffer the
stream. A client that disconnects mid-turn only mutes the events: the
loop runs to completion, matching the buffered path's semantics.

### Conversations (`conversationId`)

`/api/conversations` stores named transcripts in the per-instance
database (list by recency / create / fetch / rename / replace messages /
delete; hard caps of 100 conversations and 200 messages each). When
`POST /api/chat` carries a `conversationId`, the server owns the
transcript:

- The request's `messages` are just the new turn. They are persisted
  before the loop runs, so a failed turn still shows the user's message
  when the conversation is reopened.
- The loop is fed a window over the stored transcript: the newest
  messages that fit a ~24k-character budget (the newest always goes
  through). Per-turn gateway cost stops growing with conversation
  length; the model re-reads older state through its tools when it
  needs it.
- The shaped reply is appended after the turn, whether or not the
  client is still connected. Voice replies persist `hasVoice`; capped
  replies persist `capped`, so a reloaded client can re-offer play and
  keep-going.
- An untitled conversation gets a short model-generated title from an
  async side-call after the exchange completes (2-6 words, quotes
  stripped, 60-char cap). It never blocks or fails the turn; an
  unnamed conversation just stays unnamed until a later turn retries.
  The call rides the same gateway and counts against the normal chat
  allowance.

Without a `conversationId` the endpoint behaves exactly as before
(client-supplied transcript, nothing persisted server-side). The legacy
`/api/chat/history` endpoints remain until the client cutover.

### Detached turns and reattach (`/api/chat/turn/:conversationId`)

A conversation turn is a server-side job that survives its client: iOS
suspends a backgrounded tab and aborts its fetches, and without this an
in-flight turn's reply had nowhere to go. Mechanics:

- One turn at a time per conversation. A concurrent `POST /api/chat`
  for the same conversation answers **409** before its message is
  persisted, so a retry after the running turn cannot double up the
  transcript.
- Every event of a conversation turn is buffered with an id (streamed
  and buffered requests alike) and fanned out to any number of attached
  event streams.
- `GET /api/chat/turn/:conversationId` reattaches: buffered events
  replay from `Last-Event-ID` (or `?after=N`), then the stream stays
  live until `done`. **204** means there is nothing to attach to: read
  the conversation, where any completed reply is already persisted.
- Completed turns linger for 30s so a client that missed `done` can
  still replay; after that the conversation is the durable copy. A
  replay that lost its head to the per-turn event cap (5000) starts
  with a `reset`.

The intended client loop: on `visibilitychange` back to visible, hit
the reattach endpoint; on 204, refresh the conversation.

`DELETE /api/chat/turn/:conversationId` stops the running turn: the
loop halts at its next checkpoint (between round-trips or tool calls),
the user's message stays, no reply is persisted, the streamed response
ends with a `stopped` event (buffered callers get `{stopped: true}`),
and the one-turn lock releases. 404 when nothing is running.

The shipped widget uses all of this: turns are streamed conversation
requests (the send button becomes a stop button mid-turn), a legacy
`chat/history.json` transcript is folded into a conversation the first
time the new client loads, and the legacy endpoints remain only for
that import path.

### Legacy env vars

Older deploys used `CHAT_GATEWAY_HOST` + `CHAT_GATEWAY_PORT` +
`CHAT_GATEWAY_TLS` + `CHAT_GATEWAY_TOKEN` + `CHAT_GATEWAY_MODEL`. These
still work; they're composed into the canonical `CHAT_ENDPOINT_URL`
internally. New installs should use the canonical names directly.

### What the widget does NOT do

- It does not run tools directly. If your endpoint supports tool-use
  and you want the chat to use tools, that's the endpoint's
  responsibility.
- It does not embed model credentials beyond `CHAT_API_KEY`. One bearer
  token per Klebb instance.

---

## 2. Server-to-server writes (AGENT_API_TOKEN)

When an external agent (chat agent integration, cron job, mobile shortcut, etc.)
needs to write to a card without going through the chat widget, it
authenticates with a bearer token instead of a WebAuthn session cookie.

**Enable it:** set `AGENT_API_TOKEN` in the environment. Any request with
`Authorization: Bearer <token>` is treated as an authenticated agent.

**Endpoints available to agents:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/manifests` | List all cards |
| `POST` | `/api/manifests` | Create a new card from a full manifest body |
| `GET` | `/api/manifests/:id` | Fetch full manifest |
| `GET` | `/api/manifests/:id/data` | Fetch just the data block |
| `POST` | `/api/manifests/:id/data` | Replace the data block |
| `DELETE` | `/api/manifests/:id` | Remove the card and its file |
| `POST` | `/api/manifests/reorder` | Reassign `meta.order` across cards |
| `GET` | `/api/views/:view` | List cards for a view |
| `GET` | `/api/settings/cards` | List all cards with enable state |
| `POST` | `/api/settings/cards/:id/enable` | Master enable |
| `POST` | `/api/settings/cards/:id/disable` | Master disable |

### Reorder payload

```http
POST /api/manifests/reorder
Authorization: Bearer $AGENT_API_TOKEN
Content-Type: application/json

{ "order": ["mood", "weight", "bp", "peptides"] }
```

Writes sparse-numbered `meta.order` (100, 200, 300, …) to each listed
card. Unlisted cards keep their existing order. Any unknown id causes
a 404 with no writes performed. Returns `{ ok: true, updated: [...ids] }`.

Idempotent — posting the same order twice is a no-op (file mtimes
unchanged). Use this when the user says *"move the mood card to the
top"* or similar.

### Write payload format

To add a weight entry:
```http
POST /api/manifests/weight/data
Authorization: Bearer <AGENT_API_TOKEN>
Content-Type: application/json

{
  "data": [
    { "date": "2026-04-20", "kg": 85.5 },
    { "date": "2026-04-21", "kg": 86.0 }
  ]
}
```

The POST replaces the entire data array. Agents are responsible for the
upsert semantics (fetch, merge, write back).

### Schema validation

The registry validates `$schema` and core `meta.*` fields, but does **not**
impose a schema on the `data` block. Whatever you write is what gets read
back. This keeps card authorship flexible but means agents must honour the
per-card convention (typically `{ date: "YYYY-MM-DD", ...fields }` rows).

### Creating and deleting cards

Agents can author brand new cards without filesystem access. `POST
/api/manifests` takes a full manifest body and writes it to
`$HEALTH_HOME/data/<meta.id>.json`:

```http
POST /api/manifests
Authorization: Bearer $AGENT_API_TOKEN
Content-Type: application/json

{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "blood-pressure",
    "label": "Blood Pressure",
    "emoji": "🩺",
    "view":      { "enabled": true, "component": "list-card" },
    "writeable": {
      "fromWebapp": true, "todayAllowed": true, "pastAllowed": true,
      "inputs": [
        {"key":"systolic","label":"Systolic","type":"number","required":true},
        {"key":"diastolic","label":"Diastolic","type":"number","required":true}
      ]
    }
  },
  "description": "Home BP readings.",
  "data": []
}
```

| Status | Meaning |
|--------|---------|
| 201 | Created (`{ok, id, source}`) |
| 400 | Malformed: bad JSON, wrong `$schema`, missing `meta.id`/`meta.label` |
| 401 | No auth |
| 409 | `meta.id` already in use |
| 422 | `meta.id` fails the sanitiser (format / reserved / path escape) |
| 500 | Filesystem write failed |

`meta.id` must match `/^[a-z0-9][a-z0-9._-]*$/`, max 64 chars, and not
be one of the reserved names (`_archive`, `_virtual`, `_meta`,
`auto-export`, `reports`, `index`). Everything else is pass-through —
unknown renderer names are accepted on purpose; they render as a
placeholder card until a matching renderer ships. See
`MANIFEST-SCHEMA.md` for the full field reference.

Deletion mirrors the create path:

```http
DELETE /api/manifests/blood-pressure
Authorization: Bearer $AGENT_API_TOKEN
```

Returns `{ok, id}` on success, 404 if the id is unknown. The file is
unlinked; any data it contained is gone. Prefer `meta.enabled:false`
if you only want to hide the card.

### Disabled cards still accept writes

If a card has `meta.enabled: false`, writes to it still succeed (the data
is saved to disk). The user just won't SEE the card until they re-enable it.
This is intentional — you might want a background logging card that shows
up only when the user flips it on.

---

## 3. Writing a new agent integration

Here's the minimum viable agent:

```python
import requests

TOKEN = "your-agent-token"
BASE = "https://health.example.com"

def log_weight(kg, date=None):
    # Fetch current data
    r = requests.get(f"{BASE}/api/manifests/weight/data",
                     headers={"Authorization": f"Bearer {TOKEN}"})
    r.raise_for_status()
    data = r.json()["data"]

    # Upsert
    date = date or datetime.date.today().isoformat()
    data = [d for d in data if d.get("date") != date]
    data.append({"date": date, "kg": kg})
    data.sort(key=lambda d: d["date"])

    # Write back
    r = requests.post(f"{BASE}/api/manifests/weight/data",
                      headers={"Authorization": f"Bearer {TOKEN}"},
                      json={"data": data})
    r.raise_for_status()
```

Scale it up with card discovery (`GET /api/manifests`), schema inspection
(`GET /api/manifests/:id`), and whatever UX your agent provides.

---

## 4. Reference integration: chat agent integration

A minimal chat agent integration wraps this API with a bearer token. The pattern
is the same as any HTTP client integration:

1. Skill reads `EDDZHEALTH_URL` + `EDDZHEALTH_TOKEN` from env
2. Intent dispatch: "log weight 85kg" → `POST /api/manifests/weight/data`
3. Query dispatch: "what was yesterday's mood?" →
   `GET /api/manifests/mood/data` → filter → reply

You don't need any particular agent framework. Any HTTP client + your model of
choice can drive this API.

---

## 5. Security notes

- `AGENT_API_TOKEN` bypasses WebAuthn — treat it like a production secret.
- HTTPS is strongly recommended; the session-cookie path explicitly sets
  `Secure` on HTTPS origins.
- The agent endpoint doesn't have a rate limit by default. Put one in front
  via nginx/Caddy if you expose it to the internet.
- Cards with `meta.writeable.pastAllowed: false` or `futureAllowed: false`
  will reject out-of-window writes from the webapp UI, but the bearer-token
  agent API does NOT currently enforce these policies. Agents are trusted.
