# Changelog

All notable changes to Klebb are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and uses
the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added

- **Forensic logging on the chat agent loop.** Setting `HEALTH_DEBUG=1`
  now emits structured `[chat:<reqId>]` lines on `/api/chat` covering
  request entry, each agent-loop iteration with gateway latency, each
  tool dispatch with manifest id and duration, and the final outcome.
  Off by default; structural facts only (no prompt or reply bodies are
  logged). Closes the blind spot where a client-side timeout left the
  journal silent. Fixes #303.
- **Vocab support on schedule-timeline + adherence-report.** Both
  renderers now read an optional `vocab` block from their view config
  (`trends.vocab` and `reports.vocab` respectively) so a fixture can
  customise the labels used on the timeline, legend, and report
  summary. Existing fixtures keep their current "Taken / Missed /
  Off-schedule" wording via defaults. Fixes #296.
- **Weekday-anchored placeholder for demo fixtures.** `reset-demo.js`
  now resolves `__WEEKDAY:Mon:-N__` (and the other weekday names) to
  the named weekday N weeks from today. Use it on schedule fixtures
  whose doses must always land on the right day of the week, no
  matter what calendar day the demo is reset on. Refs #296.

### Changed

- **Demo dashboard polish.** Strength Training fixture now uses plain
  exercise names (Bench Press, Lat Pulldown, Romanian Deadlift, etc),
  carries an eight-week dose history with mostly-done /
  occasionally-skipped entries, and surfaces Trends + Reports with
  exercise-appropriate vocab ("Done / Skipped / Sessions done"). The
  Supplement stack fixture now ships a 60-day cycles + doses history
  so its Reports view renders adherence rather than nothing. Blood
  panel + Genome cards are hidden from Today (`view.enabled: false`)
  but stay in Reports. The demo banner no longer claims data is reset
  hourly. Refs #296.

- **Demo rings-layout Sleep card and Strength Training schedule
  card.** The `demo.klebb.app` Sleep fixture is now a self-referencing
  combination-card with `layout: rings`, surfacing Total / Deep / REM
  / Light as concentric progress arcs against per-stage daily goals.
  A new `demo/fixtures/strength-training.json` schedule-card fixture
  ships ten lifts across a Mon / Wed / Fri split (3 / 3 / 4) with
  weight, sets, reps and body part on each item. The schedule-card
  status chip now honours an optional `item.action_label` so the
  strength card chip reads "Lift" instead of "Inject"; the existing
  Inject / Spray default is unchanged. Fixes #292.
- **Inbox-driven report ingest pipeline.** Drop a `.pdf`, `.png`,
  `.jpg`, `.txt`, `.md`, `.mp3`, `.wav`, `.m4a`, `.ogg`, or `.opus`
  file into `$HEALTH_HOME/inbox/` and Klebb extracts text into
  `$HEALTH_HOME/reports/<YYYY-MM-DD>-<stem>.md` using infra binaries
  only (no LLM at ingest): `pdftotext` for PDFs, `tesseract` for
  images, raw `fs.readFile` for text/markdown, and the existing Fish
  ASR pipeline for audio. Originals are filed under
  `reports/_archive/`; extraction failures land in `inbox/_failed/`
  with a sibling `.error` file describing the cause. A new
  `read_report` chat tool plus the `## Available reports` system
  prompt block let Klebbius pull any ingested report into a turn on
  demand. Fixes #288.
- **`demo.klebb.app` now auto-deploys on every push to `main`.** A
  new `.github/workflows/deploy-demo.yml` workflow fires when the
  existing publish workflow finishes successfully, SSHes to the
  demo host, and runs `klebb-demo-deploy` (which does
  `docker compose pull && up -d` and re-seeds fixtures). The deploy
  key is locked on the host with a forced-command + `restrict` so
  the SSH session can only run that one script. See
  `docs/DEMO.md` for the full picture and key-rotation steps.
  Fixes #284.

### Fixed

- **PWA / apple-touch-icon home-screen artwork.** The five
  `public/icons/icon-*.png` tiles still showed the legacy "Eddz"
  wordmark and rocket image, so adding Klebb to the iOS home screen
  produced a bookmark with the old branding. They have been
  regenerated from `logo-dark.png` with the "Klebb" wordmark on the
  brand-dark `#0f0f1a` tile. A new `scripts/regen-pwa-icons.py` makes
  the generation reproducible from the source logo. Note: iOS caches
  apple-touch-icons per-bookmark, so existing home-screen shortcuts
  must be removed and re-added after deploy. Fixes #305.
- **Reports → Blood panel no longer shows `?` for every row.** The
  generic `table-list` renderer was hardcoded for the SNP finding
  shape (`gene` / `rsid` / `genotype`), so any card with a
  lab-result-shaped finding (`label` / `value` / `unit`) rendered the
  left column as `?` and dropped the unit on the right. The renderer
  now sniffs the finding shape per-row and uses `label` + `value
  unit` for lab data while keeping the existing SNP layout intact.
  The SNP-specific `APOE: ? · ?/? SNPs found` summary line is also
  hidden on cards that don't carry SNP metadata. Fixes #290.

- **Demo runbook now pins the reset/deploy `docker exec` calls to a
  named timezone.** `scripts/reset-demo.js` anchors fixture dates to
  the container's local calendar day; the image has no `TZ` baked in
  so without one set the container defaults to UTC, which causes the
  newest date to lag visitors in eastward timezones by up to a day.
  `docs/DEMO.md` §5, §6, §7, and the troubleshooting table now show
  `-e TZ=Australia/Sydney` alongside the existing env vars; fork
  operators should swap in their own zone. No code change. Fixes
  #286.

- **Schedule card week-dot ring now follows the day being viewed.**
  Previously the green halo stayed glued to real calendar today and
  vanished entirely once the user navigated more than ~7 days from
  today. The ring now tracks `this.date`, so stepping forward or
  back any number of days keeps the highlight on the correct
  letter. The internal CSS class is renamed `today-ring` →
  `selected-ring`. Fixes #282.

## [2.1.2] - 2026-05-21

### Changed

- **Health Auto Export token is now managed in the Settings UI.** The
  HAE panel offers a Generate button when none is configured, and a
  masked display + Copy + Regenerate when one is. Regenerate prompts
  an inline warning that the iPhone HAE app must be updated before
  the next push. Tokens are persisted to `$HEALTH_HOME/config.json`
  under `cfg.hae.token` (atomic write, `0o600`). The
  `HEALTH_AUTO_EXPORT_TOKEN` env var is deprecated: on first boot
  under the new code, an existing env value migrates into
  `config.json` once and is then ignored, so existing instances
  upgrade transparently. New endpoints under
  `/api/health-auto-export/token` (GET / POST / POST `/regenerate` /
  DELETE) all sit behind the global passkey auth gate. Fixes #278.

### Added

- **Demo Injections card now covers three concurrent protocols.**
  `peptide-cycle.json` is renamed to "Injections" and carries
  BPC-157 (M/W/F, peptide healing), Ozempic / semaglutide (weekly
  Sunday GLP-1), and basal insulin glargine (daily 18 units), each
  with its own schedule, cycle window, and dose history. The
  schedule-card and adherence-report both render the multi-protocol
  history side by side. Fixes #279.

- **Reports page on the public demo now ships with a full multi-card
  set.** Three new manifest fixtures (`blood-panel.json` with eight
  RCPA-style categories of fasting bloods, `genome-snps.json` with an
  APOE call plus 30 categorised SNPs across lipid metabolism /
  methylation / detox / caffeine / sleep / inflammation, and a
  reports-shaped extension of `peptide-cycle.json`) plus four narrative
  markdown reports under `demo/fixtures/reports/` (a blood debrief, a
  genome overview, a quarterly debrief, and a baseline profile). The
  reset script now seeds `$HEALTH_HOME/reports/` from the markdown
  fixtures and resolves `__OFFSET_DAYS:N__` placeholders in both file
  bodies and filenames (the underscore form is accepted in filenames
  since `:` is not a legal NTFS character). Fixes #275.

- **Demo fixtures + reset script now ship inside the Docker image.**
  The Dockerfile carries `/app/demo/` and `/app/scripts/reset-demo.js`,
  so the demo VPS reset cron can `docker exec klebb-demo node
  /app/scripts/reset-demo.js` directly: no more `docker cp` step
  after a `compose pull`. New `docs/DEMO.md` documents the public
  demo runbook end-to-end (compose, env, nginx vhost, hourly reset
  cron, image-tag prefix gotcha). The release runbook now
  explicitly calls out that the publish workflow strips the `v`
  prefix from git tags, so `v2.1.0` becomes Docker tag `2.1.0`.
  Fixes #274.

## [2.1.1] - 2026-05-21

### Added

- **`KLEBB_DEMO=1` runs the server as a public no-credentials demo.**
  Login swaps the passkey prompt for an "Enter the demo" button that
  mints a session for a shared `demo` user; all passkey/invite/setup
  routes return `410`; chat short-circuits with a canned reply (no
  outbound HTTP); voice endpoints return `503`; card hiding is locked
  in both the manifest PATCH and settings UI endpoints; the app shell
  shows a banner pointing visitors at `klebb.app` for self-hosting.
  Fixes #270.

- **Curated demo dataset and reset script.** `demo/fixtures/` ships
  eleven complete `klebb.datafile.v1` manifests (weight, sleep, mood,
  blood pressure, hydration, steps, daily notes, supplement stack,
  peptide cycle, active minutes, resting heart rate) populated with a
  fortnight of plausible-but-fake history so the public demo always
  shows trends, calendars, schedules, and threshold colour bands the
  moment a visitor lands. Date fields use `__OFFSET_DAYS:N__`
  placeholders that resolve to *today minus N* at reset time, so the
  dataset rolls forward without anyone editing JSON.
  `scripts/reset-demo.js` wipes `$HEALTH_HOME/data/` and restores the
  fixture set; it refuses to run unless `KLEBB_DEMO=1` so it can never
  be invoked against a real instance by accident. Hook it into a cron
  / systemd timer / docker-compose `restart` policy on the demo host.
  Fixes #271.

### Changed

- **App header now uses the Klebb dog mark instead of the placeholder
  emoji.** Two PNG variants live under `public/icons/`:
  `logo-light.png` (original dark blue, used in the light theme) and
  `logo-dark.png` (recoloured to the dark-mode accent so it sits
  cleanly on the dark background). Click-to-toggle-theme on the brand
  is preserved. Fixes #267.

## [2.1.0] - 2026-05-21

### Fixed

- **`read_doc` chat tool returned ENOENT in the Docker image.** The
  Dockerfile only copied runtime source dirs; the doc files the
  allowlist enumerates (`README.md`, `MANIFEST-SCHEMA.md`,
  `CHANGELOG.md`, `CONTRIBUTING*.md`, `SECURITY.md`, `docs/*.md`)
  were not present at `/app`, so every `read_doc` call from the
  agent in containerised deployments failed with "no such file or
  directory". Added explicit COPY directives plus a regression
  test that diff-checks the allowlist against the Dockerfile.
  Fixes #248.
- **Documentation accuracy sweep ahead of public flip.** Three
  doc-only inaccuracies caught by an audit:
  - `docs/CHAT-AGENT.md` referred to the bearer token as
    `$KLEBB_AGENT_TOKEN` in three example payloads; the env var is
    and has always been `AGENT_API_TOKEN`. An agent following the
    examples verbatim would have built unauthenticated requests.
  - `docs/HEALTH-AUTO-EXPORT.md` listed the workouts row shape as
    `{ date, trained, type? }`. Since #235 / #240 the merged row
    shape is `{ date, trained, type?, durationMin?, distanceKm?,
    calories?, avgHr?, maxHr?, elevationM?, startTime?,
    sessionCount }` with merge-per-date aggregation. The table
    entry now matches the catalogue.
  - `docs/CI.md` and `.github/workflows/test.yml` triggered on
    a long-dead `v2-redesign` branch. Removed.

### Added

- **Chat agent can read its own docs at inference time.** New
  `read_doc(path)` function-call tool surfaces every shipped doc
  (README, MANIFEST-SCHEMA, CHANGELOG, CONTRIBUTING\*, SECURITY,
  docs/CARDS, docs/RECIPES, docs/CHAT-AGENT, docs/HEALTH-AUTO-EXPORT,
  docs/DEPLOY, docs/TESTING, docs/VOICE, docs/CI) to the chat agent.
  Local disk only; the agent always sees the same version of the docs
  as the running app, so a deployed instance on an older release
  isn't misled by newer guidance on main. The system prompt now
  carries an `## Available docs` catalogue listing every callable
  path with a one-line summary; the agent picks one and calls
  `read_doc`. Allowlist-gated (no traversal, no symlink escape, no
  reading of gitignored operator files like CLAUDE.md or
  BRIEF-FOR-CC.md). See #246.

- **`workouts` rows expose `sessionCount`.** The
  `workouts-merge-per-date` aggregator now emits a `sessionCount`
  field (positive integer) on every merged daily row, equal to the
  number of distinct HAE workout entries for that date. This makes a
  `goalWeekly` ring with `accessor: "sessionCount"` actually count
  distinct sessions across the week (e.g. 2 walks + 1 run + 1 cycle =
  4) regardless of how long each session ran. Existing minimal
  `{date, trained, type}` rows continue to validate; an HAE re-push
  backfills `sessionCount`. Catalogue describe block tells the chat
  assistant about the field and recommends it for per-session weekly
  rings. See #240.

- **Weekly accumulation rings on `combination-card`.** Ring-segment
  entries now accept `goalWeekly` as an alternative to `goalDaily`. A
  weekly ring fills against the sum of the accessor across all rows in
  the Mon-Sun week containing the viewed date, so a "5 workouts/week"
  ring resets every Monday and shows historical totals when the
  scrubber is moved back. Daily and weekly rings can mix on the same
  card; the legend marks weekly entries with a `/wk` suffix. If both
  goals are set on one entry, `goalWeekly` wins. The chat assistant
  CC schema description and the embellish "missing goal" chip both
  recognise the new field. See #238.

- **HAE workouts ingest captures duration, distance, calories, HR,
  elevation, and start time.** The `workouts` catalogue entry used to
  emit only `{date, trained, type}`, throwing away every per-session
  number HAE provides. It now reads `duration`, `distance`,
  `activeEnergyBurned`, `avgHeartRate`/`maxHeartRate` (and the nested
  `heartRate.{avg,max}` alt shape), `elevationUp`, and `start`,
  normalising HAE's user-pref units (`kJ`→`kcal`, `mi`→`km`, `ft`→`m`)
  and dropping fields HAE didn't supply rather than emitting nulls.
  When several sessions land on the same date, a new
  `workouts-merge-per-date` aggregator rolls them up into one daily
  summary, matching Apple Health's own per-day view: additive fields
  (durationMin/distanceKm/calories/elevationM) sum, `type` becomes a
  comma-separated chronological dedup list, `avgHr` is duration-
  weighted, `maxHr` is the max, `startTime` is the earliest. Existing
  minimal `{date, trained, type}` rows continue to validate; an HAE
  re-push backfills enriched fields. The HAE describe block + agent
  system prompt now advertise the new fields and recommend a richer
  secondary template like `{durationMin} min · {distanceKm|} km ·
  {calories} cal`. See #235.

### Fixed

- **Agent guidance no longer suggests `fallbackToLatest: true` on
  workout-style cards.** Boolean-shaped HAE cards (workouts,
  meditation, exercise minutes) need to read as "No workout today"
  on a rest day — not show the most recent prior session as if it
  were today's. The HAE describe block + system prompt now flag
  workouts as the explicit exception and steer the agent toward
  `{trained:check} {type}` instead of bare `{trained}` so a workout
  day renders ✅ rather than the literal `true`. Live workouts
  manifests created against earlier guidance can be patched (or
  re-created) to drop `fallbackToLatest` and adopt the `:check`
  modifier. See #234.

### Added

- **Carry-over visual cue on `fallbackToLatest` cards.** When a
  `generic-card` with `meta.view.fallbackToLatest: true` displays a
  prior-day row on Today (because today has no entry yet), the
  headline now renders dimmed with a dotted underline, and a small
  `Nd ago` chip appears below any existing secondary line. Built-in
  and not opt-out: the whole point is to remove uncertainty about
  whether a value was logged today or carried over from a previous
  day. The chip clears as soon as a row for today is logged. Past-
  date navigation is unaffected (the fallback path is Today-only).
  See #231.

### Changed

- **`meta.view.dateContext` renamed to `meta.view.fallbackToLatest`
  (boolean).** The string-enum `dateContext: "latest" | "viewedDate" |
  "exact-date"` was a binary in disguise: only `"latest"` ever had
  observable behaviour (display fallback to the most recent prior row
  on Today with no row for today). The other values were no-ops left
  behind by an earlier migration. The canonical key is now a clear
  boolean `fallbackToLatest`, default `false`. The renderer reads
  `dateContext: "latest"` as `fallbackToLatest: true` for one release
  cycle so live manifests upgrade lazily. Run
  `node scripts/migrate-dateContext-to-fallbackToLatest.js` against
  your `$HEALTH_HOME/data/` to migrate live manifests; the script is
  idempotent and timestamped-backs-up each touched file. See #228.

### Added

- **`meta.prompt.mode: "checklist"` for schedule-card prompts.** Schedule
  cards (peptides, medications, supplement stacks) that opt into
  `meta.prompt.enabled: true` previously rendered the daily reminder as
  a free-text add-entry form (Item name / Scheduled date / Taken at):
  the wrong shape for "did you take it?" because the card already knows
  what's scheduled today. The new `mode: "checklist"` renders one row
  per item scheduled today, each with a single "Taken" button that
  stamps `{scheduledDate, takenAt}` into that item's `doses[]` (or
  `takenDates[]` for plain supplement-stack items). The modal updates
  in place and auto-closes once every scheduled item is marked.
  Eligibility is per-item: the prompt fires when at least one item is
  unmarked. The `medication-schedule`, `injection-protocol`, and
  `supplement-stack` templates default to checklist mode. Existing
  `mode: "modal"` (or absent) cards are unaffected.

### Fixed

- **Edit button on Today with no today-row now targets today, not
  the fallback day.** Cards with `dateContext: "latest"` correctly
  fall back to the most recent prior row for display when today has
  no entry. But clicking the edit button used to open the form
  pre-filled from that prior row — including its date — so saving
  rewrote the prior day's row instead of creating a new row for
  today. Operators hit this on mood after logging yesterday: editing
  "today" silently clobbered yesterday, and both views kept showing
  the same row. The edit path now looks up the row for the viewed
  date specifically; when no such row exists, the form opens in
  add-mode and the save stamps the viewed date. Display behaviour
  unchanged.

- **`{key:emoji}` template modifier accepts the flat `emojiMap`
  shape.** The calendar marker (#183) and rating input (#193 Part A)
  both honour both `emojiMap` shapes — flat (`{"1": "😩", ...}`) and
  keyed (`{field: {"1": "😩", ...}}`). The `:emoji` template
  modifier only accepted the keyed shape, so a mood card template
  like `{mood:emoji}` against a flat emojiMap fell through to the
  raw number. The modifier now tries the keyed lookup first, then
  the flat lookup — one source of truth across all three consumers
  of `display.emojiMap`.

### Changed

- **Chat starter chips are manifest-driven.** The previously-hardcoded
  chip list ("Supplements", "Injections", "Sleep", ...) often didn't
  match the user's actual cards. The empty chat widget now samples
  one prompt per enabled card from its `meta.chat.starterPrompts`
  array, falling back to a generated `Show me my <label> data` when
  the field is absent. Entries carry a `kind` (`"data"` or
  `"tweak"`) and the picker interleaves them so the chip set
  balances. The hardcoded "✨ Combine cards" meta-chip stays.
  (Fixes #195)

### Added

- **`writeable.prefillFromLatest` pre-fills the add form with the
  most recent prior entry.** Optional boolean on `meta.writeable`,
  default off. When true, opening the `➕` add form on a date with
  no existing row seeds the inputs from the most recent row dated
  strictly before that date. The `date` field is dropped from the
  pre-fill so the form still stamps the viewed date on submit. Weight
  gets the flag by default in the sandbox seed; operators can add it
  to any canonically slow-changing measurement (BP, body fat). Cards
  where yesterday's value isn't a sensible start (daily notes, mood,
  water counters) should leave it absent. (Fixes #217)

### Changed

- **"Dismiss all" on the HAE discovery card's unsupported-metrics
  footer.** A single button dismisses every undismissed unsupported
  metric in one click, avoiding the per-row tedium on instances
  with 15+ pending metrics. Button sits next to the expand chevron,
  visible without expanding the list. Per-row dismiss buttons
  removed to simplify — operators can un-hide from Settings if they
  want a specific metric back. Fan-out calls the existing
  per-metric dismiss endpoint in parallel, so no new server
  surface. (Fixes #218)

### Added

- **Mood card's daily prompt enabled by default.** The canonical
  mood template (`templates/mood.klebb.json`) now carries
  `prompt: { enabled: true, mode: "modal", whenMissing: true }` so
  the daily modal fires on first load when today has no entry. The
  modal's input form picks up `display.emojiMap` + `requireAny`
  from the card, so the combined experience from parts A/B/C is:
  five emoji buttons, an optional note textarea, Save enabled when
  either or both are filled. (Fixes #193 Part C; closes #193)

- **`writeable.requireAny` for either-or inputs.** A new optional
  array on `meta.writeable` lists input keys at least one of which
  must be filled for the Save button to enable. Mood uses it for
  `["mood", "note"]` so the user can log a feeling, a journal
  line, or both — without being blocked by a per-input
  `required: true`. Individual `required` flags still apply for
  fields that must always be present.
  (Fixes #193 Part B)

### Changed

- **Rating input consults `display.emojiMap` to render emoji buttons.**
  When a manifest's `view.display.emojiMap` is present, a
  `type: "rating"` input now labels its buttons with the mapped
  emojis (😩 😔 😐 🙂 😄) instead of raw numbers. The underlying
  saved value stays numeric — the emojis are label-only. Works
  with both the flat emojiMap shape (`{"1": "😩", ...}`, used by
  mood) and the keyed shape (`{mood: {"1": "😩", ...}}`, used by
  multi-field cards). Threads `display` through all four
  `eh-input-form` callers: generic-card, combination-card,
  list-card, prompt-modal. (Refs #193 Part A)

### Added

- **`{key:check}` display-template modifier for boolean fields.**
  Renders `✅` when the value is truthy, empty string when
  falsy/missing. Cleans up workouts-style cards whose data carries
  a boolean `trained` field that used to stringify to the literal
  `"true"` / `"false"` on the card headline. System prompt +
  `MANIFEST-SCHEMA.md` document the new modifier and nudge
  klebbius to drop `dateContext: "latest"` on "did it happen
  today" cards so non-workout days show the empty state instead of
  a stale trained day. (Fixes #215)

### Changed

- **Chat agent system prompt nudges toward `stepper` for count-like
  quick-log inputs.** The existing input-types catalogue lists both
  `number` and `stepper`, but offered no guidance on when to prefer
  which. The agent would default to `number` for count-like values
  like glasses of water, producing a bare spinner-arrow input that
  the operator had to focus and increment with hover-activated
  arrows. System-prompt guidance now splits the decision by intent:
  counting → `stepper`, measuring → `number`, with concrete
  examples. `MANIFEST-SCHEMA.md` gets a matching one-liner.
  (Fixes #189)

- **Settings card list is alphabetical and toggles in place.** The
  previous Enabled/Disabled split meant toggling a card reshuffled
  the list between groups and scrolled the viewport to the top —
  disorienting when flipping several cards in a row. Cards now sort
  alphabetically by label in one flat list, the toggle flips state
  in place via a keyed Lit `repeat`, and the toggle's post-refresh
  reload runs silently (no "Loading…" flash) so scroll position
  survives. (Fixes #194)

### Added

- **E2E regression coverage for combination-card layout switching.**
  A recovery-overview combination card in the default sandbox seed
  (with HRV + Resting HR donors and per-day data anchored to today),
  plus a spec that PATCHes its `layout` through rings and back to
  stack and asserts the stack still renders donor values on reload.
  Locks in the #190 behaviour; if a future change ever regresses the
  render-after-switch path, CI will catch it. (Refs #190)

### Fixed

- **Input forms and modals no longer overflow horizontally.** Form
  inputs (`<input>`, `<textarea>`, `<select>`) were `width: 100%`
  without `box-sizing: border-box`, so any padding pushed the
  computed width past the parent. That caused the inline edit form
  and the prompt-modal panel to overflow their container by a few
  pixels and render a rogue horizontal scrollbar at the bottom.
  Inputs now use `box-sizing: border-box` and the modal panel has
  an explicit `overflow-x: hidden` as a belt-and-braces guard
  against oversized platform-native controls (date/time pickers,
  number spinners). (Fixes #188)

- **Chat embellishment chips persist across page reload and chat
  reopen.** The CC-embellishment chip row attached to a chat reply
  (switch layout, colour-code rings, add goals, etc.) used to vanish
  after a reload. Server-side the `PUT /api/chat/history` filter kept
  only `{id, role, content}`; client-side `_flushHistory()` sent only
  those fields anyway. Both ends now round-trip the `embellishments`
  array and `followupText` string when an assistant message carries
  them. Shape is shallow-validated server-side: label + prompt must
  be strings, or the entry is dropped. (Fixes #191)

- **Discovery card renders a footer-only surface when only unsupported
  metrics remain.** Once every catalogue-supported HAE metric has a
  subscriber (the steady state on a configured instance), the
  discovery card previously suppressed itself whole and took the
  "received but not supported" footer with it — stranding any
  pending dismiss actions. The card now renders a compact
  footer-only layout in that case (no headline, no intro, no
  category list), keeping the dismiss UI reachable from Today.
  (Fixes #192)

- **Schedule cards render when the manifest uses the agent-authored
  nested-cycle shape.** Klebbius-written peptide manifests put the
  cycles array at `item.cycle.cycles[]` (nested under a top-level
  `cycle` metadata object) rather than at the flat `item.cycles[]`
  the renderer canonically reads. Previously `effectiveCycles()`
  ignored the nested shape and returned `null`, so every item was
  filtered out of the schedule card and the card body rendered
  empty. The resolver now surfaces both shapes; explicit top-level
  `item.cycles[]` still wins. (Fixes #186)

- **Manifest loader now skips timestamped backup files.** Migration and
  re-ingest scripts drop backup files beside the canonical manifest
  (`foo.json.pre-reingest-*.json`, `.pre-hae-*`, etc.). Previously the
  loader globbed every `*.json` in the data dir, parsed the backups
  as manifests, and either (a) emitted duplicate-id warnings when the
  canonical sibling loaded too, or (b) — worse — silently created a
  card from the backup if no canonical existed, serving stale data
  to the operator. The scan now recognises the shared backup shape
  (two `.json` segments in the filename) and skips it outright.
  Makes the reingest workflow introduced with #184 safe to repeat.
  (Fixes #197)

- **Calendar `field-emoji` markers now inherit the card's
  `display.emojiMap`.** Previously the resolver required `emojiMap`
  on the marker spec itself, so manifests following the existing
  pattern of declaring the map once under `meta.view.display.emojiMap`
  saw no per-day emoji on the calendar — every date fell back to the
  card's `meta.emoji` (the same face on every day). The resolver now
  consults `ctx.display.emojiMap` when the spec omits one. Spec-level
  overrides still win when both are present. (Fixes #183)

- **HAE ingest no longer persists IEEE754 floating-point tails.** Apple
  Health passes numeric values through averaging pipelines that can
  produce round-trip values like `62.00000000000001` or
  `84.99999999999999`. The ingest catalogue now rounds every numeric
  field at the `row()` level to a sensible per-metric precision
  (integer for heart rates, step counts, exercise minutes, systolic/
  diastolic BP; 1dp for HRV, walking HR, SpO2, body mass, body fat
  percent; 3dp for sleep-stage hours). Existing on-disk values can be
  cleaned with `node scripts/reingest-hae.js` from the raw archive.
  (Fixes #184)

- **Cards with `dateContext: "latest"` now honour past-date navigation.**
  The `latest` resolver in `eh-generic-card._currentEntry()` used to
  return the most recent row regardless of which date the user had
  navigated to, so every past date on cards like Blood Pressure,
  Mood, Weight, HRV, Resting HR, Walking HR, Exercise Time, Steps,
  Daily Notes, and Sleep Analysis/Quality displayed (and, via the
  pencil, edited) today's numbers. `"latest"` is now treated as a
  Today-mode fallback: past/future navigation does exact-date
  lookup. Verified: editing a past-date mood now writes to that
  row, not today's. (Fixes #182; closes #181 as a duplicate)

- **Chat agent no longer hallucinates the combination-card manifest
  schema.** Observed in live QA: asked to build a Sleep CC, the agent
  wrote `view.sources[]` keyed on `id`; asked to build a Lifestyle
  CC, it wrote `view.slots[]` keyed on `cardId`. Neither shape is
  accepted by the CC renderer (which reads `view.combines[]` with
  `sourceId`), so both cards rendered empty with "no source info".
  Same failure mode as #164 (HAE field hallucination) — fixed by
  injecting the CC schema contract into the chat system prompt,
  including an explicit FORBIDDEN list naming the two observed
  hallucinations (`view.slots`, `view.sources`) so the agent learns
  what to avoid as well as what to use. (Fixes #179)

### Changed

- **Testing discipline documented across the contributor surface.**
  `docs/TESTING.md` gains a "PR expectations" section with the
  bug-fix workflow (fail-on-main first, then fix, then show pass)
  and a clear list of "no test needed" vs "nice try" justifications.
  `CONTRIBUTING.md` points at the three-layer rubric and repeats
  the commands every contributor needs. The PR template adds a
  layer-picker checklist so reviewers can confirm coverage at a
  glance. (Fixes #200)

### Added

- **`tests/api/` regression layer.** New directory under `tests/` for
  per-bug API-level regression tests, using the existing sandbox
  harness. Seeds three tests against the M1/M3 QA findings: one
  passing today (documents the mood-write server contract for
  #181), two `describe.skip`-d until their respective fixes land
  (HAE FP rounding #184, loader backup-file guard #197). The skip
  markers are the signal for which fix PR un-skips which test.
  `npm test` now globs `tests/api/*.test.js` alongside the existing
  `tests/*.test.js`. (Fixes #199)

- **Playwright end-to-end test harness.** New `tests-e2e/` directory
  and `npm run test:e2e` script drive a headless Chromium against an
  ephemeral sandbox (same harness `tests/helpers/sandbox.js` uses),
  injecting a valid session via the existing `fakeAuthState` helper
  so specs land directly on the authenticated app. Separate
  `e2e.yml` GitHub Actions workflow runs the suite on every PR and
  archives traces, screenshots, and the HTML report on failure. New
  `docs/TESTING.md` documents the three-layer rubric: unit → API
  integration → E2E. Headed runs (`npm run test:e2e:headed`) get a
  400ms slow-mo and an in-page banner showing the current test
  title for comfortable watch-along debugging. (Fixes #198)

- **CC-specific embellishment chips after create/edit.** When the chat
  agent creates or edits a `component: "combination-card"` manifest,
  the reply carries clickable chips offering the embellishments that
  are the actual point of CCs: switch layout (stack ↔ rings), promote
  a donor to primary, add daily goals to ring segments, colour-code
  ring segments. Chip filtering is fully field-gated so users don't
  see "Add a goal" when every ring segment has one. The CC-suggestion
  card's "Ask klebbius" prompt and the blank-chat "Combine cards"
  starter chip both nudge the agent to propose embellishments after
  writing the manifest, so the chip flow has something to act on.
  (Fixes #177)

- **Combination-card suggestion surface.** Two new discovery paths for
  CCs, both routing to the existing "describe it to klebbius" flow.
  (a) A pinned suggestion card on Today fires whenever 3+ enabled
  atomic cards share a `meta.category` value, naming the specific
  cards and offering an "Ask klebbius" action that seeds a tailored
  prompt. Cards already combined in an existing CC are excluded;
  dismissal is cluster-scoped (adding a 4th card re-fires as a new
  suggestion). (b) A distinctively-styled "Combine cards" starter
  button in the blank-chat prompt row seeds a generic "help me build
  a combination card" prompt, visible to every user regardless of
  whether the cluster heuristic fires. New endpoints
  `GET /api/cc-suggestions` and `POST /api/cc-suggestions/:category/dismiss`.
  Dismissals persisted at `$HEALTH_HOME/data/_meta/cc-suggestions-dismissed.json`.
  (Fixes #174)

- **`meta.category` field on manifests.** Optional, constrained to a
  canonical enum (`sleep`, `recovery`, `activity`, `vitals`, `body`,
  `mindfulness`, `lifestyle`, `supplements`, `medication`). Unknown
  values are silently dropped at load time so the chat agent can't
  fragment the clustering signal by inventing values. HAE-backed
  cards auto-populate the category from their catalogue entry if the
  author didn't set one. Chat system prompt constrains the agent to
  the enum when writing new manifests. Foundational work for the
  upcoming combination-card suggestion surface; no UI change in this
  release. (Fixes #172)

### Fixed

- **Discovery card now sits below the main card grid and suppresses
  itself when there are no catalogue-supported metrics to surface.**
  Previously it pinned above the welcome card on fresh installs
  (wrong priority for new users) and rendered an empty accent-
  bordered card whenever every supported metric already had a
  subscriber (with only the unsupported-metrics footer as content).
  Welcome card now renders above; discovery stays inline at the end
  of Today when there's something actionable in it. (Fixes #170)

- **HAE replay no longer double-counts overlapping pushes.** Surfaced
  by live QA with 10+ scheduled HAE exports: each push re-sends
  running-total samples for the current day, and the replay was
  flattening entries across all pushes into a single list and
  aggregating once — producing 5× step counts, wrong means for HRV,
  and wrong "last wins" for sleep. Replay now processes each push
  independently (aggregate → mergeByDate against running state),
  matching the live dispatcher's semantics. A new `force: true` opt
  on `replayFromArchive` bypasses the "skip if data non-empty" guard
  for operator re-runs. `scripts/reingest-hae.js` walks every
  HAE-backed manifest, backs it up, and force-replays to fix
  historical over-summed data. Chat system prompt also gains explicit
  guidance for the agent to use `{field:round(N)}` and
  `view.dateContext: "latest"` on HAE cards so newly-built cards
  don't render as "No data yet" or "7.28333..." out of the box.
  (Fixes #168)

### Changed

- **HAE discovery card filters to catalogue-supported metrics and groups
  by category.** Previously the card listed every metric HAE pushed
  that no manifest subscribed to — on a real iPhone export that was
  ~20 rows, most of them (`vo2_max`, `heart_rate`, `respiratory_rate`,
  `flights_climbed`, etc.) not in klebb's catalogue at all, so clicking
  "Build a card" would produce a manifest the dispatcher silently
  logged as "unknown metric" on every subsequent push. Now supported
  metrics group into six categories (Sleep, Recovery, Activity,
  Vitals, Body, Mindfulness) with a per-category "Dismiss all". A
  collapsible footer shows the unsupported metrics with a link to
  open an issue for catalogue additions. Each catalogue entry gains a
  `category` string; `describeCatalogue()` surfaces it in the chat
  system prompt; `GET /api/health-auto-export/discoveries` now returns
  `{ undismissed: { supported: {[category]: [...]}, unsupported: [...] }, dismissed }`. (Fixes #166)

### Fixed

- **New HAE-backed manifests backfill from the raw archive.** Before
  this fix, a card created after an HAE push arrived stayed empty
  until the next push, because the dispatcher only routed to
  subscribers present at push time. The discovery card's "Build a
  card" flow hit this every time, leaving users staring at an empty
  card. `createManifest` now replays `$HEALTH_HOME/data/auto-export/raw/*.json`
  against any new HAE-backed manifest with empty `data[]`, producing
  aggregated rows just as if the pushes had arrived after the card
  existed. Idempotent: skipped when `data[]` is non-empty. Also
  graduates the metric out of `discovered.json` so the discovery
  card drops the row on its next refresh. The discovery card now
  listens for `manifest-data-changed` and `klebb-cards-changed` so
  it re-fetches without a page reload. (Fixes #160)

- **Chat agent now writes HAE manifests using catalogue field names.**
  Previously the agent would reach for field names it remembered from
  HAE's raw payload schema (`asleep`, `deep`, `rmssd`) when building a
  subscriber manifest, and klebb's catalogue would emit different
  fields (`hours`, `ms`), leaving the card face rendering empty. The
  chat system prompt now carries a runtime-generated summary of every
  catalogue metric's row shape, reconstructed from `catalogue.js` via
  a probe-based introspection so it stays correct as the catalogue
  evolves. Carries an explicit rule: "only reference fields from the
  catalogue row shape; do not invent fields." (Fixes #164)

### Changed

- **`sleep_analysis` catalogue entry preserves stage breakdown.** Each
  sleep row now carries whichever of `asleep`, `inBed`, `deep`, `rem`,
  `core`, `awake` hours HAE provided for that night, alongside the
  existing `hours` + `source`. Fields are omitted when absent rather
  than zeroed, so display templates can distinguish "no REM data" from
  "0 REM hours". The shipped `sleep-hours` template now shows deep +
  REM as a secondary line under the total hours. Backward compatible:
  any template reading just `{hours}` keeps working. (Fixes #162)

### Added

- **Health Auto Export panel in Settings.** The Settings view now
  leads with a panel showing the webhook's endpoint URL (with a copy
  button), token-configured status, a link to the setup guide, and a
  last-push summary ("X rows across Y cards, N minutes ago") that
  expands into a full diagnostic detail: receive time, payload size,
  per-subscriber rows written + notes, metrics present but
  unsubscribed, and any warnings. The panel reads from
  `GET /api/health-auto-export/status`; the webhook URL is derived
  from the request host so the panel always shows the URL the iPhone
  app should be posting to. (Fixes #153)

- **Apple Health discovery card.** When the HAE webhook receives
  metrics nothing on your dashboard subscribes to yet, a pinned info
  card appears at the top of the Today view listing each newly-seen
  metric with two actions: "Build a card" (seeds a templated prompt
  into the chat widget for klebbius to create the manifest) and
  "Dismiss" (permanently hides that metric until you un-hide it from
  Settings). Dismissed metrics are listed in a new "Hidden Apple
  Health metrics" section of Settings with an un-hide button.
  Discoveries are persisted in
  `$HEALTH_HOME/data/auto-export/discovered.json`. The card
  self-hides when no undismissed discoveries remain, and entries
  are removed automatically when a subscriber card is added.
  New endpoints: `GET /api/health-auto-export/discoveries`,
  `POST /api/health-auto-export/discoveries/:metric/dismiss`,
  `POST /api/health-auto-export/discoveries/:metric/unhide`.
  (Fixes #151)

- **HAE ingest diagnostics + status endpoint.** Every webhook push now
  writes a snapshot to `$HEALTH_HOME/data/auto-export/last-push.json`
  describing what happened: receive time, payload bytes, per-subscriber
  rows-written counts, metrics present in the payload but unsubscribed,
  and any warnings. A new authenticated endpoint
  `GET /api/health-auto-export/status` returns that snapshot alongside
  `{ tokenSet, endpointUrl }` (URL derived from the request host so it
  reflects the actual deployment, including `X-Forwarded-Proto` for
  HTTPS behind a reverse proxy). The 100 MB body cap on the webhook is
  now explicit and emits a `413` + diagnostic on overflow, so a
  multi-year manual-backfill push either lands cleanly or fails loudly.
  (Fixes #152)

- **Health Auto Export ingest now runs off a catalogue and per-manifest
  subscription.** Manifests opt into receiving HAE data by declaring
  `meta.ingest: { source: "hae", metric: "<name>" }`. The dispatcher
  walks the registry on every push and routes payload slices to
  whichever manifests subscribe, using row shapes + aggregation rules
  defined in `health-auto-export/catalogue.js`. Day-one catalogue
  covers 13 metrics (sleep, steps, exercise minutes, workouts, HRV,
  resting HR, walking HR avg, SpO₂, mindful minutes, body mass, body
  fat, systolic BP, diastolic BP). Users can now author any number of
  HAE-backed cards without a code change; the response body also
  reports `availableUnsubscribed` metrics so the UI can surface
  "discovered" data in a future change. (Fixes #150)

### Changed

- **HAE webhook no longer auto-seeds manifests.** Previously, a first
  push would materialise `sleep-hours`, `steps`, `active-minutes`, and
  `workouts` manifests from hardcoded templates if they did not already
  exist. Now the dispatcher is strictly subscribe-by-manifest: a push
  with no subscribers writes nothing (the raw payload is still
  archived). The four previously-autoseeded manifests ship as
  `templates/*.klebb.json` and can be created from the Templates
  gallery as normal. Existing installs are patched in place by
  `scripts/migrate-hae-ingest.js`, which adds `meta.ingest` to the
  four manifests and takes a timestamped backup. (Refs #150)

- **Embellishment chips after chat creates/edits a card.** When the chat
  agent successfully creates or patches a manifest, the chat response now
  carries a small follow-up row of one-click suggestions tailored to the
  card's renderer (add an emoji, show on the calendar, add a target
  range, include in Trends, track adherence in Reports, and so on). The
  picker in `chat/embellish.js` is pure, renderer-aware, and only
  surfaces embellishments whose target field is currently absent.
  Clicking a chip sends a canned prompt back through the agent and
  disables the chip row so the same offer can't be applied twice.
  (Fixes #142)

### Changed

- **Starter prompts now clear chat history before loading.** Picking a
  starter prompt from the welcome card or prompts gallery is an
  explicit "new workflow" entry point, so the paste-into-chat handler
  now calls `_clearHistory()` before pasting. Prior turns no longer
  bleed context into what was meant to be a fresh conversation.
  (Fixes #148)

### Fixed

- **Chat proxy RST test no longer flakes on Windows.** The test
  simulates an upstream gateway that RSTs its TCP socket immediately
  after flushing a successful response. On Linux the response bytes
  have already been buffered by Node's HTTP parser before the RST
  arrives, so the client still gets the reply; on Windows the RST
  purges the kernel receive buffer before any bytes surface, losing
  the response. The production path is unaffected (Linux CI has
  always passed); the test is now gated on non-Windows platforms so
  local dev on Windows stops hitting a false-positive failure.
  (Fixes #146)

- **Chat agent no longer hallucinates weekdays for relative dates.**
  Asked "what's on 5 days from now?" on a Wednesday, the agent would
  compute the ISO date correctly (+5) but then confidently name the
  wrong weekday ("Friday" for a Monday). Language models are
  unreliable at weekday arithmetic from an ISO date, so the system
  prompt now carries a pre-computed offset/weekday/ISO lookup table
  spanning -14..+60 days in the server's TZ, and instructs the agent
  not to compute weekdays itself. (Fixes #143)

- **`schedule-card` renders items that only declare their cycle on the
  schedule object.** The renderer's visibility filter required every
  item to carry an explicit `cycles[]` array; agent-authored manifests
  carry the cycle on `schedule.start_date` + `schedule.cycle_weeks`
  (or `cycle_days`) instead, so every item got filtered out and the
  card appeared empty. `public/js/lib/schedule.js` now synthesises a
  single cycle from the schedule's start date + duration when an
  explicit `cycles[]` is absent; explicit cycles still win. Unit tests
  cover both shapes, open-ended (no duration), and the legacy
  `schedule.startDate` alias. (Fixes #138)

- **Left/right arrow keys work inside the chat textarea again.** The
  date-view's window-level arrow handler was calling
  \`preventDefault()\` on every ArrowLeft/ArrowRight, with a guard
  that only skipped if \`e.target.tagName\` was an input. For events
  fired inside a shadow root (like the chat widget's textarea),
  \`e.target\` retargets to the shadow host, so the guard missed and
  the caret never moved. Guard now walks \`e.composedPath()\` via
  a shared \`isEditableTarget\` helper in
  \`public/js/lib/event-target.js\`. (Fixes #136)

- **Chat agent no longer builds empty schedule-cards.** The agent was
  writing items into \`meta.schedule[]\` (not a real field on the
  \`schedule-card\` shape) and leaving \`data\` empty, so the card
  rendered blank. The system prompt now carries a full
  schedule-card example with items in \`data.items[]\`, spells out
  which renderer reads which path, and forbids silently setting
  optional embellishments (\`meta.prompt\`, \`meta.calendar\`,
  \`meta.trends\`, \`meta.reports\`, thresholds) on initial create.
  The server also injects today's absolute date into the system
  prompt so the agent stops hallucinating 2025 dates; the
  \`create_manifest\` tool description reinforces both rules.
  (Fixes #130)

### Changed

- **Onboarding is LLM-first.** Removed the Add Card modal and its
  template-substitution lib; the welcome card now surfaces three
  paths in order of usefulness: starter prompts (primary, with a
  "Start here" chip), describing it in the chat (secondary), and
  hand-authoring JSON (tertiary, points at \`docs/CARDS.md\` and
  \`templates/\`). The Add Card modal was producing shell cards
  that needed a follow-up chat turn to be useful, which made it a
  weaker parallel to the chat agent rather than a complement.
  README and \`docs/DEPLOY.md\` now document Klebb as LLM-first and
  make setting up a chat gateway part of the Quickstart rather
  than an optional step. \`templates/\`, \`/api/templates\`, and
  \`CONTRIBUTING-TEMPLATES.md\` all stay — they're useful as
  canonical reference manifests for contributors and as future
  chat-agent fodder. (#127)

### Added

- **Starter prompts gallery.** The welcome card's third action now
  opens a modal listing prompts from \`/api/prompts\`, with the
  \`new-to-klebb\` meta-prompt featured at the top. Clicking "Load
  into chat" pastes the prompt body into the chat input (without
  sending) and opens the chat widget; the user reviews, edits, then
  sends themselves. If the chat gateway isn't configured, the
  primary action becomes "Copy to clipboard" and a banner explains
  how to enable the gateway. Each row has a Preview toggle to show
  the full prompt body inline before sending. New \`GET
  /api/chat/status\` endpoint exposes a boolean \`configured\` flag
  the gallery uses to pick its action mode; the chat widget gains a
  \`klebb-paste-into-chat\` window-event listener so the gallery can
  drive it. (#118)

- **Add Card modal.** Click the welcome card's "Add a card" action
  to open a modal with three panes: a searchable template gallery
  grouped by category (Tracking, Protocols, Lifestyle, Imported), a
  live card preview using the real renderer component, and a form
  with one input per placeholder in the selected template. Typing in
  a field updates the preview immediately; fields are typed (number,
  date, boolean, string) based on the placeholder declaration. On
  submit, placeholders are substituted client-side and the manifest
  is POSTed to \`/api/manifests\`. If the id collides, the client
  auto-suffixes (\`weight\`, \`weight-2\`, …) until it lands. Does
  not require an LLM gateway: the deterministic path to creating any
  card. New module \`public/js/lib/template-substitute.js\` holds
  the pure substitution logic (tested standalone); new component
  \`public/js/components/eh-add-card-modal.js\` holds the modal.
  Welcome card's primary action now creates actual cards instead of
  showing "coming soon". A \`klebb-cards-changed\` window event is
  dispatched on success so the view renderer refreshes without a
  page reload. (#117)

- **\`GET /api/templates\` and \`GET /api/prompts\` endpoints.** Plain
  JSON read-only endpoints that surface the contents of \`templates/\`
  and \`prompts/\` for the Add Card modal and prompts gallery to
  consume. Both session-gated (inherit the app-wide auth), both set
  \`Cache-Control: no-store\`, both read the directories at request
  time so contributor additions are picked up without a restart.
  Malformed files are logged and skipped; the response stays 200 and
  carries the rest. (#116)

- **\`templates/\` + \`prompts/\` directories.** Ten starter card
  templates and seven conversational prompts covering the main Klebb
  use cases (weight, BP, waist, resting HR, injection protocol,
  supplement stack, medication schedule, mood, daily notes, hydration,
  sleep-hours via HAE; plus prompts for GLP-1 cycles, peptide cycles,
  supplement stacks, post-op recovery, strength training, mood-sleep
  basics, and the \`new-to-klebb.md\` conversational onboarding meta-
  prompt). Templates use a typed placeholder syntax
  (\`{{type:name}}\`, types: string, number, boolean, date, enum) and
  carry a \`meta.template\` block describing gallery rendering.
  Prompts ship as markdown with YAML frontmatter (title, summary,
  tags). Two new test suites walk both directories and validate shape.
  Contribution guides land at repo root:
  \`CONTRIBUTING-TEMPLATES.md\` and \`CONTRIBUTING-PROMPTS.md\`. None
  of this is wired into the UI yet; the Add Card gallery, prompts
  gallery, and \`/api/templates\` + \`/api/prompts\` endpoints land in
  follow-up PRs. (#115)

- **Welcome card + first-boot onboarding.** Fresh installs (empty
  \`HEALTH_HOME/data\`) now auto-create a single \`welcome.klebb.json\`
  that explains the three ways to add cards: Add Card gallery (landing
  in a follow-up PR), the chat agent, and starter prompts (also
  follow-up). The welcome card is a regular manifest: hideable,
  deletable, re-enablable from Settings. It hides itself the first time
  any other card is created (tracked via \`meta.welcome.autoHideApplied\`
  so the auto-hide fires at most once — a user who later re-enables it
  in Settings won't have the system fight them on the next Add Card).
  New renderer \`eh-welcome-card\` backs the \`welcome-card\` component
  name; new module \`server/first-boot/\` holds the seed logic and the
  canonical fixture. (#114)

### Removed

- **Demo cards, demo reports, and first-boot seed machinery.** Deleted
  \`data.example/\`, \`data.demo/\`, \`scripts/seed.js\`,
  \`scripts/seed-demo.js\`, and \`scripts/lib/demo-cards.js\` along with
  the \`seed\` / \`seed:demo\` package scripts, the \`runFirstBootDemoSeed\`
  call in \`server.js\`, the \`KLEBB_SKIP_DEMO_SEED\` env var, and the
  \`.klebb-seeded\` sentinel. Fresh installs now start with an empty
  dashboard; onboarding lands in a follow-up PR (welcome card +
  templates + prompts gallery). Existing installs are unaffected: their
  \`data/\` directories already hold real manifests and the old seed
  logic silently skipped non-empty data dirs. Tests
  \`tests/seed-demo.test.js\` and \`tests/example-manifests.test.js\`
  removed; the latter's role will be taken over by a successor that
  walks \`templates/\`. README Quickstart updated to point users at the
  inline JSON example. (#113)

### Changed

- **Save-failure banners now show the server's reason string.** When a
  writeable renderer (generic-card, list-card, settings toggles, prompt
  modal) hit a non-2xx response from \`/api/manifests/:id/data\`, the UI
  rendered either \`HTTP 403\` or a fixed "Could not save. Try again or
  dismiss." — hiding the server's actual \`{error: "..."}\` payload. A
  container running in UTC while the browser is in Australia/Sydney
  would reject today's writes as "future-dated (2026-05-05) not allowed
  for this card", but the operator saw only the generic message. New
  \`public/js/lib/save-error.js\` helper (\`errorFromResponse\`) reads
  the server's JSON \`error\` field and surfaces it as
  \`"403: future-dated entry ... not allowed"\`, pointing straight at
  the \`TZ\` config. Covered by a small unit test. (#106)

### Added

- **Expand/collapse toggle for the chat panel.** A new header button
  (\`⤡\` / \`⤢\`) flips between the default 380px-wide panel and an
  expanded variant (\`min(720px, 100vw - 40px)\` wide, up to 900px
  tall on desktop). The preference lives in \`localStorage\` so it
  sticks across sessions. On viewports ≤480px the width is already
  pinned full-bleed, so expanding on mobile grows the message list
  vertically only, clamped to \`100vh - 56px - safe-area\`; nothing
  can overflow the screen. Toggling also re-pins the scroll to the
  latest turn so the visible viewport doesn't suddenly show old
  content after a resize. (#82)
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
- **Chat agent ships every writeable card with a full \`inputs\`
  array.** Klebbius was creating writeable list-cards with the
  \`writeable\` booleans set but no \`inputs\`. Result: Edit mode on a
  list-card row showed only the primary-field text box — the
  per-row three-dot button for secondary fields never appeared
  because there were no secondaries to render. Prompt now demands
  that every manifest with \`meta.writeable.fromWebapp:true\` carry
  a non-empty \`meta.writeable.inputs\` array covering every field
  the description mentions, and for list-card also set
  \`meta.view.display.primaryField\`. A new worked example (full
  appointments manifest) is in the prompt. (#90)

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
- **Chat text input keeps focus after a reply lands.** The input is
  disabled while a request is in flight, so the browser drops focus
  and the user had to click the box again to type the next message.
  Focus is now returned to \`.chat-input\` after \`_sendText\` settles
  (success or error path), unless the panel was closed in the
  meantime or the mic is recording. Skipped on mobile (<=480px) so
  iOS Safari doesn't pop the keyboard back up uninvited. (#84)
- **Chat agent confirms card deletion exactly once: never zero,
  never twice.** Deletion used to take three turns of
  confirm-and-confirm-again. An earlier fix over-corrected: the
  agent started running \`delete_manifest\` with no warning at all.
  The system prompt now mandates exactly one confirmation, regardless
  of how emphatic the first request was, and the confirmation
  message must warn that the data is gone permanently and offer
  \`hide_card\` as the non-destructive alternative. Any affirmative
  reply on the next turn calls \`delete_manifest\` immediately.
  (#88)
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
