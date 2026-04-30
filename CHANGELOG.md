# Changelog

All notable changes to Klebb are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and uses
the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added

- **Calendar markers can now reflect the day's value, not just "had
  data".** `meta.calendar.marker` accepts either a string (static
  glyph, existing behaviour) or an object describing a per-day glyph.
  Two kinds ship: `type: "field-emoji"` picks a glyph from an
  `emojiMap` keyed by a field value on that day's row (e.g. mood 1..5
  → 😩😴😐🙂😄); `type: "trend-arrow"` compares the day's reading to
  the previous one and renders ⬆️/⬇️/➡️ (e.g. weight vs previous
  reading). The resolver is type-discriminated so new kinds can ship
  without a schema bump. `mood.example.json` and `weight.example.json`
  demonstrate both. See `docs/CARDS.md` (§ `meta.calendar`) and
  `docs/RECIPES.md` (Recipe 11). (#43)
- **Chat conversation is now stored server-side and follows the user
  across devices.** Previously the chat widget had no memory past the
  current panel-open, so switching from phone to laptop lost the
  conversation. The transcript now lives in
  `$HEALTH_HOME/chat/history.json`, behind the existing WebAuthn
  session cookie, and is loaded whenever the widget mounts.
  New endpoints: `GET /api/chat/history`,
  `PUT /api/chat/history { messages: [...] }`, and
  `DELETE /api/chat/history` (the "New chat" button path).
  A new 📝 button in the chat header clears the conversation after a
  confirm prompt. Only real `user` / `assistant` turns are persisted
  (errors and transient state stay in-memory); audio blobs aren't
  serialised and are re-synthesised on demand. The server caps the
  payload at 512 KB and trims to the last 200 turns. Saves from the
  client are debounced 500 ms so rapid turns don't spam. (#55)
- **Timezone is now an explicit, documented config knob.** The container
  image defaults to `TZ=UTC`; operators can override via the `TZ` env
  var with any IANA zone (e.g. `Australia/Sydney`). The active zone is
  logged in the boot banner. Node honours `TZ` natively, so this
  affects every Date the app constructs (demo seed anchor, card entry
  dates, sentinel timestamps, log output). See the Timezone note in
  `docs/DEPLOY.md`. (#32)

### Fixed

- **Chat no longer aborts an in-flight reply on every momentary tab
  switch.** The visibility-change watcher used to abort any pending
  `/api/chat` request the instant the tab became visible again,
  showing "Connection interrupted — send again" even for a
  sub-second flicker. It now records when the tab went hidden and
  only aborts if the tab was actually backgrounded for 3+ seconds
  (long enough for mobile OSes to freeze the TCP socket). Brief
  flickers leave the reply to arrive normally. The companion
  `/api/config` keep-alive nudge has been removed: it never
  actually rescued the chat socket, since it was a separate HTTP
  request to a different endpoint. (#45)
- **Chat no longer hangs for 60s and returns "Failed to connect" when
  the gateway closes its TCP socket abruptly after a successful
  response.** The `/api/chat` proxy's `error` and `timeout` handlers
  unconditionally called `sendJSON` on the client response, so an
  upstream RST arriving after the reply had already been flushed would
  trigger `ERR_HTTP_HEADERS_SENT` and crash the Node process. Docker
  would then restart the container, the next chat request would land
  on a half-started server, and the browser would eventually time out
  with "Failed to connect". Both handlers now guard with
  `res.headersSent` before writing. (#41)
- **Cards no longer overflow the viewport on narrow phones.** A card
  whose content had a long unbreakable string (e.g. a supplement named
  "Swisse Ultiboost Magnesium Glycinate" with `white-space: nowrap` on
  the list row) could push its grid track wider than the viewport,
  dragging every other card with it and clipping the right edge of the
  Today page on iPhone 13 mini (375px). Fix: the view-renderer grid
  now uses `minmax(0, 1fr)` instead of plain `1fr` so a card's
  min-content width can't expand its column. Per-card
  ellipsis / overflow then does its job. (#37)
- **Modal prompts now fire correctly in UTC+ timezones.** Client-side
  "today" was computed with `new Date().toISOString().slice(0, 10)`,
  which always returns a UTC date. For users in e.g. AEST (UTC+10),
  "today" silently rolled back to "yesterday" before 10:00 AM local
  time, so `meta.prompt` cards (like the Mood modal) never fired on
  first load of the day. All client date computations now go through
  a shared `localToday()` helper that uses the device's local
  timezone. (#36)
- **`futureAllowed: false` (and `pastAllowed: false`) now actually
  block webapp writes.** Previously the ➕/✏️ button showed on every
  date and the `POST /api/manifests/:id/data` handler ignored the
  allowance flags, so future/past-dated entries could be added even
  when the manifest forbade them. The generic and list cards now read
  the base-class `_canWrite` (which respects `dateMode`), and the
  server rejects webapp POSTs that introduce a row on a disallowed
  date with 403. Edits to rows on already-stored dates are still
  accepted. Agent bearer-token writes bypass the date gate for
  legitimate backfills and schedule pre-population. (#34)

### Changed

- **Chat endpoint config is now a single URL + key + model; legacy
  `CHAT_GATEWAY_*` env vars still accepted.** Klebb posts the OpenAI
  chat-completions shape to whatever URL the operator configures, so
  any endpoint that speaks that shape works: a self-hosted gateway
  (LiteLLM, custom), a cloud provider's OpenAI-compat endpoint
  (Bedrock, Groq, Together), a local runtime (Ollama, vLLM), or
  OpenAI / OpenRouter directly. The three canonical env vars are
  `CHAT_ENDPOINT_URL`, `CHAT_API_KEY`, and `CHAT_MODEL`; the URL
  scheme picks http vs https and the path is honoured verbatim, so
  `/v1/chat/completions` is no longer special. Existing deploys using
  `CHAT_GATEWAY_HOST` + `CHAT_GATEWAY_PORT` + `CHAT_GATEWAY_TLS` +
  `CHAT_GATEWAY_TOKEN` + `CHAT_GATEWAY_MODEL` continue to work — those
  vars are composed into the canonical URL internally and a
  deprecation warning is logged at boot. New installs should use the
  canonical names. (#47)
- **Voice chat env vars renamed; legacy names still accepted.**
  Canonical config is now `FISH_AUDIO_VOICE_ID`, `FISH_AUDIO_MODEL`, and
  `FISH_AUDIO_ENABLED`. The previous names (`FISH_AUDIO_DEFAULT_VOICE`,
  `FISH_BACKEND`) continue to work for existing deploys. Playback speed
  cycle now includes `0.5x` (so the full cycle is 0.5, 1, 1.25, 1.5, 2).
  `GET /api/voice/config` returns `{ enabled: false }` instead of 500
  when no key is configured, so the client can cleanly hide the mic
  button. (#27)
- **Demo welcome + how-to-add-a-card cards link out to full reports.**
  The dashboard cards are now short blurbs; the long-form content lives
  in `reports/welcome.md` and `reports/how-to-add-a-card.md`, rendered
  by the existing `/report/<name>` route.
- **SPDX + copyright headers on every source file.** Added
  `SPDX-License-Identifier: AGPL-3.0-only` +
  `Copyright (C) 2026 Aristocles <https://github.com/Aristocles>`
  to `.js`, `.css`, `.html`, `.sh`, `.service`, and `.yml` files
  across the repo. Legacy UI (`_legacy-v1/`), example data
  (`data.example/`), and docs are excluded. An idempotent helper
  (`scripts/add-spdx-headers.js`) handles re-applying on new files.
  (#15)
- **Licence switched from MIT to AGPL-3.0-only.** Replaced `LICENSE`
  with the full GNU Affero General Public License v3.0 text and a
  clean copyright line: `Copyright (C) 2026 Aristocles
  <https://github.com/Aristocles>`. Added `AUTHORS.md`. Updated
  `package.json` (`license: "AGPL-3.0-only"`) and the README licence
  section. No code-level per-file headers in this pass. (#14)

### Added — Phase 9 (card reordering)

- **Card reordering.** New `POST /api/manifests/reorder` endpoint that
  reassigns `meta.order` across cards using sparse numbering (100, 200,
  300…). Idempotent. Unknown ids cause a 404 with no partial writes.
- **Drag-and-drop UI.** Tap ⚙️ in the top nav → "⋮⋮ Reorder cards" to
  enter reorder mode. Each card shows a drag handle; drag to reorder,
  tap "Done" to exit. Keyboard users can Tab to a handle and press ↑/↓
  to move that card.
- **Sortable.js** loaded from esm.sh (~14KB gzipped) for robust
  touch/mouse drag. Animation, ghost, and focus ring handled.
- **ARIA live announcements** when a card moves ("Mood moved up.").
- **Nav menu pattern.** The ⚙️ top-nav button now opens a dropdown menu
  (⋮⋮ Reorder cards + ⚙️ Settings) instead of navigating directly.
  Keeps the nav bar tight on mobile while still exposing both actions.

### Added — Phase 8 (card library)

- **Card library:** 15 new example manifests in `data.example/`, covering:
  vitals (heart rate resting, SpO₂, body temperature), sleep (hours,
  quality, HRV), mental (energy, stress), movement (steps, workouts,
  active minutes), freeform (reflections), creative trackers (hydration,
  Bristol stool, caffeine), plus a `how-to-add-a-card` inline guide.
- **`docs/RECIPES.md`:** 10 copy-pasteable patterns covering every
  renderer feature and input type (single-number metric with trend,
  two-number with thresholds, emoji-picker rating, 1-5 rating, categorical
  tracker, yes/no checkbox, truncated textarea, multi-reading-per-day,
  time-of-day tracker, colour tracker).
- **`npm run seed`:** opt-in starter kit that copies welcome + weight +
  notes + how-to-add-a-card into `$HEALTH_HOME/data/`. Safe: skips
  existing files unless `--force` is passed.

### Tests

- `tests/reorder-api.test.js`: +11 tests covering happy path, all
  validation failure modes (missing order, non-array, empty, unknown
  id, duplicate id, malformed JSON), idempotency, and partial reorder
  behaviour.
- `tests/example-manifests.test.js`: +27 tests that walk every
  `data.example/*.json` and assert valid schema, known renderer names,
  known input types, unique ids, filename-id matches, and a real
  description for AI writers.

Total: 228/228 (was 190 before Phase 8+9).

### Changed

- `welcome.example.json` copy rewritten to prominently feature Klebbius
  (the chat agent) as the go-to for adding / modifying / hiding cards.
  Emphasises conversational card authoring over hand-editing JSON.

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
  - `CHAT_AGENT_NAME`: was a project-specific string, now `Chat`
  - `CHAT_AGENT_EMOJI`: was a project-specific glyph, now `💬`
  - `HEALTH_RP_ID`: was a real domain, now `localhost`
  - `CHAT_GATEWAY_TOKEN`: was a hardcoded production token (security leak);
    now empty by default — chat widget disabled unless set
  - `PORT`: was `10002`, now `8080`
  - `HEALTH_HOME` fallback: was `~/.klebb/data` or `$HEALTH_HOME`,
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

- Hardcoded production chat gateway bearer token removed from source. If the
  chat widget needs a token, set `CHAT_GATEWAY_TOKEN` in the environment.
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
- Legacy systemd template (replaced by `systemd/klebb@.service`)
- `SPEC.md` (superseded by `README.md` + `docs/CARDS.md`)
- One-off data-migration scripts (no longer needed once the v2 migration
  landed; preserved only in git history)

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
