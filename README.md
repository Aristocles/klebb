# EddzHealth

A **file-driven**, **manifest-based** personal health dashboard.

Every card on the dashboard is a JSON file in your `$HEALTH_HOME/data/`
directory. No database, no catalog, no "install" step. If the file exists
and the manifest is valid, the card appears. If you delete the file, the
card is gone.

Works equally well as:
- A personal dashboard you drive manually
- A target for a chat agent (any OpenAI-compatible LLM) to log to
- A multi-user install with WebAuthn passkey auth

---

## Quickstart

```bash
git clone https://github.com/makeitbreakitfixit/eddzhealth.git
cd eddzhealth
npm install

# Point HEALTH_HOME at wherever you want your data stored.
# If empty, no cards will show until you add manifest files.
export HEALTH_HOME=~/eddzhealth
mkdir -p $HEALTH_HOME/data

# Optional: copy some example cards to get started
cp data.example/weight.example.json $HEALTH_HOME/data/weight.json

npm start
# open http://localhost:8080
```

Drop manifest files into `$HEALTH_HOME/data/` and refresh. See
[`docs/CARDS.md`](docs/CARDS.md) for the full card-authoring guide.

---

## Running tests

```bash
npm test
```

Tests spin up ephemeral `HEALTH_HOME` directories and the full HTTP server
on random ports, exercising the registry, Settings API, display-template
engine, and auth flows.

---

## Configuration

Minimal environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `HEALTH_HOME` | *(required)* | Root for `data/`, `credentials/`, `sessions/` |
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `SESSION_SECRET` | *(auto-gen)* | Session signing secret |
| `AGENT_API_TOKEN` | *(disabled)* | Bearer token for server-to-server card writes |
| `CHAT_GATEWAY_HOST` | `127.0.0.1` | Upstream chat-gateway gateway for chat |
| `CHAT_GATEWAY_PORT` | `8787` | ^ |
| `CHAT_GATEWAY_TLS` | `0` | ^ |
| `CHAT_GATEWAY_TOKEN` | — | ^ |
| `CHAT_GATEWAY_MODEL` | *(gateway default)* | Model id |
| `HEALTH_AGENT_NAME` | `Axis` | Chat agent display name |
| `HEALTH_AGENT_AVATAR` | `⚡` | Chat agent emoji |
| `FISH_AUDIO_API_KEY` | *(disabled)* | Fish Audio TTS/ASR for voice chat |

See `config/env.js` for the full list.

---

## Docs

- [`docs/CARDS.md`](docs/CARDS.md) — How to write and manage cards
- [`MANIFEST-SCHEMA.md`](MANIFEST-SCHEMA.md) — Manifest format spec
- [`docs/CHAT-AGENT.md`](docs/CHAT-AGENT.md) — Chat and server-to-server integration
- [`DEPLOY-CHUCK.md`](DEPLOY-CHUCK.md) — Example multi-user deploy guide
- [`SPEC.md`](SPEC.md) — Original design spec

---

## Architecture

```
server.js                  HTTP + static + API entry point
config/
  env.js                   env var reading + defaults
  paths.js                 HEALTH_HOME resolution + per-path helpers
manifests/
  registry.js              File discovery, validation, cache, write
auth/
  webauthn.js              Passkey register/verify
  invites.js               Invite-code issuance
voice/
  fish.js                  Fish Audio TTS/ASR (optional)
  cache.js                 Audio cache
public/
  js/
    app.js                 Top-level routing
    renderer-registry.js   component name → tag name map
    components/
      eh-base-card.js      Base class; handles fetch + loading state
      eh-generic-card.js   Zero-code card renderer (display templates)
      eh-input-form.js     Manifest-driven input form
      eh-settings-view.js  Settings UI (master enable/disable)
      eh-view-renderer.js  Composes cards into a grid
      ... plus per-component renderers
    lib/
      display-template.js  Template engine (UMD for Node tests)
      display-template.esm.js  Same engine, ES module flavour
tests/
  helpers/sandbox.js       Spawn ephemeral server + HEALTH_HOME
  *.test.js                Runs via `npm test`
data.example/              Reference manifest files (not auto-installed)
```

---

## Contributing

Tests must pass (`npm test`). Breaking changes to the manifest schema bump
the `$schema` version. See commits for recent changes.

MIT licensed.
