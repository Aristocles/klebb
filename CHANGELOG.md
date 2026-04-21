# Changelog

All notable changes to Klebb are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and uses
the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

## [2.0.0] - 2026-04-21

First public release, renamed from **EddzHealth** to **Klebb**. Major
rewrite: **files are the source of truth**, zero-code card authoring, no
catalog or install flow, AI-agent-friendly HTTP API.

### Breaking changes

- **Manifest `$schema`** changed from `eddzhealth.datafile.v1` to
  `klebb.datafile.v1`. The server only accepts the new value. Migration:
  `npm run migrate-schema` (idempotent, `--dry-run` available).
- **Mood + notes data shape** — cards that previously stored data as a
  date-keyed object (`{ "2026-04-21": { ... } }`) now use the array-of-dated-rows
  shape (`[{ date: "2026-04-21", ... }]`) used by every other card.
  Migration: `node scripts/migrate-date-keyed-to-array.js --dir $HEALTH_HOME/data`.
  Server-side safety net: POST writes in the old shape auto-convert on
  the way in, with a warning logged.
- **Removed renderers:** `metric-card`, `notes-card`, `quick-action-card`.
  Use `generic-card` instead. The card migration tool
  (`scripts/migrate-cards-to-generic.js`) handles the common cases.
- **Removed endpoints:** `/api/setup`, `/api/setup/install`,
  `/api/settings/cards/:id/archive`, `/api/settings/cards/:id/restore`,
  `/api/calendar/health`. The install flow is gone entirely (files are
  the source of truth).
- **Session cookie renamed** — `vorhealth_session` → `klebb_session`.
  Existing browsers will see a one-time re-auth prompt after the upgrade.
- **Default env values changed:**
  - `CHAT_AGENT_NAME`: was `Axis`, now `Chat`
  - `CHAT_AGENT_EMOJI`: was `⚡`, now `💬`
  - `HEALTH_RP_ID`: was `axis.vorignet.com`, now `localhost`
  - `OPENCLAW_TOKEN`: was a hardcoded production token (security leak);
    now empty by default — chat widget disabled unless set
  - `PORT`: was `10002`, now `8080`
  - `HEALTH_HOME` fallback: was `~/axis/workspace/.private/health`,
    now `~/klebb`
- **Removed feature:** The `/api/calendar/health` endpoint (pulled health
  events from Google Calendar via a hardcoded Python path). Wholly
  user-specific; removed with no replacement.

### Added

- **`generic-card` renderer.** Zero-code card renderer driven entirely by
  `meta.view.display` (template string, emoji map, thresholds, trend
  arrow, unit suffix) and `meta.writeable.inputs` (10 input types:
  number, text, textarea, select, emoji-picker, colour, checkbox, date,
  time, rating). See [`docs/CARDS.md`](docs/CARDS.md).
- **Display template engine.** Supports `{key}`, `{key:round(N)}`,
  `{key:emoji}`, `{key:truncate(N)}`, `{key|default}`, `{key?yes:no}`,
  dotted-path access. Pure function, fully tested.
- **Threshold evaluator** with `min`/`max`/`eq` matchers, first-match-wins.
- **Trend arrow** comparing current vs previous entry on the same key.
- **Master `meta.enabled` flag** — single toggle hides a card from every
  view. Settings UI exposes one switch per card.
- **`AGENT_API_TOKEN` bearer auth** — documented contract for
  server-to-server writes (for chat agents, cron jobs, mobile shortcuts).
  See [`docs/CHAT-AGENT.md`](docs/CHAT-AGENT.md).
- **Templated systemd unit** `klebb@<instance>.service` for multi-instance
  deploys.
- **Deploy tooling:** `scripts/deploy.sh` (atomic release dirs,
  auto-rollback on health-check failure, pruning),
  `scripts/verify-install.sh` (non-destructive pre-flight check).
- **Migration tooling:** `migrate-to-klebb.js`, `migrate-cards-to-generic.js`,
  `migrate-date-keyed-to-array.js`, `migrate-v1-to-v2.js`.
- **Test suite:** 182 tests / 31 suites / Node 20+22 matrix CI.
- **Repo hygiene tests:** `no-personal-refs.test.js`,
  `no-secrets.test.js` — automated scanners that block personal
  identifiers, hardcoded paths, and leaked tokens from landing.
- **Docs:** `docs/CARDS.md`, `docs/CHAT-AGENT.md`, `docs/DEPLOY.md`,
  `docs/CI.md`, `MANIFEST-SCHEMA.md`, `README.md`, `CONTRIBUTING.md`.

### Changed

- **Settings view** rewritten as a flat toggle list with one switch per
  card (was: catalog + install wizard + archive buttons).
- **Chat system prompt** is now generic — no hardcoded file names,
  points agents at `/api/manifests` for discovery instead of enumerating
  specific cards.
- **Registry** gains `fs.watch` for automatic reload when card files
  change on disk. Drop a new manifest into `data/` and it appears within
  a second.
- **Auth legacy-user-label** is no longer hardcoded; uses the first
  registered user or a configurable env override.

### Fixed

- Hardcoded production OpenClaw bearer token removed from source. If the
  chat widget needs a token, set `OPENCLAW_TOKEN` in the environment.
- Chat widget no longer shows an audio play button on typed replies —
  only on voice-mode replies.
- `scripts/deploy.sh` restart path works against the `klebb@.service`
  template.

### Security

- The repo's `tests/no-secrets.test.js` blocks common secret patterns
  and high-entropy tokens from being committed.
- The repo's `tests/no-personal-refs.test.js` blocks known personal
  identifiers and hardcoded absolute paths.

### Removed

- Legacy renderers (`metric-card`, `notes-card`, `quick-action-card`) —
  ~870 LOC deleted
- Setup wizard (`setup/wizard.js`, `eh-setup-wizard.js`, `setup.html`
  wizard UI) — ~400 LOC deleted
- `/api/calendar/health` endpoint + its Python shell-out
- `mood-checkin.js` floating widget (superseded by in-card ✏️)
- Legacy `eddzhealth@.service` systemd template
- `SPEC.md` (superseded by `README.md` + `docs/CARDS.md`)
- `scripts/migrate-chuck-md-to-json.js` (one-off, migration complete)

### Migrating from pre-2.0.0 installs

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full deploy flow. Quick
version:

1. `npm run migrate-schema` — rewrite `$schema` strings
2. `node scripts/migrate-date-keyed-to-array.js --dir $HEALTH_HOME/data`
   — convert mood + notes data shapes
3. `node scripts/migrate-cards-to-generic.js --dir $HEALTH_HOME/data`
   — point weight/bp/mood/notes at `generic-card`
4. Set the new required env vars — at minimum `HEALTH_RP_ID` and
   `HEALTH_ORIGIN` to match your domain
5. `systemctl restart klebb@<instance>` (or your own equivalent)

[Unreleased]: https://github.com/Aristocles/klebb/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Aristocles/klebb/releases/tag/v2.0.0
