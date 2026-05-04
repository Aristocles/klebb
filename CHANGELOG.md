# Changelog

All notable changes to Klebb are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and uses
the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added

- **Chat bubbles render GFM markdown, including tables.** The widget
  was rolling its own ~25-line regex parser that covered bold / italic
  / inline code / bullets / paragraphs — enough for most replies, but
  markdown tables, task lists, strikethrough, and autolinks all
  rendered as literal pipes/dashes. Swapped to \`marked@15\` with GFM
  enabled, matching the server-side config. \`DOMPurify@3\` sanitises
  the output before it reaches the DOM — scripts, event handlers, and
  \`javascript:\` / \`data:\` URLs are stripped. Assistant-emitted
  links get \`target="_blank" rel="noopener noreferrer"\` via a
  DOMPurify hook. Both deps load from esm.sh at pinned versions (same
  pattern as Lit); no bundler, no \`package.json\` change. (#77)
- **Chat agent can hide and unhide cards.** Two new tools
  (\`hide_card\`, \`show_card\`) wire the chat agent into the existing
  \`registry.setMasterEnabled\` path, so "hide the hydration card"
  actually works instead of being answered with "go to Settings". The
  deletion guidance in the system prompt now steers the model toward
  \`hide_card\` whenever the user just wants a card off their
  dashboard, since it's reversible and preserves all logged data.
  (#75)

### Changed

- **Chat agent asks for clarification only when a card request is
  genuinely ambiguous, and offers optional extras after creating.**
  Previously, "add a hydration card" would just produce a plain
  generic-card with one number input and no follow-up. The system
  prompt now tells the agent to (1) default to creating when defaults
  are obvious (hydration, mood, steps etc. just ship), (2) ask ONE
  focused question before creating only when a renderer-critical
  choice is genuinely ambiguous (glucose = list vs generic?; weight =
  kg vs lb if not already established?; dose-cadence cards need
  schedule shape), and (3) always end a successful \`create_manifest\`
  reply with a 2-3 item offer of tailored embellishments (trends
  chart, calendar marker, headline thresholds, reports, extra inputs,
  daily target/reminder). Picked extras apply via delete+recreate,
  safe only right after initial creation before the card has user
  data. (#81)

- **Threshold rules without bounds now act as a catch-all.** Previously
  a rule with no \`min\`, \`max\`, or \`eq\` was silently skipped, so
  the natural way to write "anything else" (a bare \`{emoji}\` as the
  last rule, matching the CSS / switch-default pattern) produced no
  marker. Agents and users both wrote this pattern unprompted; the BP
  card on klebbtest showed 🩺 on readings over 140 because the
  catch-all \`{emoji:"🔴"}\` was ignored. Now a bounds-less rule
  matches any non-null value at the field — put it last. Applies to
  both \`display.thresholds\` (Today headline colouring) and
  \`meta.calendar.marker.{type:"threshold"}\` (calendar glyph). The
  old workaround of \`{max:999, emoji:"..."}\` still works. Docs,
  Recipe 11c, the system prompt, and \`data.example/bp.example.json\`
  all updated to use the catch-all form. (#73)
- **"New chat" button clears immediately, no confirmation prompt.**
  The 📝 button in the chat widget used to pop a `confirm()` dialog
  whenever the transcript had any messages. The button label is clear
  enough on its own; the extra step was friction. (#72)

### Fixed

- **Chat panel scrolls to the latest turn when reopened.** Opening the
  panel with existing history used to leave the message list scrolled
  to the top, so the user always had to flick down to see what they'd
  just been talking about. Scroll-to-bottom now runs after the panel
  paints, and re-runs once async history load completes if the user
  managed to open the panel before the initial \`GET /api/chat/history\`
  landed. (#80)
- **Threshold calendar markers work again when written by the chat
  agent.** The \`DEFAULT_HEALTH_SYSTEM_PROMPT\` was telling agents to
  use \`"bands": [...]\` for threshold-marker rules; the renderer
  reads \`spec.rules\` (as the other docs all say). Agents wrote
  \`bands\`, the renderer found no \`rules\`, and fell back to the
  card's static emoji on every day with a reading. Prompt now matches
  the renderer and docs; the renderer also accepts the legacy
  \`bands\` alias so manifests written during the buggy window keep
  working. (#70)
- **generic-card tolerates a bare string \`display\` and the chat-agent
  prompt steers away from authoring one.** Klebbius (and any other
  agent using \`create_manifest\`) was writing
  \`"view": { "display": "{bpm} bpm" }\` where the renderer expected
  \`"display": { "template": "{bpm} bpm" }\`. The card rendered blank
  even when data was present, because the renderer read
  \`display.template\` on a string. The renderer now treats a string
  \`display\` as \`{template: <string>}\`; the system prompt also
  spells out that \`meta.view.display\` is an object, never a string,
  and lists the sub-keys (\`template\`, \`secondary\`, \`emptyHeadline\`,
  etc.) explicitly. (#67)
- **Cards with empty data no longer get auto-hidden from views.** The
  old rule "empty data hides the card" (to avoid ghost cards) made a
  fresh writeable card invisible to its owner before the first entry
  — e.g. a brand-new weight card, or anything just created via the
  chat agent's `create_manifest` tool. Visibility is now driven by
  the `enabled` flags only (master `meta.enabled` + per-view
  `enabled`). Renderers handle the empty state themselves
  (generic-card uses `meta.view.display.emptyHeadline` etc.). Users
  who want to hide a card still can, via Settings or by setting
  `meta.enabled: false` in the file. (#65)

### Added

- **Chat agent actually calls the manifest endpoints now.** #61 shipped
  `POST /api/manifests` + `DELETE /api/manifests/:id` and taught the
  system prompt about them, but the in-app agent (Klebbius) had no way
  to make an HTTP call from inside a chat turn — the chat proxy just
  forwarded `{model, messages}` to the gateway. This PR wires an
  OpenAI-compatible tool-calling agent loop into `/api/chat` so the
  model can call three new tools that dispatch directly into the
  registry (no HTTP hop to self): `create_manifest(manifest)`,
  `delete_manifest(id)`, and `list_manifests()`. The loop re-calls
  the gateway on `finish_reason: "tool_calls"`, appending the
  assistant turn + tool-result messages each iteration, capped at 5
  iterations so a misbehaving model can't spin forever. Tool errors
  (e.g. 409 duplicate id, 422 bad id) come back as the tool-result
  content so the model can self-correct in the same chat turn; only
  the final text reply reaches the widget. Tool rounds are not
  persisted to chat history. System prompt is updated to name the
  tools (the existing HTTP list stays as reference material for
  external agents with `AGENT_API_TOKEN`). Verified end-to-end
  against a live LiteLLM gateway. (#63)
- **Chat agent can now create and delete cards directly.** Two new
  endpoints land alongside the existing manifest surface:
  `POST /api/manifests` creates a brand new card from a full manifest
  body (201 on success, 409 on duplicate id, 400/422 on validation
  failure); `DELETE /api/manifests/:id` removes a card and unlinks its
  file. Auth matches the rest of `/api/` (session cookie or bearer
  token). The create endpoint is intentionally lenient: any JSON whose
  `$schema` is `klebb.datafile.v1` and whose `meta.id` + `meta.label`
  pass validation is accepted, so agents can ship cards with renderer
  names that don't exist yet (they render as an unknown-card placeholder
  and data persists). `DEFAULT_HEALTH_SYSTEM_PROMPT` is augmented with a
  full authoring guide: every built-in renderer, every input type,
  schedule shape, calendar marker type, `meta.reports` config, and two
  worked examples. New example manifests cover the three renderers that
  previously had no proof-by-example: `example-schedule-timeline`,
  `example-adherence-report`, `example-table-list`.
  `MANIFEST-SCHEMA.md`, `docs/CARDS.md`, and `docs/CHAT-AGENT.md`
  document `meta.reports` per renderer, `meta.category`, and the new
  endpoints. (#61)
- **Masonry layout on the Today view.** Cards with short content
  (Symptoms, Appointments) now pack upwards into gaps left by taller
  neighbours on multi-column viewports, rather than waiting for the
  tallest row-mate to finish before starting a new row. Reorder mode
  keeps the grid layout because SortableJS misbehaves in column
  layouts. (#59)
- **Calendar markers can now reflect the day's value, not just "had
  data".** `meta.calendar.marker` accepts either a string (static
  glyph, existing behaviour) or an object describing a per-day glyph.
  Four kinds ship: `type: "field-emoji"` picks a glyph from an
  `emojiMap` keyed by a field value on that day's row (mood 1..5 →
  😩😴😐🙂😄); `type: "trend-arrow"` compares the day's reading to
  the previous one and renders ⬆️/⬇️/➡️ (weight vs previous
  reading); `type: "threshold"` evaluates `min`/`max`/`eq` rules to
  pick a glyph per band (🟢/🟡/🟠/🔴 for BP); `type: "template"`
  reuses the `display.template` mini-language so the calendar can
  share the Today card's `emojiMap` without duplication. The
  resolver is type-discriminated so new kinds can ship without a
  schema bump. `mood.example.json` (template),
  `weight.example.json` (trend-arrow), and `bp.example.json`
  (threshold) demonstrate the range. See `docs/CARDS.md`
  (§ `meta.calendar`) and `docs/RECIPES.md` (Recipe 11). (#43)
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

- **Voice notes now work in the Docker image.** The runtime container
  was missing `ffmpeg`, which the server shells out to for transcoding
  browser audio (WebM/Opus/MP4) into the 16 kHz mono WAV that Fish ASR
  reliably accepts. Recording a voice note returned "audio transcode
  failed; spawn ffmpeg ENOENT". `ffmpeg` is now installed in the
  runtime stage. Bare-metal deploys were unaffected because ffmpeg
  already existed on the host. (#57)
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
  (Groq, Together), a local runtime (Ollama, vLLM), or
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
