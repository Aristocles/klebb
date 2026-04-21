# Chat agent integration

EddzHealth ships with a chat widget that can write to cards and answer
questions about your data. The widget is **agent-agnostic**: it talks to an
chat-gateway chat-completions endpoint, which can be backed by whatever model
you configure.

This doc covers:
1. How the chat widget is configured
2. How server-to-server writes from an external agent work
3. What's NOT included (and what you'd need to build)

---

## 1. Chat widget — chat-gateway backend

The in-page chat widget (`health-chat.js`) sends user messages to an
chat-gateway gateway over HTTP and renders the streamed response.

Configure via environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `CHAT_GATEWAY_HOST` | `localhost` | chat-gateway gateway hostname |
| `CHAT_GATEWAY_PORT` | `8787` | Gateway port |
| `CHAT_GATEWAY_TLS` | auto | `true` to use HTTPS, `false` for HTTP (auto: true for non-localhost) |
| `CHAT_GATEWAY_TOKEN` | — | Bearer token for the gateway |
| `CHAT_GATEWAY_MODEL` | *(gateway default)* | Model id to request |
| `HEALTH_SYSTEM_PROMPT` | built-in | System prompt sent with each turn |
| `CHAT_AGENT_NAME` | `Chat` | Display name shown in the chat UI |
| `CHAT_AGENT_EMOJI` | `💬` | Emoji/char shown as the agent avatar |

Point these at your chat-gateway instance and the chat just works. The webapp
itself does NOT know which model is behind the gateway; that's the gateway's
job.

### What the widget does NOT do

- It does not run tools directly. Tool-use is the gateway's responsibility
  (chat-gateway's skill/MCP plumbing).
- It does not embed model credentials. All auth flows through
  `CHAT_GATEWAY_TOKEN`.

If you want to plug a different backend (any OpenAI-compatible LLM),
you have two paths:
1. Put an chat-gateway gateway in front of it. Minimum fuss — the webapp talks
   chat-gateway and knows nothing else.
2. Replace the chat-proxy section of `server.js` with your own upstream.
   Everything else in the webapp (manifests, auth, views) is untouched.

---

## 2. Server-to-server writes (AGENT_API_TOKEN)

When an external agent (chat-gateway skill, cron job, mobile shortcut, etc.)
needs to write to a card without going through the chat widget, it
authenticates with a bearer token instead of a WebAuthn session cookie.

**Enable it:** set `AGENT_API_TOKEN` in the environment. Any request with
`Authorization: Bearer <token>` is treated as an authenticated agent.

**Endpoints available to agents:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/manifests` | List all cards |
| `GET` | `/api/manifests/:id` | Fetch full manifest |
| `GET` | `/api/manifests/:id/data` | Fetch just the data block |
| `POST` | `/api/manifests/:id/data` | Replace the data block |
| `GET` | `/api/views/:view` | List cards for a view |
| `GET` | `/api/settings/cards` | List all cards with enable state |
| `POST` | `/api/settings/cards/:id/enable` | Master enable |
| `POST` | `/api/settings/cards/:id/disable` | Master disable |

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

## 4. Reference integration: chat-gateway skill

A minimal chat-gateway skill wraps this API with a bearer token. The pattern
is the same as any HTTP client integration:

1. Skill reads `EDDZHEALTH_URL` + `EDDZHEALTH_TOKEN` from env
2. Intent dispatch: "log weight 85kg" → `POST /api/manifests/weight/data`
3. Query dispatch: "what was yesterday's mood?" →
   `GET /api/manifests/mood/data` → filter → reply

You don't need chat-gateway to build an agent. Any HTTP client + your model of
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
