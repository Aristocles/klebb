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
provider's OpenAI-compat endpoint (AWS Bedrock, Groq, Together,
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
