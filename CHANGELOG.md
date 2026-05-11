# Changelog

All notable changes to Klebb are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and uses
the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Fixed

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
