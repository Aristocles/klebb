# Klebb

[![tests](https://github.com/Aristocles/klebb/actions/workflows/test.yml/badge.svg)](https://github.com/Aristocles/klebb/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/Aristocles/klebb.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/klebb.svg)](https://nodejs.org/)

A **file-driven**, **manifest-based** personal health dashboard. You
drop JSON files into a folder; cards appear. Delete a file; the card is
gone. That's the whole model.

No database. No catalog. No install flow. No build step. Fewer moving
parts than most static-site generators.

Works equally well as:

- A personal dashboard you drive manually
- A target for a chat agent (Claude / GPT / OpenClaw skill / whatever)
  to log into
- A multi-user self-hosted install with WebAuthn passkey auth

## Table of contents

- [Quickstart](#quickstart)
- [What is a "card"?](#what-is-a-card)
- [Running tests](#running-tests)
- [Configuration](#configuration)
- [Docs](#docs)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

## Quickstart

```bash
git clone https://github.com/Aristocles/klebb.git
cd klebb
npm install

export HEALTH_HOME=~/klebb-data
mkdir -p "$HEALTH_HOME/data"

# Optional: copy an example card to get started
cp data.example/weight.example.json "$HEALTH_HOME/data/weight.json"

npm start
# open http://localhost:8080
```

Drop more manifest files into `$HEALTH_HOME/data/` and refresh. See
[`docs/CARDS.md`](docs/CARDS.md) for the full authoring guide.

### Screenshots

_(Screenshots coming in the next release. Run the quickstart above to
see the real thing — takes 2 minutes.)_

## What is a "card"?

Every card is a JSON file that looks like this:

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "weight",
    "label": "Weight",
    "emoji": "⚖️",
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": {
        "template": "{kg:round(1)}",
        "unit": "kg",
        "trendArrow": { "field": "kg" }
      }
    },
    "writeable": {
      "fromWebapp": true,
      "maxReadingsPerDay": 1,
      "inputs": [
        { "key": "kg", "type": "number", "required": true }
      ]
    }
  },
  "data": [
    { "date": "2026-04-20", "kg": 85.5 }
  ]
}
```

- `meta.view.display.template` drives what the card shows — no
  component code needed for common cases
- `meta.writeable.inputs` drives the edit form
- `data` is the log; the webapp appends to it, the chat agent reads
  from it
- A plain text file the registry loads on boot (and re-reads via
  `fs.watch` whenever you change it)

For card types that need more than the generic renderer handles
(medication schedules, line charts, markdown docs), there are specialised
renderers you pick by name.

## Running tests

```bash
npm test
```

Tests spin up ephemeral `HEALTH_HOME` directories and the full HTTP
server on random ports, exercising the registry, Settings API,
display-template engine, bearer-auth path, migration scripts, and
repo-hygiene scanners.

~180 tests, runs in ~3 seconds, zero flakiness.

CI runs the suite on Node 20 + 22 for every push and pull request.

## Configuration

Minimum env vars to start:

| Var | Default | Purpose |
|-----|---------|---------|
| `HEALTH_HOME` | `~/klebb` | Where your data lives (`data/`, `credentials/`, `sessions/`) |
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |

For production deploys you MUST also set:

| Var | Purpose |
|-----|---------|
| `HEALTH_ORIGIN` | Public origin (e.g. `https://klebb.example.com`) |
| `HEALTH_RP_ID` | WebAuthn Relying Party ID (hostname of `HEALTH_ORIGIN`) |

Optional feature flags:

| Var | Purpose |
|-----|---------|
| `AGENT_API_TOKEN` | Bearer token for server-to-server card writes |
| `OPENCLAW_HOST`, `OPENCLAW_PORT`, `OPENCLAW_TOKEN`, `OPENCLAW_MODEL`, `OPENCLAW_TLS` | Chat widget gateway |
| `CHAT_AGENT_NAME`, `CHAT_AGENT_EMOJI` | Chat widget branding |
| `FISH_AUDIO_API_KEY`, `FISH_AUDIO_DEFAULT_VOICE` | Voice chat |
| `HEALTH_INSTANCE_NAME`, `HEALTH_RP_NAME` | UI branding |

See [`config/env.js`](config/env.js) for the complete list with
defaults.

## Docs

- [`docs/CARDS.md`](docs/CARDS.md) — How to write and manage cards (user guide)
- [`MANIFEST-SCHEMA.md`](MANIFEST-SCHEMA.md) — Manifest format reference
- [`docs/CHAT-AGENT.md`](docs/CHAT-AGENT.md) — Chat widget + server-to-server integration
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — Single-user + multi-user deploy guide
- [`docs/CI.md`](docs/CI.md) — CI workflow overview
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contributor conventions
- [`CHANGELOG.md`](CHANGELOG.md) — Release notes
- [`SECURITY.md`](SECURITY.md) — Security policy

## Architecture

```
server.js                         HTTP + static + API entry
config/
  env.js                          env + branding + gateway config
  paths.js                        HEALTH_HOME resolution
manifests/
  registry.js                     discover / validate / cache / write
auth/
  webauthn.js                     passkey register + verify
  invites.js                      invite-code issuance
voice/
  fish.js                         Fish Audio TTS/ASR (optional)
public/
  js/
    app.js                        top-level routing
    renderer-registry.js          component name → tag name map
    components/
      eh-base-card.js             base class (fetch + loading + error)
      eh-generic-card.js          zero-code card driven by display templates
      eh-input-form.js            manifest-driven input form
      eh-settings-view.js         master enable/disable toggle list
      eh-view-renderer.js         composes cards into a grid
      ...                          specialised renderers (schedule, checklist, charts)
    lib/
      display-template.js         template engine (UMD — Node tests load it)
      display-template.esm.js     same engine, ES module flavour for browser
scripts/
  deploy.sh                       atomic release + auto-rollback
  verify-install.sh               pre-flight health check
  migrate-*.js                    schema + card-shape migrations
  invite.js / revoke.js / list.js auth CLI
tests/
  helpers/sandbox.js              ephemeral HEALTH_HOME + server for each test
  *.test.js                       runs via `npm test`
systemd/
  klebb@.service                  templated unit for multi-instance hosts
docs/                             user + contributor docs
data.example/                     reference manifest files (not auto-installed)
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: `npm test`
must pass, keep commits focused, update `CHANGELOG.md` under
`## Unreleased`, and don't commit secrets or personal paths (the
hygiene tests will catch you).

Bug reports + feature requests: use the templates at
<https://github.com/Aristocles/klebb/issues/new/choose>.

Security issues: see [`SECURITY.md`](SECURITY.md). Don't open a public
issue for those.

## License

MIT — see [`LICENSE`](LICENSE).
