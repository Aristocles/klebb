# Changelog

All notable changes to Klebb are documented here.

This project adheres to [Semantic Versioning](https://semver.org/) and uses
the [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Fixed

- **Import validation no longer reads the history file whole.** The first
  real-sized restore into a memory-capped instance was OOM-killed inside
  `POST /api/import/start`: the samples drain had streamed since the
  incident fix, but validation still read and `JSON.parse`d the entire
  `samples.json` for its plan counts (twice per job, plus a whole-file
  read for the inventory checksum). Validation now streams the scan
  through the same incremental reader as the drain, header values arrive
  through a capped capture hook, and inventory checksums hash in chunks,
  so peak memory is one push regardless of history size. The apply
  pipeline's write freeze also engages before its first await (it used to
  rely on everything before the wipe being synchronous), so nothing can
  write into the target after apply-time validation has started.

### Added

- **Activity signal on the control-plane admin API.** `GET /api/admin/info`
  now carries `lastActiveAt` and `activeDays7`: when a person last interacted
  with the instance and on how many of the trailing seven days they did at
  all. Interaction is deliberately narrow: session-authenticated shell loads
  and non-GET API calls, so agent tooling, the admin API itself, ingest
  pushes and polled GETs (an open tab) never count. Tracked in a small
  sidecar under `data/_meta/`, flushed at most once a minute and on
  shutdown.

- **`GET /api/admin/info`: a meta-only operational snapshot on the
  control-plane API.** A hosting dashboard could ask whether an instance was
  up (`/api/admin/health`) but nothing about what it was running: version,
  build commit, card and card-error counts, datastore size, last ingest push
  time and size, uptime. All of it is about the instance, never from it (no
  card ids, no metric names, no data rows), behind the same admin bearer as
  the rest of the surface. The publish workflow now stamps the source
  revision into the image (`SOURCE_COMMIT`) so `commit` is answerable;
  local builds serve `null`.

- **Search across every chat, from the conversation drawer.** The drawer lists
  up to 100 conversations and their titles are usually model-generated, so
  finding the chat where you said something meant scrolling and guessing. The
  drawer head now carries a search toggle: it turns the head's label into a
  field that filters the list as you type, matching **message text as well as
  titles**, and a row whose hit was in the transcript shows the line that
  matched. `POST /api/conversations/search` is new; the needle travels in the
  body rather than a query string because it is health-related chat text and
  reverse-proxy access logs record URLs, not bodies. The store scans every row
  instead of maintaining an index, which the 100-conversation cap keeps cheap,
  and it matches with an escaped-literal regexp so a term containing `.` or `*`
  searches for those characters. Escape in the field clears the term before it
  closes the field, and only then the drawer. (#659)

### Changed

- **The hamburger stays put when the drawer opens, and folds it back in.** The
  drawer is positioned over the whole panel, so opening it hid the control that
  opened it, leaving a scrim tap or Escape as the only ways back: neither is
  discoverable. Its head now carries a hamburger of its own, with padding and
  button metrics mirroring the panel header's (phone breakpoint included) so it
  lands on the same pixels at the same 44px size and reads as the same icon
  staying still. Cancelling a rename with Escape no longer closes the whole
  drawer along with the edit. (#659)

- **New chat is a chat-panel header control, and the conversation drawer
  scrolls instead of expanding.** Starting a fresh chat cost two taps because
  the button lived pinned at the top of the drawer, which nothing else about a
  new chat needs: it is now a header pill immediately right of the hamburger,
  and the drawer no longer carries one. The drawer also listed only five
  conversations behind a "Show all (N)" expander, which the store already makes
  pointless: it hard-caps at 100 and prunes the least recently active whenever
  a conversation is created, so the whole list is bounded and now renders in
  the scroller the list already was. The drawer keeps a header strip carrying a
  "Conversations" label, because that strip is what holds the safe-area top
  inset off a phone's status bar. (#657)

### Fixed

- **A refused zip write no longer leaves the partial archive on disk.** The
  writer opens its destination before it validates the first entry, and
  `stream.destroy()` does not cancel an open that is still in flight: node
  defers the teardown until the descriptor exists. The cleanup removed the
  file without waiting for that, so a refusal raised before the open landed
  (an unsafe entry name, the entry-count limit) deleted nothing and the late
  open then created the very archive the caller was told did not exist. It
  waits for the descriptor to close first. The race went either way roughly a
  third of the time, so `tests/zip.test.js` now drives the refusal forty
  times over and lets a single stray file fail the run, rather than asserting
  once and passing on luck; a companion test covers a failure raised after
  bytes are written, where there is an open descriptor to close instead of a
  pending open. (#652)
- **An import's wipe now clears directories under `data/`, so no state from
  the previous instance survives a replace.** The wipe enumerated only files
  at the top of `data/`, which left the whole of `data/auto-export/` behind:
  the Apple Health ingest inbox, the discovered-metrics list, the last-push
  diagnostic and any quarantined payloads, plus `data/_archive/` when an old
  migration had parked the previous owner's original card files there. The
  ingest inbox mattered most, because the apply drains it after the copy
  regardless of what the archive carries: importing an archive with no
  history onto an instance that had a `samples.json` sitting in its inbox
  slot imported the OLD instance's push history into the restored tree, and
  verification then failed the whole import with `VERIFY_PUSHES_MISMATCH`.
  Rollback is unaffected: the snapshot is a full export of the instance, so
  it restores those directories with everything else. (#645)
- **Applying an import no longer holds one HTTP request open for the whole
  pipeline.** Hosted instances sit behind reverse proxies with response-time
  ceilings around a minute or two, so a long apply always surfaced a gateway
  error in the wizard while the import carried on server-side and usually
  succeeded; a crash mid-apply turned the held request into a bare 502 with
  the eventual recovery invisible. `POST /api/import/apply` and `/rollback`
  now answer **202 immediately** with the applying snapshot and the pipeline
  runs detached; the wizard polls `GET /api/import/status` and renders live
  stage labels ("Clearing this instance", "Importing history", ...), and a
  page opened mid-import lands in the same progress view from status alone.
  Boot crash-recovery resumes are detached the same way, so a multi-minute
  resume no longer starves `/healthz` or blocks boot. State still moves to
  `applying` and the write freeze still engages before the request answers,
  so concurrent applies refuse exactly as before. The freeze gate is also
  **widened**: while a pipeline runs, every `/api/*` route (reads included)
  answers 503 `IMPORT_FROZEN` except `/api/import/*` and the health probe,
  because mid-pipeline the registry is transiently wiped and serving a read
  would present an empty instance as truth. (#633)
- **Importing a large HAE history no longer blows the heap of a small
  container.** A real restore whose `data/auto-export/samples.json`
  weighed tens of MB died of `FatalProcessOutOfMemory` inside a 256 MB
  container: the samples drain read and JSON.parse'd the whole file, then
  bound large strings per sample, and boot recovery re-crashed on every
  restart until one pass squeaked under the ceiling. The drain now streams
  the file one push at a time through a minimal JSON-aware scanner (string
  and escape state, bracket depth; no new dependencies), so peak memory is
  proportional to one push, never the file; a subprocess test drains a
  synthetic 60 MB history under a 48 MB heap that provably kills the old
  approach. Imports stay one transaction per push with the same
  rename-aside semantics, and the drain yields to the event loop between
  batches, so `/healthz` now answers during a long boot drain instead of
  the whole boot blocking; every other route waits for boot to settle,
  exactly as before. The import pipeline is async end to end (wizard
  apply/rollback/resume, boot recovery, the offline CLI), with freeze
  engage/release and watcher stop/resume still guaranteed across the new
  await points. (#632)
- **Multi-step chat requests no longer die at a hardcoded 5-iteration
  cap.** The agent loop's round-trip cap is now `CHAT_MAX_TURNS`
  (default 12), and a new total-turn deadline (`CHAT_TURN_DEADLINE_MS`,
  default 240s) stops a raised cap stacking per-step timeouts into a
  multi-minute silent spinner. Capped turns keep any progress text the
  model produced, explain how to resume ("keep going"), and carry
  `capped: true` for the client. The per-step timeout also stops
  claiming the request "doesn't fit any of the tools" when the truth
  was a slow step. (#600)
- **Voice replies show one play control, and it actually toggles.** The
  shared audio element rendered its native controls bar inside the bubble
  next to the custom play button: two play arrows for one clip, and the
  custom glyph never changed while playing. The element is now a hidden
  playback engine; each voice bubble gets a single play/pause control
  whose glyph tracks state, a seekable progress strip while playing, and
  the playback-speed cycler relocated from the header. (#599, #606)
- **The chat panel is now a true full-screen sheet on phones.** The old
  panel sized itself with `100vh` (the large viewport), pushing its
  header up under the iPhone status bar where taps belong to the OS, and
  its header controls were ~24px pills: close/new-chat were effectively
  untappable and the only way out was a page refresh. The sheet now uses
  `100dvh` with safe-area padding top and bottom, every header control
  is a 44px target, swipe-down on the header closes it (Escape and the
  close button still work), the page behind is scroll-locked (including
  pull-to-refresh), and the on-screen keyboard lifts the composer via
  visualViewport instead of covering it. Desktop keeps the windowed
  panel. (#598, #604)

### Added

- **An import can restore part of an archive instead of all of it.**
  `lib/import/selection.js` turns a validated plan into a selectable
  inventory (every card with its label, row count and Apple Health
  provenance; every report paired with the archived original it was
  ingested from; the push history as a single item) and the apply takes a
  `selection` naming what to restore. This is **filtered replace, not
  merge**: the wipe stays unconditional and total, so an unticked card is
  deleted along with everything else rather than protected, and what was
  ticked is what comes back. Ticking an ingested report brings its
  archived original with it; leaving history out means the sample inbox
  is never copied in, so there is nothing to drain. Files the plan never
  listed (the provenance manifest, `config.json`, unsupported or legacy
  card files) always ride along: they are the shape of an instance rather
  than artefacts anyone could tick, and dropping them would lose bytes no
  selection ever refused.
  A selection is normalised twice. Once synchronously when the apply is
  confirmed, so an unusable one is refused before a single byte is
  destroyed (`SELECTION_INVALID` naming the offending id or path,
  `SELECTION_EMPTY` when nothing at all would be restored, which would
  otherwise report an emptied instance as a successful import). Then
  again inside the pipeline against the tree as it stands at apply time,
  so an archive that drifted in between fails loudly instead of quietly
  importing a different set, and a hand-edited job file cannot widen what
  a confirmation authorised. A retry re-uses the selection recorded on
  the job and ignores a wider one supplied later, boot crash-recovery
  resumes with that same selection, and rollback always restores the
  pre-import snapshot whole, because a snapshot is what the instance was
  and not a set of choices. Verification is plan-driven, so the verified
  counts and the copy predicate both derive from the one filtered plan
  and cannot disagree about what should be there. An absent selection
  means everything, which is what the offline CLI, hosted restores and
  every existing caller keep doing. (#646)
- **The import CLI and the import API now expose that selection.**
  `npm run import` takes `--cards <ids>`, `--reports <tree paths>` and
  `--no-history`; any of them present narrows the restore, and a family no
  flag names is restored whole, so `--no-history` alone means everything
  else. A family can be emptied deliberately (`--reports ''`), which the
  selection tells apart from absent. The dry run resolves the selection
  against the archive and prints the filtered plan with each narrowed line
  reading `2 of 12`, so a subset can be read before it is applied, and
  `--dry-run` is accepted explicitly (it contradicts `--apply`, which is a
  usage error rather than a silent preference). A selection the archive
  cannot satisfy is refused at both doors: the dry run prints the offending
  reference and exits 1 without touching the target, and `--apply` refuses
  before the wipe.
  Over HTTP, `POST /api/import/apply` passes an optional `selection` through
  and answers **400** with the named findings when it cannot be satisfied.
  That is deliberately not a 428 or a 409: the confirmation ceremony is
  untouched and the nonce is **not** spent, so the job stays
  awaiting-confirm and a corrected apply goes straight through instead of
  forcing the whole upload again. `GET /api/import/status` gained the
  selectable inventory (`items`) and a count of what the target holds today
  (`target`), the two inputs a confirmation needs to say honestly that all of
  it is being deleted whatever comes back. Both ride **only** the
  awaiting-confirm status: the apply polls run every 1.5 seconds and would
  otherwise carry an entry per card for nothing, and once the apply is
  confirmed the selection is settled. (#647)
- **The import preview picks what comes back, with checkboxes.**
  Settings > Data lists the archive's cards (label, row count, and an Apple
  Health badge on the ones fed by ingest), its reports (name, size, and
  "+ original" where the archive also carries the file the report was read
  from) and its Apple Health history as three groups with per-group all and
  none, everything ticked on arrival: the default action is still the whole
  archive, and a fully ticked preview sends no selection at all, so an
  unnarrowed import stays byte for byte the wholesale copy it has always
  been. A line above Apply keeps count of what a narrowed one restores.
  Ticking a card Apple Health feeds pins the history on and locks its
  checkbox with the reason, because such a card holds no rows of its own and
  would restore empty without them; unticking the card releases the pin, so
  history stays a real choice. Apply sends card **ids** and report tree
  paths taken from the inventory verbatim, never the labels shown, and a
  selection that would restore nothing disarms Apply with the reason rather
  than earning a refusal from the server. The confirm panel now also states
  what the instance holds today ("currently holds 12 cards, 3 reports and
  340 HAE pushes: all of it is deleted, including anything left unticked"),
  because with a partial selection the destruction is no longer implied by
  the archive's own counts, and an unticked artefact is deleted with
  everything else rather than protected. A refused selection lands back on
  the preview with the choices and the confirmation intact. (#648)
- **Chat gateway token and cache counters are now recorded.** Both
  gateway paths threw the response's `usage` block away: the buffered
  path parsed it and dropped it, and the streaming assembler rebuilt a
  synthetic response that never carried it. Each agent-loop step now
  logs prompt, completion, cached and cache-write token counts (plus
  upstream cost where the gateway reports one), so the cost of a chat
  turn is measurable instead of inferred. Streaming needed
  `stream_options.include_usage` to return the block at all, and the
  counters arrive on a trailing chunk whose `choices` array is empty,
  which the assembler previously skipped. Reader normalises the two
  field layouts the supported gateways use, since one reports cache
  counters only under `prompt_tokens_details` and reading just the
  top-level names reports a confident zero. `usage=none` stays distinct
  from a row of zeroes: a gateway reporting nothing and one reporting a
  genuine zero hit rate are different faults. (#636)
- **Bug reports and feature requests, from inside the chat.** The
  unmet-capability tool grew into `note_feedback(kind, intent)`: telling
  Klebbius "report a bug: the chart went blank" or "I wish it could…"
  now logs an anonymised, paraphrased entry (never your data) and the
  assistant confirms what it recorded. A "Send feedback" form lives in
  the drawer footer for those who prefer typing it directly, and the new
  `GET /api/admin/feedback` endpoint (admin bearer, `?since` cursor)
  makes the log collectable, so feedback stops being a write-only file.
  (#608)
- **A conversation drawer.** The chat header gains a history button that
  slides in the conversation list: new chat pinned on top, then your
  conversations newest-first with their model-generated titles and
  last-activity times (five shown, the rest behind show-all; the store
  keeps at most 100). Tap to switch (the transcript loads from the
  server, and a turn still running in the conversation you left keeps
  going and is waiting when you come back), rename inline, delete behind
  a two-tap confirm. "New chat" parks the current conversation in the
  drawer instead of erasing it, and reopening the app restores the
  conversation you were in. (#607)
- **The chat shows what it is doing, streams its answers, and can be
  stopped.** Turns now ride the event stream: the model's text appears
  as it generates, a live status line names the tool being worked
  ("Creating a card (sleep)…"), and the send button becomes a stop
  button that genuinely halts the server-side loop (the user's message
  stays, no reply is invented, the next send goes straight through).
  Capped turns offer a "keep going" chip that survives reloads. The
  transcript now lives in a server-side conversation: it follows the
  user across devices, survives the phone backgrounding mid-turn (the
  answer is waiting on return), and a pre-existing history file is
  folded into a conversation the first time the new client loads.
  (#605, with #601/#602/#603 underneath)
- **Export download and import over HTTP** (`routes/data.js`).
  `GET /api/export` stages a portable export, zips it with the vendored
  writer and streams it as an attachment (`<instance>-export-<stamp>.zip`),
  one at a time (a concurrent request answers 409), staging removed when
  the response ends. The import wizard gains its HTTP surface under
  `/api/import/`: `upload` (raw zip streamed through a dot-prefixed part
  file, mid-stream byte cap from `KLEBB_IMPORT_MAX_TREE_MB`, a free-space
  check demanding three times the cap), `start` (extracts through the
  hardened zip reader with the env caps, hostile archives 422 with the
  reader's code), `scan-tree` (operator door for a tree extracted by hand
  into `$HEALTH_HOME/import/tree`), `status`, `apply` (the populated-target
  confirmation nonce enforced with 428), `rollback` and `abort`. Mutating
  routes are origin-checked; demo mode 403s the whole surface. While the
  pipeline holds the write freeze, a single structural gate at the top of
  dispatch 503s everything that is not a plain GET (plus `GET /api/export`,
  which would zip a mid-wipe tree), exempting `/healthz` and
  `/api/import/*`. Boot now runs import crash recovery before first-boot
  seeding and the samples drain; when neither the staged tree nor the
  snapshot survives, the instance refuses to serve (503
  `IMPORT_RECOVERY_FAILED` on every API route except import status and
  rollback) rather than seed over a half-applied home. (Fixes #617)
- **Settings > Data: export download and an import wizard.** A new Data
  tab in Settings. Export is one button: the browser downloads a zip of
  the whole instance (every card with its history, reports and settings).
  Import restores such an archive through a wizard: pick the zip, watch a
  real upload progress bar, review the plan (card, HAE push and report
  counts, warnings, and the honest exclusions line: passkeys, connected
  devices and chat history stay with the instance; data timestamps reset
  to the import time), then apply. A fresh instance applies with one
  click; a populated one shows a red warning and requires typing REPLACE,
  with the apply carried by the single-delivery confirmation nonce. The
  result reports the verified counts with a reload button; a failed
  import lists its findings with roll back and start over. Refusals are
  surfaced honestly per status (too large with the limit, out of disk,
  archive refused with the validator's code, already running, writes
  frozen). The status snapshot now carries the plan counts for the
  preview. Demo mode shows a not-available note. (Fixes #618)
- **A speak-replies toggle decides reply modality.** A speaker button
  beside the mic: on means every reply (typed or spoken) comes back
  voice-shaped and autoplays, off means text only. Off by default; the
  first mic use flips it on once (a voice-first user clearly wants
  speak-back), after which it is manual and persists per device. Spoken
  replies also keep their play affordance across reloads (`hasVoice`
  rides the history), re-synthesising audio on demand. The old one-shot
  voice arming for pasted starter prompts is superseded by the toggle.
  (#606)
- **Chat turns survive the client.** A conversation turn now runs as a
  server-side job: a phone that backgrounds mid-turn (iOS aborts the
  fetch) no longer kills the reply, which is persisted to the
  conversation regardless. Events are buffered per turn with ids and
  `GET /api/chat/turn/:conversationId` reattaches, replaying what was
  missed from `Last-Event-ID` before going live (204 = nothing running,
  read the conversation). One turn at a time per conversation: a
  concurrent send answers 409 before its message is persisted. (#602)
- **Chat conversations are now first-class.** A `conversations` table in
  the per-instance database (own handle, WAL-checkpointed on shutdown)
  stores named transcripts behind `/api/conversations` CRUD: list by
  recency, create, fetch, rename, replace messages, delete. Hard caps: 100
  conversations with the least-recently-active pruned, 200 messages each,
  512KB per write. Messages keep the legacy history sanitisation rules
  plus a `hasVoice` flag so spoken replies keep their player across
  reloads. `POST /api/chat` accepts a `conversationId`: the server then
  owns the transcript (the client sends only the new turn), persists the
  user message before the loop and the reply after it (connected or not),
  forwards a ~24k-character window instead of the whole history (per-turn
  cost stops growing with conversation length), and titles an untitled
  conversation with an async model side-call after the first exchange.
  The legacy `/api/chat/history` endpoint is unchanged until the client
  cutover. (#603)
- **Chat turns can stream.** `POST /api/chat` with `stream: true` answers
  with server-sent events: `status` (loop phase and live tool activity),
  `token` (assistant text fragments), `reset` (retract provisional text
  that preceded tool calls), then a `reply` event carrying exactly the
  payload the buffered mode returns, and `done`. Failures become an
  `error` event with the same classified copy and would-have-been status
  as the buffered path. The gateway leg streams too, with the per-step
  timeout acting as an idle timeout. The buffered response is unchanged
  and remains the default. (#601)
- **Vendored stdlib zip reader and writer** (`lib/zip/read.js`,
  `lib/zip/write.js`) to carry the import upload and export download with
  zero new dependencies. The reader is central-directory-driven and refuses
  hostile archives outright with stable error codes: encrypted entries,
  zip64 in any form, compression methods other than store/deflate, symlink
  attributes, and unsafe names (dot-dot, absolute, backslash, drive letter,
  control characters), plus caller-set caps on entry count and declared
  bytes; extraction inflates asynchronously, aborts the moment output
  exceeds the declared size, verifies CRC-32, and stages via a temp
  directory so a refused archive leaves nothing behind. The writer emits
  store-or-deflate archives with sizes and CRCs in the local headers (no
  data descriptors, so stock extractors accept them) and refuses past the
  classic 4GB/65535-entry limits rather than emitting zip64. (#614)
- **Wipe, quiesce and in-process export primitives for the upcoming in-app
  import.** The card datastore (`store.wipeAll()`) and the HAE sample store
  (`samples.wipeAll()`) can now drop everything in one in-place transaction.
  Never a file unlink: a live server keeps writing to a deleted inode. The
  sample wipe also resets the push sequence so a reimported history numbers
  its pushes from 1 and replays in the original order. The manifest registry
  gains `stopWatch()`/`resumeWatch()`; stopping also cancels a debounced
  reload already queued by an fs event from just before the stop, which
  would otherwise fire mid-wipe. The portable export lifts into an
  in-process `exportTo(targetDir, opts)` that throws instead of exiting and
  leaves the shared HAE samples handle open (inside a live server it belongs
  to the ingest path); the CLI is a thin wrapper with identical behaviour.
  (Fixes #615)
- **A wipe-first import job engine with boot-time crash recovery**
  (`lib/import/wizard.js`, `lib/import/freeze.js`, `lib/import/recover.js`),
  the library layer for the upcoming in-app import. One job at a time,
  persisted to `$HEALTH_HOME/import/job.json` at every transition. A
  populated target is not refused: the job parks awaiting confirmation
  behind a crypto-random nonce that `status()` hands out exactly once. The
  apply pipeline snapshots the current state via the portable export
  (populated targets only, pruned to the newest), engages a process-wide
  write freeze, quiesces the manifest watcher, wipes everything (registered
  cards through `deleteManifest` so delete hooks fire, leftover card files,
  orphaned rows, the HAE sample history, backup/tmp strays, reports),
  copies the tree in, drains the sample inbox, imports each card through
  the boot importer, reloads the live registry so the imported set serves
  without a restart, verifies against the pristine tree (per-card
  deep-equal from durable state, push counts, report hashes; an HAE-backed
  card that grew replayed data is not a mismatch), and sweeps exactly the
  backup paths it created. Any retry re-runs the full wipe first, so a
  failed attempt can never stack rows or double HAE pushes. `rollback()`
  re-runs the same pipeline from the snapshot. At boot, `recoverAtBoot()`
  runs before first-boot seeding and the samples drain: a job caught
  mid-apply resumes from the staged tree, falls back to the snapshot, or
  refuses to serve rather than let a half-applied home be seeded over and
  presented as truth. Proven with subprocess SIGKILLs at each pipeline
  stage, each kill verified to have landed mid-apply. (Fixes #616)

- **A portable export can now be imported back with one command.**
  `npm run import -- <tree> [--apply] [--target <home>]` restores an
  extracted export tree into a fresh instance. Dry-run is the default: the
  tree is validated end to end (manifest and format version, per-card shape
  and datastore round trip, checksums against `klebb-export.json`, size and
  row caps, hostile-content refusals for symlinks and legacy credential
  file names) and checked against the target, which must be fresh (nothing
  beyond the seeded welcome card) and, with `--apply`, not held by a running
  server. Every finding prints with a severity and a code, alongside the
  apply plan. `--apply` then deletes the seeded welcome card, imports every
  card through the same inbox a boot uses, drains the HAE sample history so
  a later boot cannot double-import it, copies reports and config (an
  existing config always wins), and verifies the result: each card's stored
  value deep-equals the tree's, push counts match, report bytes are
  identical. The `.pre-import` backups the import creates are removed only
  after full verification; on any failure they stay, and the next boot
  converges by re-importing whatever still carries a `data` key.
  (Fixes #593, #594)

- **Every portable export now carries a provenance manifest.**
  `scripts/export-embed.js` writes `klebb-export.json` into the tree root
  after every other file, so a tree without one is a torn (or pre-manifest)
  export and readers refuse it. The manifest inventories the whole tree:
  per card the data state (`embedded` / `inline` / `null` / `none`) and a
  row count taken from the datastore's own shape decomposition, the HAE
  push count when sample history was exported, report byte sizes, and the
  SHA-256 of every written file. `klebb-export.json` is now a reserved name
  inside `data/`: a restored-then-re-exported tree would otherwise nest its
  stale manifest as data, so the export skips such files with a warning.
  The tree contract lives in `docs/EXPORT-FORMAT.md`. (Fixes #592)

- **The export-then-import round trip is pinned at the HTTP level.** A
  regression suite seeds a live instance through its own API (cards
  including a recorded null, an HAE ingest push, an uploaded report),
  exports it, imports the tree into a fresh home, boots a second instance,
  and deep-equals everything the API serves, guarded so an empty-vs-empty
  comparison can never pass. Hostile trees (a credentials file inside
  `data/`, a duplicate card id, a missing manifest) refuse at the CLI
  without touching the target, and the state a crash between copy and
  import leaves converges at the next boot without double-importing HAE
  history. The README and `docs/RECIPES.md` gain a restore recipe, and
  `docs/CI.md` now states the actual Node matrix (22 + 24, engines floor
  22.13). (Fixes #595)

### Fixed

- **Subscribing a card to a metric the HAE catalogue does not know is now an
  error instead of a silence.** `meta.ingest` was never validated: a misspelt
  metric passed create, the card counted as a subscriber that could never
  receive a row, every push logged a warning against it, and, because the
  metric appeared to have a subscriber, it graduated off the discovery
  surface, so nothing anywhere said the card was dead. Create and PATCH now
  refuse an unknown metric with `422` (`invalid ingest: ...`), and a manifest
  file already on disk loads with the subscription dropped, so the card still
  renders and the metric resumes appearing as a discovery. (Fixes #589)

- **An unknown aggregation strategy now throws instead of silently behaving
  like last-per-date.** A catalogue entry naming a strategy that `aggregate()`
  did not recognise fell through to keep-the-last-row-per-date, so a typo there
  turned a summed metric into quietly wrong data (the day's final sample
  stored as the day's total). The throw is contained per subscriber,
  mirroring the malformed-entry handling: the push notes `aggregation failed`
  against that subscriber and later subscribers still ingest. A test pins
  every catalogue entry to a known strategy, so shipped code cannot reach the
  throw. (Fixes #589)

- **Sum-per-date metrics no longer round each sample before the total.**
  `apple_exercise_time` and `mindful_minutes` rounded every payload entry to
  whole minutes inside the catalogue, and the `sum-per-date` aggregate then
  rounds the total, so every sub-minute granule was quantised before it was
  added. Measured: a day of 47 samples of 0.4 min (18.8 min in truth) stored 0
  instead of 19, and 47 samples of 0.75 min (35.25 in truth) stored 47 instead
  of 35. The catalogue now returns unrounded minutes and only the total is
  rounded. (Fixes #587)

- **`body_mass` now reads the payload's declared units instead of assuming
  kilograms.** HAE puts `units` on the metric wrapper, not on each sample, and
  the catalogue never looked at it, so a 176.4 lb weight was stored as
  `kg: 176.4`. `lb`/`lbs` and `st`/`stone` now convert on ingest (both 176.4 lb
  and 12.6 st store as 80.0 kg), and the conversion applies on live ingest and
  on replay/backfill alike, so the two paths agree. (Fixes #587)

- **Sleep rows now carry `bedTime` and `wakeTime`.** HAE sends the night's
  timestamps (`sleepStart`/`sleepEnd`, `inBedStart`/`inBedEnd`) and every one
  of them was discarded: only the calendar date and the durations survived.
  The new fields are the phone's own local wall-clock `HH:MM`, taken verbatim
  from the stamp text rather than reinterpreted through the server's timezone.
  Additive: existing rows are untouched, and either key is omitted when its
  source stamps are absent. (Fixes #587)

- **Opening the datastore while another process is writing now waits instead of
  failing.** SQLite's default busy timeout is 0, so a second opener that found
  the write lock held threw `SQLITE_BUSY` immediately, and the statement that
  collides is the very first one of a fresh open (switching a database into WAL
  takes the write lock). Measured across two processes with one holding a write
  for 600 ms: previously the opener failed after 24 ms, now it waits 141 ms and
  succeeds. This showed up as an intermittent CI failure in the export test, but
  the export is *designed* to run against a live instance (that is how a Cloud
  export reads a running container), so the same collision made a customer's
  export fail. (Fixes #580)

### Changed

- **A test file that dies now says why.** When a test file's process is killed,
  `node:test` loses every result it had not yet flushed (a file wrapped in one
  top-level `describe` reports nothing at all), and the default reporter discards
  the child's exit code, so the entire output is a bare `'test failed'`. That is
  indistinguishable from "the change you just made is broken", and it has sent
  people hunting a regression that was not there more than once.

  `npm run test:diag` runs the suite through a reporter that prints the exit code
  in hex, the signal, the stderr tail, and a one-line diagnosis, so a failure can
  be classified at a glance: an ordinary assertion, a lost port race, an
  out-of-memory abort, or a native process kill. Caught in the act on this repo:
  three files in one run had exit code `0xC0000409`, the Windows `__fastfail`
  path, with empty stderr, and all of them passed when re-run.

  Also: `--test-concurrency` is now pinned to 6 rather than defaulting to the core
  count, which reduces the process churn those kills correlate with (measured
  cost: 203s versus 196s); `npm run test:retry` re-runs only natively killed
  files, gated hard on the exit code so a genuine failure can never be retried
  into green; and `tests/helpers/sandbox.js` gains a `waitFor(check)` helper,
  because a fixed `setTimeout` while waiting for an event is a guess about
  machine speed and the source of a whole class of these.

### Fixed

- Two defects in the test harness, both of which made an unrelated problem look
  like the reported one. `spawnServer` had no `'error'` listener, so a spawn that
  never started became an unhandled event and surfaced as a 30-second timeout
  with a stack pointing at the harness instead of at the real cause. And `kill()`
  left its SIGKILL escalation timer pending after a prompt exit, holding a
  ref'd handle for a further two seconds per suite across dozens of them.

### Changed

- The chevron that opens a card's full trend chart now sits beside the
  sparkline instead of in the header. It used to render between the edit
  pencil and the settings gear, where nothing connected it to the trend line
  it opens, and where it partly sat under the edit button. It is a proper
  keyboard-reachable button; tapping the card header still expands too, so
  no existing gesture changed.

### Fixed

- **Recording an HAE push no longer costs memory per sample, so a small payload
  cannot exhaust a small container.** `recordPush` built an array of every
  sample and then a hash-keyed Map, both alive at once alongside the request body
  and the parsed object. The cost was per sample rather than per byte, so the
  100 MB body cap did not bound it: on a 256 MB heap a 6.57 MB body of a million
  bare numbers died, while a 6.20 MB body holding one large sample was fine, and
  on a 128 MB heap 2.56 MB was enough. The push path now streams (`flatten` is a
  generator) and intra-push duplicates collapse in the `ON CONFLICT` clause
  instead of in a Map. Every case that previously died now survives, including
  two million samples on a 128 MB heap. A crash here mattered more than a lost
  push, because the phone retries: a container would restart-loop. (Fixes #574)

- **Replay no longer gets quadratically slower as history grows.**
  `replayMetric` merged into the accumulated result once per push group, and that
  merge rebuilds a Map of the whole result and re-sorts the whole array every
  call. The cost was always O(groups x dates); reading 412 MB of archive files
  used to dominate it, so moving history into the samples table exposed the
  asymptote rather than creating it. Measured on synthetic histories: 2.5 months
  16 ms, five years 1084 ms, all of it inside `POST /api/manifests` on a
  single-threaded server. One accumulator for the whole replay makes it flat, and
  the output is byte-identical (the equivalence suite compares against the
  previous algorithm for every aggregation strategy). (Fixes #575)

- **The test suite no longer drops a random file on a full run.** Two unrelated
  timing faults, both of which produced a file that aborted while every subtest
  in it reported as passing, and both of which reproduced on an untouched tree so
  they read as a regression in whatever changed last. First, the sandbox harness
  picks a port in the parent and closes the probe before the child binds it, so
  two files could be handed the same port (reproduced: 24 concurrent processes
  probing, closing, waiting 300 ms and binding were handed a duplicate); the
  window cannot be closed without teaching the server about the harness, so it
  now retries the draw several times instead of once, and only on `EADDRINUSE`.
  Second, three tests slept a fixed duration waiting for an event (a child
  exiting, `fs.watch` noticing a file) and now poll for it via a new `waitFor`
  helper, which is both reliable and faster. (Fixes #576)

## [3.5.0] - 2026-08-10

### Changed

- **Stale-card nudges are now opt-in per card via `meta.cadence`.** A card is
  only ever reported as stale if it declares how often it expects an entry:

  ```json
  "meta": { "cadence": { "expectDays": 7 } }
  ```

  Absent `meta.cadence`, a card is never flagged however long it sits quiet.
  This is a behaviour change: cards that used to be nudged after 21 days of
  silence are now silent until they opt in.

  Staleness used to apply to everything with a 21-day default guess, and each
  time it embarrassed itself an exclusion was added: hidden cards, then
  read-only cards, then a card of undated rows reporting "no entry in 40 days
  ... Last: unknown". The blocklist kept growing because whether a quiet card
  is a problem is not answerable from the card's structure. It depends on what
  the card is for, and only its author knows that: a reading list, a finished
  supplement cycle and a twice-yearly blood panel are all meant to be quiet.

  So the rule set is inverted. Cards you want chased say so and say what window
  they want. The existing conservative floor still applies on top, so opting in
  can't produce a nudge you can't act on: the card must be visible, writeable
  from the webapp, carry a real per-row date, and have at least 3 rows. A
  schedule block no longer implies a tighter window; cadence is declared, never
  inferred.

  Invalid values are dropped at load (a typo leaves the card quiet rather than
  breaking it) and rejected with 422 on create/PATCH so the chat agent is told
  rather than silently ignored. `hygiene_scan`'s `growth` and `orphaned-input`
  findings are unaffected.

- **HAE push history moved from a file archive into a deduplicated table.**
  Every push used to be written to its own file under
  `data/auto-export/raw/`. Health Auto Export re-sends a rolling window
  rather than a delta, so the same samples were archived over and over:
  measured on the longest-running instance at 404 MB across 482 files for
  2.5 months of data, of which 85.6% was byte-identical re-sends. That
  archive had exactly one reader (backfilling a newly created card), so
  rebuilding one card meant parsing all 404 MB.

  Samples now live in the instance datastore, keyed by a hash of their full
  content, so each unique sample is stored once. **Every metric is stored,
  catalogued or not.** That is the point rather than a detail: a real iPhone
  pushes around twenty-five metrics and the catalogue covers thirteen, and
  for the other twelve this is the only place their history exists. Adding a
  metric to the catalogue later still backfills from the beginning.

  Deduplication is on the whole sample, not on `metric + timestamp`: Apple
  Health emits several genuinely different samples at the same minute from
  the same device, and a composite key would silently drop them. Key order
  is normalised first, because the same sample arrives with its JSON keys in
  different orders between pushes.

  Replay is unchanged in behaviour, and there is a test suite that pins that
  claim by keeping the previous file-scanning algorithm as an oracle and
  comparing the two for every aggregation strategy, including the overlapping
  running totals that caused #168.

  A payload that will not parse has no samples to store, so its bytes are
  kept at `data/auto-export/unparsed/` instead, most-recent-few only. The
  endpoint still answers `200` on a parse failure, so the phone does not
  retry-loop, and the reason is recorded in `last-push.json`.

  `scripts/migrate-hae-samples.js` folds an existing archive in. It imports,
  replays every affected metric from both the files and the table, and only
  moves the files aside once the two match exactly; a mismatch aborts with
  the archive untouched. `--dry-run` does the whole thing against a
  throwaway copy of the database first, and `--prune` deletes the
  moved-aside copy when you no longer want the insurance.
  (Fixes #546)

- Portable exports now carry HAE history. It lives in `db/`, which
  `scripts/export-embed.js` never copies, so it is written out as
  `data/auto-export/samples.json` in the payload shape the ingest endpoint
  accepts, and imported on the next boot of the restored tree. The
  `--include-raw` flag referred to the removed file archive; it is still
  accepted so existing invocations don't fail, but does nothing.

### Fixed

- **A card whose rows carry no dates is no longer reported as stale.** A
  writeable list of strings (a reading list, a supplement list) has no per-row
  date, so the scan fell back to "when did anything last write this card" and
  reported an age with `Last: unknown` attached, which is not the same claim and
  could not be acted on.

- Shutdown now closes the HAE sample store as well as the card datastore, so
  a `docker stop` checkpoints everything into `klebb.db`. Without it, a
  backup that copied the main database file without its `-wal` sibling could
  miss recently ingested samples.

## [3.4.0] - 2026-08-10

### Added

- **Report upload, with AI comprehension and an OCR verification loop.**
  Documents now go in from the browser instead of over SSH. Upload a blood
  panel, a photo of a lab result, a scanned letter, a `.docx` referral, a csv
  export or a voice memo from the Reports page; extraction stays local
  (`pdftotext`, `pdftoppm` + tesseract for scans, a zero-dependency `.docx`
  reader, ffmpeg + speech recognition), and a background pass through the
  configured chat gateway turns the text into a title, the date on the
  document, up to five bullets, and a body with the patient's own identifiers
  removed. Clinicians, practices and labs are deliberately kept: it is the
  patient's identity that is sensitive, and the referring doctor is useful
  context.

  Anything read by OCR is **gated until a human checks it**. The detail sheet
  shows the original beside the extracted text (side by side on a desktop, two
  tabs on a phone), and until you confirm it, `read_report` returns a refusal
  with no content: the gate lives in the tool the agent calls, not in its
  instructions. Retry re-runs OCR at a different page-layout setting.

  A generated summary containing a number absent from the source is never
  published: it degrades to the raw extracted text with the offending value
  named. An LLM quietly transposing a lab value is the one failure here with
  real consequences.

  The chat agent now sees each report's title, document date and bullets
  ordered by the date **on the document**, within a byte ceiling, rather than a
  list of filenames.

  Reports are a managed surface: quota, states (`processing`, `needs checking`,
  `ready`, `not summarised`, `not health`, `failed` with its reason), reprocess
  and delete. `KLEBB_REPORTS_MAX` caps how many an instance holds (default 20);
  hand-authored markdown in `reports/` is never gated, never deleted by the
  app, and never counts against it. All four mutating routes are gated in demo
  mode. Fixes #534, #535, #536, #537, #538, #539; epic #533.

- **Real WebAuthn ceremony e2e coverage.** Four Playwright specs drive the
  actual passkey ceremonies via Chromium's CDP virtual authenticator
  (ctap2/internal, resident key, user verification): bootstrap register on
  a fresh instance, invite register (minted via the admin API, single-use
  consumption verified), login with a registered credential, and Settings >
  Security adding a second passkey on a new authenticator. Each spec spawns
  its own `HEALTH_RP_ID=localhost` server; the cookie-injection fixture
  stays the default everywhere else. The `/api/admin/*` response shapes the
  klebb-web portal depends on are now pinned by `tests/admin-api.test.js`
  (auth gate, health/credentials/invites fields, origin-bound registerUrl,
  expiry clamp, no delete surface). Fixes #479.

- **Eval judge tier.** Scenarios can carry `judge: { rubric: '...' }`; a
  small model behind the same OpenAI-compatible gateway scores the turn's
  reply 1–5 against the rubric (refusal politeness, redirect quality,
  consultation encouragement, accurate create confirmations). Opt-in via
  `JUDGE_MODEL`; self-skips without it. Scores land in the report JSON and
  summary table as scores, never pass/fail, and never touch exit codes.
  The judged reply is fenced as untrusted data against prompt injection.
  Prompt assembly + score parsing pinned by deterministic tests.
  Fixes #502.

- **Post-deploy eval smoke subset.** `node evals/run.js --smoke` runs the
  five scenarios tagged `smoke: true` (create, chip chain, data log, two
  adversarial), sized for after an image publish or gateway model swap;
  documented in evals/README.md and wired into the release runbook. Tool
  capture is now trusted explicitly: a `--log-cmd` follower that dies at
  startup aborts the run (exit 2), and one that dies mid-run marks
  tool-asserting turns INCONCLUSIVE (exit 4, distinct from pass/fail)
  instead of reporting false tool regressions or vacuous passes.
  Fixes #503.

- **Stale-card nudge in the chat peek bar.** When `GET /api/hygiene`
  reports high-confidence staleness, the peek bar gently swaps to a
  dismissible nudge ("weight hasn't been updated in 34 days — tap to tidy
  up"). Tapping seeds the chat with the finding so Klebbius can help
  update or tidy the card; the ✕ dismisses without opening chat,
  persisting via the existing per-card dismissal endpoint. Deferred from
  the v3.3.0 preview (the backend shipped then). Fixes #452.

- **Version in Diagnostics.** Settings > Diagnostics now shows the running
  Klebb version in the Server panel, and `GET /api/diagnostics` carries a
  `version` field (from `package.json`, read once at boot). Answers "which
  build is this instance on?" without shelling into the container. Older
  servers without the field render `(unknown)`. Fixes #488.

- **Eval runner cost guard.** `evals/run.js` now estimates a run's model
  spend (call count, tokens, USD) and requires a `y/N` confirmation before
  any run above a small threshold; a non-interactive stdin aborts rather
  than proceeding unless `--yes` is passed. New `--model` flag (default
  `sonnet-5`) sets `CHAT_MODEL` in sandbox mode and labels the estimate;
  in remote-instance mode the note makes clear the instance's own config
  picks the model. A single-scenario smoke runs without prompting. Estimate
  maths + threshold pinned by `tests/eval-harness.test.js`. Refs #520.

- **Eval corpus growth + `cardShape` assertions.** The Klebbius eval
  harness (`evals/`) gains a `features.js` scenario set covering trends,
  adherence reports, combination cards, notifications, weekly schedules,
  multi-card reads, confirmed deletion and targeted row edits, roughly
  doubling the corpus. A new `cardShape` assertion asserts the *shape* a
  card ends in (not just which cards changed), resolving paths with the
  same grammar the chat tools use (e.g.
  `meta.view.combines[index=0].sourceId`, `data[date="..."].value`). The
  runner's state snapshot is now data-aware: `GET /api/manifests` is
  meta-only since the datastore migration, so it fetches each card's data
  block, which also makes `state.modifiedOnly`/`noChanges` catch
  data-only edits that were previously invisible to the differ. Evals
  never run in CI; the harness machinery is pinned by
  `tests/eval-harness.test.js`. Refs #501.

- **Portable export.** `npm run export -- <dir>`
  (`scripts/export-embed.js`) writes a portable copy of the instance:
  every card manifest with its `data` block re-embedded from the
  datastore, plus reports, non-card data files, and a secrets-stripped
  `config.json` (HAE ingest token and invite codes excluded;
  `--include-secrets` keeps them, `--include-raw` adds the raw ingest
  archive). Credentials, sessions, keys, and `db/` are never copied.
  Dropped into a fresh `$HEALTH_HOME`, the tree round-trips losslessly
  via the boot import: cards reappear with their history, including
  null-data vs no-data distinctions. See docs/DEPLOY.md "Portable
  export". Fixes #497.
- **Orphaned-data report + field renames.** Removing a manifest field has
  never deleted data (rows keep every key); now that's visible and
  manageable. `GET /api/manifests/:id/orphans` lists a card's stored row
  keys that nothing in the manifest references (inputs, display template
  tokens, trends/threshold/calendar/report fields, checkOffForm fields,
  HAE catalogue shape, combo accessors from other cards). The card's
  Settings gear shows an "Unreferenced data" section when the report is
  non-empty, and the chat agent gains `orphan_report` plus a
  user-confirmed `rename_data_field` tool that rewrites rows in one
  transaction. `meta.data.aliases` (`{oldKey: newKey}`) marks a rename
  without touching rows. See MANIFEST-SCHEMA.md "Removing a field
  orphans data". Refs #494.

### Changed

- **Reports detail sheet trimmed to what it is for.** The digest view now offers
  only "View full report" (once approved) and the compare view. Reprocess is
  gone from both surfaces: if a read went badly, deleting and re-uploading is
  one more tap and much easier to reason about than an in-place re-read that
  changes the report under you. Delete moved into the compare view, next to the
  text being judged. "View full report" is hidden until a report is approved,
  since an unverified one holds content chat is not allowed to use.

- **The compare view no longer tries to preview the original.** It rendered as
  an empty black box for PDFs (several browsers decline to inline an `<embed>`),
  and a phone has no room for a useful side-by-side anyway. The extracted text
  now gets the full width, with the original one tap away in its own tab, where
  it has the whole viewport plus the browser's zoom, rotate and search.

- **The report page links back to Reports**, not the dashboard. That page is
  only ever reached from the Reports view.

- **Dependencies updated** to current (`marked`, `@simplewebauthn/server`,
  `@playwright/test`); 0 vulnerabilities.

- **Test servers bind an OS-assigned port instead of a random guess.** The
  sandbox helper picked a random port in a 20k range with no collision check
  and no retry. Across the suite count this repo now runs in parallel that is
  a coin flip over a full run, and the loser's server died of `EADDRINUSE`
  before printing anything, so the failure surfaced as a bare "server exited
  with code 1" in whichever suite drew second, pointing at whatever had
  changed most recently rather than at the harness. Ports now come from the
  OS, `stderr` is captured so a bind failure says so, and a lost race retries
  once.

- **`GET /api/reports` returns an envelope, not a bare array.** Now
  `{quota, reports, processing, failed}`, with each report carrying its
  title, document date, state, source format and bullets. The Reports
  view was the only consumer; it tolerates the old shape so a stale
  cached script degrades rather than blanking.

- **`callGateway` moved to `lib/gateway.js`.** Behaviour-identical
  (same headers, same transport options, same error-string prefixes,
  which `/api/chat` string-matches to pick a status code). It lived in
  `server.js` as a closure over module-level config, so nothing outside
  that file could reach the gateway; report comprehension runs from
  `ingest/`.

- **Report frontmatter has a v2 form** carrying the digest. The parser
  accepts v1 **and** v2, and v1 files are never rewritten: reports
  written by earlier versions keep working indefinitely, with no
  migration to run.

- **Staleness signals now prefer the datastore's write time.** The
  `get_recent_activity` chat tool (and the hygiene scan built on it)
  used the manifest file's mtime as the freshness fallback for cards
  with no dated rows. Data writes no longer touch the manifest file, so
  that fallback now reads the datastore's last-write timestamp first
  (`staleSource:'updatedAt'`) and only then falls back to file mtime
  (meta edits). Refs #494.

- **Demo reset gains a `--wipe-db` flag.** The live-server reset flow
  is unchanged (the file watcher imports the rewritten fixtures' inline
  data within a second), but rows of cards removed from the fixture set
  linger in the datastore. `scripts/reset-demo.js --wipe-db`, run while
  the server is stopped, also clears `$HEALTH_HOME/db/` so the next
  boot imports into a fresh store. docs/DEMO.md documents both flows
  and why `--wipe-db` must never run under a live server. Refs #494.

- **`verify-install.sh` understands meta-only card files.** A file
  without a `data` key now passes as healthy (that is the migrated
  steady state), an inline block is reported as import-inbox input, and
  a new check reports whether the datastore file exists. Refs #494.

- **HAE raw-archive writes are now atomic.** The webhook's raw payload
  archive (`data/auto-export/raw/<stamp>.json`) is written via tmp+rename,
  closing the last non-atomic write in the app: a crash mid-write can no
  longer leave a torn archive file for replay to trip over. Refs #494.

- **`scripts/reingest-hae.js` backups re-embed current data.** Manifest
  files are meta-only now, so a verbatim file copy would back up nothing.
  The pre-reingest backup re-embeds the card's stored rows; restoring the
  backup over `<id>.json` restores the rows via the import inbox on the
  next reload. Refs #494.

- **Card data moved out of manifest files into an embedded datastore.**
  Each card's logged data now lives in a per-instance SQLite store at
  `$HEALTH_HOME/db/klebb.db` (`node:sqlite`, WAL); the manifest file
  keeps `meta` and becomes a description of the card only. The registry
  serves and writes data through the store, so a data write no longer
  rewrites the whole manifest file and a meta edit no longer touches
  data. The `data` key in a manifest file is now a one-way import inbox:
  on load, any inline block is backed up, imported (full replace), and
  stripped from the file, which is how file-drop seeding and re-imported
  exports keep working. The HTTP contract is unchanged:
  `GET`/`POST /api/manifests/:id/data`, the row-level chat tools, and the
  HAE ingest path all behave byte-for-byte as before. Boot self-migrates
  by importing every card's data block on first start; a snapshot of
  `$HEALTH_HOME` remains a complete backup because the store lives inside
  it. See MANIFEST-SCHEMA.md "The `data` key is an import inbox" and
  docs/DEPLOY.md for the WAL-safe backup note. Refs #494.

- **Node floor raised to 22.13.** The embedded datastore uses the
  built-in `node:sqlite` module, unflagged from Node 22.13, so the
  engines floor moves from `>=20` to `>=22.13` and CI now runs the
  Node 22 + 24 matrix. The server fails fast at boot with a clear
  message on anything older, instead of a cryptic missing-module crash.
  The Docker image (`node:22-slim`) already floats above the floor.
  Refs #494.

### Fixed

- **The stale-card nudge no longer fires for cards the user cannot write to.**
  Surfaced the moment #560 stopped hidden cards masking other findings: a
  `greeting-banner`, which has no input form at all, was flagged "hasn't been
  updated in 32 days". Staleness now requires `meta.writeable.fromWebapp`, judged
  on behaviour rather than a renderer allow-list so a future read-only renderer
  is covered automatically. HAE-fed cards are excluded on the same grounds (they
  cannot be hand-logged), while a card that is both HAE-fed and writeable stays
  included, because a phone that has stopped pushing is worth mentioning. Growth
  and orphaned-input still apply to read-only cards: those are author-facing
  tidy-ups rather than "go log something". Fixes #564.


- **Shutdown now checkpoints the WAL.** `_shutdown()` called `process.exit(0)`
  without closing the datastore, so `docker stop` left recent writes living only
  in `klebb.db-wal`. Nothing was lost while the file pair stayed together
  (SQLite replays the WAL on next open), but a backup that copied `klebb.db`
  alone silently dropped whatever had not been checkpointed: measured at 1084 of
  1095 rows on a real instance. `docs/DEPLOY.md` already advised stopping the
  container first, and that should not have been the only thing standing between
  a routine restart and a lossy backup. Fixes #562.


- **The stale-card nudge no longer fires for hidden cards.** A card put away with
  `hide_card` (`meta.enabled: false`) was still scanned, so the peek bar offered
  "hasn't been updated in 84 days" for a card the user had deliberately taken out
  of every view. `registry.js` already treats that flag as hiding a card
  everywhere; hygiene was the one surface ignoring it. Suppressed for all finding
  kinds, not just staleness, and unhiding restores them. It also stopped a hidden
  card sorting ahead of a visible one and silently taking the peek bar's single
  slot. Fixes #560.


- **Request bodies no longer corrupt accented or curly-quoted text.** Every JSON
  route accumulated its body with `body += chunk`, which decodes each TCP chunk
  independently, so a multi-byte UTF-8 character straddling a chunk boundary
  became two replacement characters. Silently, in whatever was then stored: a
  card label, a note, a chat message. Found while fixing the same bug on the HAE
  ingest route; the shape was repeated on thirteen others. utf8 decoding is now
  installed on the stream, which carries a partial sequence across chunks. The
  two binary upload paths deliberately keep collecting Buffers. A structural
  test fails if any accumulator loses its decoding, because the failure mode is
  silent: nothing errors, the text is just quietly wrong. Fixes #556.

- **An oversize chat-history PUT now gets its 413.** Same dead-code shape as the
  HAE route: the check sat in the `end` handler, which never fires after
  `req.destroy()`.

- **HAE pushes no longer corrupt multi-byte characters.** The ingest route
  accumulated the POST body as a string, so each TCP chunk was decoded
  independently and a UTF-8 sequence straddling a chunk boundary became a
  replacement character on both sides. Permanently: in the stored rows *and* in
  the "verbatim" raw archive, which could therefore never be byte-identical to
  what the phone sent. A device name with a curly apostrophe was enough to
  trigger it. Bodies are now collected as Buffers and decoded once.

- **An oversize HAE push now gets a real 413.** The check lived in the `end`
  handler, but `req.destroy()` means `end` never fires, so both the response and
  its diagnostic were unreachable and the phone got a bare TCP reset it would
  read as a retryable blip.

- **One malformed HAE entry no longer stalls a whole push.** Every catalogue
  `row()` dereferences its entry immediately, so a `null` element threw out of
  the dispatcher; the route deliberately swallows a post-auth throw into a 200
  to stop the phone retrying forever, so the visible result was that every
  *later* subscriber silently stopped ingesting while the push reported success.
  Bad entries are now dropped per-entry, counted, and reported in the push
  summary, so partial loss stops presenting as a clean push. Fixes #553.

### Removed

- **The inbox filesystem watcher, and the mtime-stability wait.** Upload
  is the ingest path now, so `ingest/watcher.js` and its `fs.watch`
  wiring are gone, and so is the six-poll wait that existed only to
  avoid racing an rsync mid-copy: the server writes the bytes and
  renames atomically, so a file at its final name is complete by
  construction. The boot drain stays as an operator door (`docker cp`
  plus a restart), now enqueuing under the same cap and the same rules
  as an upload. Extraction is serialised through a single slot, since
  tesseract and `pdftoppm` are CPU-bound and share node's thread with
  request serving.

- **Legacy off-disk data-read endpoints.** Removed the read-side
  counterparts of the writers retired in #496: `GET /api/supplements`,
  `/api/weight`, `/api/bloods`, `/api/appointments`, `/api/goals`,
  `/api/peptides` (which read the manifest file directly and unwrapped
  its `data` block, including a peptides `items`/`groups` aliasing shim)
  and `GET /api/weight/range/:start/:end`. Nothing has called them since
  the `_legacy-v1` client and `public/js/api.js` were removed in #506;
  they carried no test coverage and are not part of the external HTTP
  contract. Card data is served through `GET /api/manifests/:id/data`.
  `GET /api/config` (a config file, not a manifest) and the auto-export
  per-day routes are unaffected. Refs #494.

- **Retired v1 client components and their API helper.** Deleted
  `public/js/components/_legacy-v1/` (16 unmounted view components) and
  `public/js/api.js`: the manifest-driven UI imports none of it, and the
  legacy server endpoints these components called were removed with
  #496, so the tree pointed at routes that 404. The personal-refs and
  secrets scanners also drop their `_legacy-v1` skip exclusions, closing
  the standing hole in the scan surface those files required. Fixes #506.

- **Legacy `mood` / `notes` / `injection-log` JSON endpoints.** These
  were the only server writers that bypassed the manifest registry,
  reading and writing card files directly and reconciling only via the
  debounced `fs.watch` reload: a clobber window against a registry write
  to the same card. They were also dead and, on the v2 array-shaped
  cards, already broken: the manifest-driven UI never called them (only
  the retired `_legacy-v1` views did), and the `POST /api/mood/:date`
  and `POST /api/notes/:date` handlers were silent no-ops because they
  applied date-keyed-object semantics to what are now dated arrays. The
  `injection-log` handler additionally mutated `peptides.json` on disk,
  leaving the registry cache stale. Removed the routes
  (`GET/POST/DELETE /api/mood/:date`, `/api/mood/range`,
  `POST /api/notes/:date`, `GET /api/notes/:date`,
  `GET/POST /api/injection-log` and its `range`/`:date` variants) along
  with the `readLegacyJSONFile` / `writeLegacyJSONFile` helpers, the
  peptides write-through, and `synthesiseLegacyInjectionLog`. The live
  UI already logs peptide doses through the registry write seam
  (`POST /api/manifests/:id/data`). Fixes #496.

### Fixed

- **Chat says which thing went wrong instead of "No response".** An
  exhausted AI allowance, an unreachable gateway, a timeout and a genuinely
  empty answer all used to render as the same three words, which reads as
  the app being broken in every case. Each now says something true and
  distinct, and the journal names the cause so it can be told apart without
  reproducing it. The root cause was a layer below the message:
  `lib/gateway.js` parsed the response body without ever reading the HTTP
  status, so the 429 that signals an exhausted allowance was discarded before
  anything could act on it, and an error body with no `choices` surfaced as
  an empty reply. Status is now inspected before parsing, and a shared
  classifier keeps the chat route and the report comprehension pass from
  drifting on what a given failure means. An allowance message is only shown
  on a **positive** signal from the gateway: a bare 429 is ordinary rate
  limiting and is reported as transient, because claiming someone's
  allowance ran out when it has not sends them chasing a limit that is fine.
  Any OpenAI-compatible gateway may be configured, so detection is
  best-effort by design and never invents an allowance concept for a gateway
  that does not report one. Fixes #547.

- **Welcome card CTA no longer double-fires.** The first-run "Add your
  first card" button opened the template gallery *and* simultaneously
  seeded a prompt into the chat behind it, firing two competing surfaces
  on a fresh instance's very first interaction. The chat-seed dispatch was
  a forward-compat seam from before the gallery existed (#451); now that
  the gallery ships, the CTA opens it and nothing else. Fixes #489.

### Added

- **Card-data migration + dump tooling** (`scripts/migrate-data-to-db.js`,
  `scripts/dump-card-data.js`). The server self-migrates on boot (the
  import inbox runs in `registry.init()`); the migrate script is the
  operator-grade wrapper for pre-checks and rollback drills. `--dry-run`
  round-trips every card's inline data through the shape kernel and
  reports per-card row counts and skipped files, writing nothing; the
  default run imports, strips, and verifies the datastore serves a value
  deep-equal to what each file held, exiting non-zero on any mismatch,
  and is idempotent. `dump-card-data.js` captures every card's
  API-visible data to a directory (one file per card) and diffs two
  dumps, so a storage change can be proven lossless with deep-equal
  before/after snapshots. Rollback is documented in the script header:
  restore the `.pre-import-*` backups and delete `db/`. Refs #494.

- **Datastore import inbox** (`lib/datastore/import.js`). A manifest
  file carrying a `data` key gets that block imported into the
  datastore and stripped from the file, with a timestamped
  `<name>.json.pre-import-<ts>.json` backup beside it (a name the
  loader's backup filter already ignores). Ordering is crash-safe:
  backup copy, then the DB transaction, then the file rewrite via
  tmp+rename, so a crash at any point either leaves the file as a
  candidate for an idempotent re-import (full replace of the same
  value) or completes cleanly; the flow converges because a stripped
  file is never a candidate again, and a double import of one card in
  a boot logs loudly. `data: null` imports as no-data with the key
  stripped and null-ness recorded, preserving the null-vs-absent
  `hasData` distinction. The file rewrite touches only the data key:
  everything else stays byte-identical. Not yet called by the
  registry; the wiring lands with the data-plane swap. Refs #494.

- **Embedded datastore module** (`lib/datastore/index.js`). Memory-first,
  SQLite-durable store for card data rows at `$HEALTH_HOME/db/klebb.db`
  via `node:sqlite` (WAL, `synchronous=NORMAL`, fully synchronous API).
  Reads serve the same live in-memory reference the write stored,
  matching the registry cache's aliasing semantics exactly; every
  mutation is one transaction (prepared insert per row, full replace
  per card), so a mid-write throw rolls back to the prior state,
  verified by test. Rows persist decomposed through the shape kernel
  with reserved storage channels that user keys cannot collide with,
  and a bookkeeping table preserves `data: null` versus absent
  alongside per-card update timestamps. Nothing consumes it yet; the
  registry swap is a later change. Refs #494.

- **Datastore shape kernel** (`lib/datastore/shape.js`). Pure, lossless
  decompose/reconstruct mapping between any card data value and flat
  row containers: arrays become one `rows` container, objects split
  their array-valued keys into named containers with the remaining keys
  as a single rest document, and anything else is a single-row doc. The
  shape record preserves key order and empty containers, so
  `reconstruct(decompose(x))` deep-equals `x` for every shipped
  template and demo fixture plus adversarial shapes (bare-string
  arrays, duplicate and empty-string dates, unicode and `__proto__`
  keys, mixed rosters), verified both directly and after each stored
  piece passes through JSON text. Groundwork for the embedded
  datastore; nothing consumes it yet. Refs #494.

- **Klebbius eval harness** (`evals/`). Simulated user conversations
  driven against a running instance with a real model: each scenario
  scripts chat turns (including "clicking" the offered follow-up chips),
  captures the reply, chips, tool calls (via the `HEALTH_DEBUG=1`
  forensic lines) and a full before/after manifest-store diff, then
  asserts deterministic properties (required/forbidden tools, state
  changes scoped to expectation, registry stays clean, chip presence).
  Scenarios run N times and report pass rates: evaluations, not CI
  tests. `npm run eval`; corpus covers create/edit/log/chip-chain happy
  paths plus adversarial cases (off-topic asks, invented view
  components, blind bulk deletes, prompt injection in card data).

- **Body-temperature and fasting-glucose templates.** Two new
  threshold-banded vitals for the template gallery:
  `body-temperature.klebb.json` (celsius, hypothermia through high
  fever bands, up to three readings a day, and a neutral trend arrow
  since neither direction is inherently good) and
  `fasting-glucose.klebb.json` (mg/dL, the common clinical bands from
  hypoglycaemic to diabetic, one morning reading a day, falling is
  good). Both carry line-chart trends and threshold calendar markers.
  Fixes #255, #256.

- **Cardio-training starter prompt.** A prompts-gallery entry for
  endurance training: a run/ride session log, a weekly distance goal
  ring summed from the sessions card, and resting HR + HRV recovery
  trends, with an Apple Health import branch when the user runs the
  Health Auto Export pipeline. Fixes #257.

### Fixed

- **Greeting banner no longer POSTs its data on every render.** The
  once-a-day rotation guard read a `meta._state.lastRotatedDate` stamp
  that nothing ever wrote, and the `localStorage` day-stamp it did write
  was never read back, so a today-dated greeting card fired a full-array
  `POST /api/manifests/:id/data` on effectively every render (silently
  403ing on read-only cards, where nothing checked the response). The
  guard now reads a bare `YYYY-MM-DD` stamp and claims the day
  synchronously before the write, so concurrently mounted banners
  rotate at most once per day; read-only greetings (no
  `writeable.fromWebapp`) never POST; and a successful rotate now checks
  `response.ok`, invalidates the data cache, and updates the card in
  place. Fixes #495.

- **Shipped templates now colour their trend arrows per metric.** The
  trend-arrow renderer went metric-aware in v3.3.0
  (`trendArrow.goodDirection`), but the shipped templates and demo
  fixtures never declared a direction, so more-is-better metrics
  (sleep hours, steps, active minutes, mindful minutes, HRV, blood
  oxygen) still rendered a rising trend red. Every template trendArrow
  now declares `goodDirection` explicitly (`up` for the six above,
  `down` for weight, waist, body fat, blood pressure, and the heart
  rates), the demo fixtures match, and the demo set's one legacy
  `lowerIsBetter` alias is migrated to the canonical key. A test now
  requires an explicit direction on every shipped trendArrow so new
  templates can't inherit the weight default by omission. Fixes #427.

- **Embellishment chips now render on voice replies.** The follow-up
  suggestion chips Klebbius attaches after creating or editing a card
  were dropped on the recorded-voice path: the reply handler built the
  assistant message with only the speech text, discarding the
  `followup` block the server had attached. Since card-touching turns
  are exactly the ones that earn chips, anyone driving Klebbius by mic
  never saw them. Both send paths now unpack the reply through one
  shared helper, pinned by tests so they can't drift apart again. A
  live-reply e2e spec also now covers the typed path (the previous
  chip specs only covered history reload). Fixes #463.

### Security

- **`POST /api/feedback` now checks the Origin allowlist.** The
  feedback endpoint was session-gated but skipped the same-site origin
  check the notification POSTs enforce, so a page on a sibling
  subdomain could append junk lines to `feedback.jsonl` riding the
  session cookie (SameSite=Lax does not block same-eTLD+1 fetches).
  The allowlist predicate now lives in `lib/origin-check.js`, shared
  by both surfaces, and cross-origin posts get the same 403. Closes
  the auth/origin-parity criterion from #417.

- **Auth-surface hardening.** Admin and agent bearer tokens are compared
  in constant time (hash-then-`timingSafeEqual`); invite codes carry 64
  bits of randomness (up from 32); the admin invite endpoint shapes
  `label` and clamps `expiresInDays` to 1-30 at the boundary; and
  `/api/build` (branch/commit metadata) now requires a session or the
  agent bearer instead of answering anonymously.

- **Lost-passkey recovery affordance on the login page.** A failed
  passkey ceremony now shows how to get back in: registration reopens
  with a fresh single-use invite, worded for the deployment (hosted
  instances point at the hosting account's recovery flow, self-hosted at
  `scripts/invite.js`). `/auth/status` gained a `cloud` field so the page
  can tell which it is. The expired-invite copy on the setup page covers
  both shapes too, and the invite label contract (recovery invites must
  reuse the original label or credentials split into a separate entry) is
  now documented in `docs/DEPLOY.md` and pinned by tests.

- **Add a device via QR / link invite.** Settings > Security's "Add a
  device" now mints a single-use register invite for your own account and
  shows it as a QR code plus a copyable link, because the device you're
  enrolling is almost never the one you're logged in on. Scan it with the
  new phone or paste the link into any message to yourself; registering
  through it lands the passkey under your account and honours the standard
  invite expiry. Registering on the current device remains as a secondary
  action (useful for synced passkeys), and Cloud instances add a hint that
  the klebb.app dashboard can email a sign-in link. The QR encoder is a
  small vendored module (`public/js/lib/qr.js`); no new dependency.
  Refs #482.

- **Control-plane readiness endpoint.** `GET /api/admin/health` (behind
  the same `KLEBB_ADMIN_TOKEN` gate as the rest of the admin API) returns
  `{ ok, setup, cloud, rpId, origin, credentialCount }` so a hosting
  control plane can poll a freshly provisioned instance, confirm it came
  up in the hardened-bootstrap posture and is bound to the right
  subdomain, and see when the first passkey lands. No key material or
  session data is exposed. Refs #478.

- **Control-plane API and hardened bootstrap for hosted instances.** A
  hosted instance can opt into two env vars: `KLEBB_ADMIN_TOKEN` enables a
  narrow server-to-server API (`GET /api/admin/credentials` to list
  passkeys, `POST /api/admin/invites` to mint a register link on the
  instance's own origin) for onboarding and lockout recovery, and
  `KLEBB_CLOUD=1` closes open first-run registration so a public instance
  can't be claimed by the first visitor (it waits for an emailed setup
  link instead). The admin API can add but never delete a passkey, so it
  can't lock anyone out; removal stays in-app. Self-hosted installs are
  unchanged: with neither var set, the first-boot register URL is printed
  to the logs and the first visitor claims the instance. Refs #467, #472.

- **Manage your passkeys in Settings.** The Settings *Connections* tab is
  now *Security* and leads with a Passkeys section: it lists every device
  that can unlock this instance (with a nickname, device type, and when it
  was added / last used), flags the one you're on, and has an "Add a
  passkey" button so you can enrol another phone or laptop without a shell
  or an invite code (a live session can always add to its own account).
  Removing a passkey is one tap, except your last one, which is blocked so
  you can't lock yourself out. Health Auto Export moves under Security
  unchanged, and the hidden-metrics list is now collapsed by default.
  Refs #467, #471.

- **Passkeys can now be named and managed over the API.** Each stored
  passkey gains a `nickname` (free text, set at registration) and a
  `lastUsedAt` timestamp (stamped on every login), so a device is
  recognisable as "Work laptop, last used today" rather than an opaque
  id. Two new authenticated endpoints back the upcoming Security settings
  pane: `GET /api/credentials` lists your passkeys (never exposing the
  public key or counter, and flagging the device you're on) and `DELETE
  /api/credentials/:id` removes one by id. Deleting a passkey also ends
  any live session tied to that device, and the last remaining passkey
  can't be removed. Existing installs run `npm run migrate-credential-fields`
  once to backfill the new fields. Refs #467, #469.

### Fixed

- **Passkey credential store now writes atomically and won't lock itself
  open.** The credentials file is rewritten on every login (to bump the
  signature counter), but writes were a plain overwrite with no temp-file
  swap, so a crash or a concurrent write could truncate it. Writes now go
  through a temp file and atomic rename with `0600` permissions. Revoking
  a passkey also now refuses to remove the last remaining credential:
  emptying the store previously flipped the instance back into open
  first-run registration, letting any visitor claim it. Fixes #468.

- **Card settings no longer flood the server when you toggle quickly.** The
  per-card settings gear refreshed the whole Today view on every toggle,
  which on a busy dashboard fired enough requests to trip the reverse
  proxy's rate limit and return 503s mid-session. Toggles still save
  instantly; the view now refreshes once when you close the panel. Fixes
  #460.

### Added

- **Add a card from a template, in a tap.** Settings › Cards gains a
  "Browse card templates" button (and the first-run welcome card's "add a
  card" path now opens it too) that brings up a gallery of ready-made cards
  — weight, blood pressure, mood, sleep, steps and more — mirroring the
  starter-prompts gallery: search, a featured "start here" row, per-row
  Preview of the manifest, and a one-tap **Add card**. Picking one fills
  the template's placeholders (id derived and deduped, label from the
  title, unit and the like from the template's `defaults`), writes a real
  manifest via `POST /api/settings/cards/from-template`, and the new card
  appears in the list and on Today straight away. Authoring templates is
  unchanged (`templates/*.klebb.json`); `meta.template` gains optional
  `featured` and `defaults`. Closes #451.

- **A settings gear on your cards.** Data cards (generic, schedule, list,
  checklist) now carry a small header gear that opens a per-card settings
  panel: toggle whether the card accepts entries from the app (and for
  which dates), the daily prompt, carry-forward, and the trend/adherence
  sparkline. Each toggle applies immediately and saves back via the
  existing `PATCH /api/manifests/:id` path — there's no Save button.
  Whole-card enable/disable stays in Settings › Cards (it lists every
  card, including ones with no Today presence). Each renderer declares its
  own toggleable options through a static `settingsSchema`, so the panel
  only shows settings the card actually honours; data-dependent toggles
  (like the sparkline) appear disabled with a hint until there's enough
  data. The panel also has a Reminders switch: on a loggable card
  with none set up it creates a single private daily reminder at 9am
  (custom times, wording, and multiple reminders stay with Klebbius); on a
  card that already has reminders it's a master on/off that leaves the
  individual ones untouched. Read-only composite cards have no gear.
  Optional extras a card already carries (a schedule card's per-dose
  check-off form, a generic card's thresholds, trend arrow, emoji labels,
  or custom colours) appear under "Added features" as on/off switches:
  turning one off parks its config so nothing is lost, and turning it back
  on restores it exactly. Authoring those extras still happens through
  Klebbius, and the panel links straight to the chat, pre-seeded with the
  card's context, for anything it doesn't expose. Closes #456.

- **Tap a notification to re-read what it was reminding you about.**
  When a `schedule_due` push notification fires, its structured items
  (today's survivors plus same-day carry-forward of missed doses) now
  travel through the encrypted payload and are stashed alongside the
  deep-link in IndexedDB. Tapping the notification opens the app and
  surfaces an `eh-reminder-modal` with two sections — *Due now* and
  *Missed earlier* — each row tagged with its source card's emoji and
  label, with an "Open card" link per row. Daily/weekly notifications
  carry no item structure, so no modal opens. The Settings → Notifications
  test-fire path goes through the same shape so you can verify the modal
  without waiting on the wall clock. Foreground-arrival pushes still
  dispatch their existing event but do not auto-open the modal: it's a
  tap-response affordance, not a push-arrival one. Fixes #454.

### Fixed

- **List cards with no declared input fields are editable again.** A
  list-card whose manifest opted into webapp writes but didn't spell out
  `writeable.inputs` (like the Appointments card) showed an Add button
  that appended a blank, un-typeable row. The renderer now falls back to a
  plain text field on the primary key, so Add yields a row you can fill in
  and save. Fixes #457.

## [3.3.0] - 2026-06-25

### Added

- **Klebbius now reaches for the new tools.** The system prompt gained
  three steering blocks so the agent actually uses the v3.3.0 tools
  rather than just having them: (1) an intent block (act on the
  best-supported interpretation, resolve "this card" against the card
  in focus, ask at most one closed question and only when a request is
  both destructive and ambiguous, pre-fill new cards from sibling-card
  conventions via `get_recent_activity`, quote the values used); (2) a
  validate-before-write gate (call `validate_manifest` before every
  create/patch, bounded self-correction); (3) an unsupported-request
  rubric (distinguish genuinely-unsupported from needs-a-question,
  state the boundary, offer the nearest action, log the gap via
  `note_feature_request`). The four new tools are now documented in the
  prompt and in `docs/CHAT-AGENT.md`, and the stale "no reorder
  primitive" refusal example (contradicted by `reorder_rows`) is gone.
  Refs #450.

- **Tap a sparkline card to expand its full trend chart.** When a
  generic-card shows a sparkline, its header becomes clickable and
  expands the full ECharts line trend inline. ECharts loads lazily on
  first expand only (never on normal Today render), via the existing
  dynamic-import in the chart layer. The expanded chart reuses the
  card's already-fetched data and a synthesised line-chart config keyed
  to the resolved sparkline field. A new `headerless` mode on the card
  base lets the chart mount inside the host card without a duplicate
  header. The clickable header now exposes `aria-expanded`. Refs #448.

- **Adherence sparklines on checklist and schedule cards.** With
  `meta.view.showSparkline: true`, a checklist-card draws a card-level
  per-day done/due ratio strip and a schedule-card draws a per-item
  taken/missed strip, both over the last 30 days (the 30-day
  generalisation of the schedule week-dots). Rest/not-due days render as
  gaps, never as misses. Default-off, Today-only, and only when there
  are at least two days of signal. The checklist `_isDue`/`_isDone`
  predicates were made date-parameterised (defaulting to the viewed
  date) so the strip can evaluate any day. Refs #446.

- **Inline sparklines on generic cards.** A generic-card with
  `meta.view.showSparkline: true` now draws a small inline trend line
  under its headline on the Today view, using the already-loaded card
  history (no extra fetch). The plotted field resolves from
  `display.trendArrow.field`, then the first `display.template` token,
  then a numeric-key heuristic; it needs at least two dated points or
  nothing renders. When the sparkline shows, the redundant trend arrow
  is dropped so direction reads once. Default-off and Today-only, so no
  existing card changes. Refs #445.

- **Machine-readable `klebb.datafile.v1` JSON-Schema.** A committed
  artefact at `manifests/schema/klebb.datafile.v1.schema.json`,
  generated by `scripts/gen-manifest-schema.js` (`npm run gen-schema`)
  as a projection of the validator's canonical constants plus the
  shared category and time-of-day enums. It is the structural subset
  JSON Schema can express; the imperative validator stays the
  load-bearing gate for cross-field rules. The generator supports
  `--check` as a byte-stability drift guard, and the artefact is
  registered in the chat docs catalogue so the agent can fetch it via
  `read_doc` before authoring a manifest. Refs #414.

- **`numericSeries` + `adherenceSeries` series extractors.** Two pure
  helpers that turn a card's rows into the arrays a future sparkline
  will draw. `numericSeries(rows, field, {endDate, limit})` in
  `public/js/lib/display-template.js` (and its ESM twin) pulls the last
  N numeric values for a field in ascending date order, reusing
  `getValue` and the same numeric predicate as `computeTrend`. The new
  `public/js/lib/adherence-series.esm.js` adds `adherenceSeries` (a
  per-day done/due ratio over a date window, `null` for no-due days so
  rest days read as gaps rather than misses) plus a per-item
  `itemAdherenceSeries`; both take schedule logic as callbacks so the
  file stays decoupled from any engine. Refs #420.
- **`<eh-sparkline>` trend-glyph component.** A standalone, dependency-free
  Lit element (`public/js/components/eh-sparkline.js`) that maps a
  `number[]` to an inline `<svg>` polyline. It is deliberately not an
  `EhChartBase`/`EhBaseCard` subclass and never imports ECharts: a
  64x22 glyph cannot justify a ~1MB chart library built for one ~240px
  chart per card. Props: `values`, `mode` (`line`/`bar`/`adherence`),
  `width`, `height`, `baseline`, `threshold`, `colour`. Renders nothing
  below two non-null points (a single point is not a trend), guards the
  flat-series divide-by-zero, and inverts SVG y so higher values sit
  higher. Colours come from inherited CSS custom properties
  (`--accent`, `--chart-grid`) so it tracks dark/light with no JS theme
  code; the inner `<svg>` is `aria-hidden` while the host carries a
  summarising `aria-label` (direction + latest value). The pure scaling
  and path maths live in `public/js/lib/sparkline.js` (UMD) and its
  `sparkline.esm.js` mirror so they are unit-testable under Node without
  a DOM. Refs #421.
- **Hero / pinned tier on the Today view.** A card can declare
  `meta.view.priority` (a number; lower = higher up). Any card with a
  numeric priority is "pinned": it lifts into a full-width band at the
  top of the Today view, above the normal `order`-sorted masonry, so
  the 2-4 cards that matter most read as a distinct hero band under the
  greeting banner. Pure presentation: the partition is a stable sort in
  `public/js/lib/hero-tier.js` and a `.card-wrap.pinned` CSS class in
  the view renderer; no server or data-shape change. Gated to the live
  Today view only (`view` + `dateMode: "today"`, and never in reorder
  mode), so Trends/Calendar/Reports and past-day views are untouched.
  Manifests with no priority render in exactly their existing order.
- **Pinned affordance for hero cards on the Today view.** A card can
  declare `meta.view.priority` (a number) to mark itself "pinned",
  which renders a subtle accent edge on the card. Seed a hero card near
  the top by giving it a low `meta.order`; priority itself does NOT
  re-sort, so a manual reorder (which rewrites `meta.order`) always
  wins and a dragged card stays put. Pinned cards keep normal masonry
  width (they do not span the row). Pure presentation: a `pinned` flag
  in `public/js/lib/hero-tier.js` and a `.card-wrap.pinned` CSS class in
  the view renderer; no server or data-shape change. The flag is set
  only on the Today view; Trends/Calendar/Reports are untouched, and
  manifests with no priority render in exactly their existing order.
  Refs #422.
- **Ambient hygiene surface (`GET /api/hygiene`).** A quiet,
  high-confidence staleness feed (only the `stale` finding kind; the
  full multi-kind scan stays pull-only via `hygiene_scan`), mirroring
  the cc-suggestions transport. `POST /api/hygiene/:cardId/dismiss`
  silences one finding kind for one card, persisted whole-file-atomic at
  `data/_meta/hygiene-dismissed.json` and keyed by `cardId::kind` so
  dismissing one nudge never suppresses another. Refs #440.

- **`hygiene_scan` chat tool.** On-demand dashboard health check
  returning `{findings:[{cardId, kind, severity, detail}]}` so Klebbius
  can answer "is anything stale?" or "tidy up my cards". Kinds: `stale`
  (no entry well past the expected cadence, with a tighter window for
  schedule-bearing cards), `growth` (a very large data block that wants
  archiving or a rolling window), and `orphaned-input` (a capture field
  no row ever uses). Findings are conservative (near-empty cards are
  skipped) and are suggestions only: the tool never mutates anything.
  Built on the shared staleness derivation from `get_recent_activity`.
  Refs #439.

- **Chat resolves references against the card in focus.** When the user
  expands a card and then asks Klebbius something vague ("change the
  target to 80kg"), the client passes the opened card's id with the
  chat request and the server injects a "Card in focus" block into the
  system prompt so the agent resolves "this card"/"the target" against
  it before asking a clarifying question. Only injected when the id
  resolves to a real card. Refs #418.

- **Anonymised feature-request log (`POST /api/feedback` +
  `note_feature_request` tool).** When a user asks for something Klebb
  genuinely cannot do, Klebbius states the boundary, offers the nearest
  supported alternative, and records the unmet need via the
  `note_feature_request` tool, which appends one anonymised line to
  `data/_meta/feedback.jsonl`. `lib/feedback.anonymise()` is the privacy
  boundary: it keeps only a paraphrased capability intent, structural
  context, considered tool names, and a timestamp; it never writes raw
  values, labels, or the verbatim message. The operator reviews the file
  to decide what to build next. Refs #417.

- **`validate_manifest` chat tool.** A no-write dry-run that runs the
  exact structural validator the create/patch path enforces, plus
  renderer-shape checks (combination-card needs `meta.view.combines[]`
  with `sourceId`; `meta.view.display` must be an object), returning
  `{ok}` or `{ok:false, errors:[{path, message}]}`. Klebbius is steered
  to call it before any manifest write so it can self-correct shape
  mistakes first. The renderer checks deliberately match real renderer
  behaviour (line-chart `series` is optional, since the renderer
  auto-detects a y-field) rather than inventing requirements. Refs #416.

- **`get_recent_activity` chat tool.** A one-pass recency summary of
  every card (`{id, label, renderer, rowCount, lastEntryDate, ageDays,
  lastNDelta, staleSource}`) so Klebbius can answer "what's stale?" or
  reuse a sibling card's conventions without reading each card. Staleness
  is derived from per-row `date` fields (override with `meta.view.dateField`),
  falling back to the manifest file's modification time when a card has no
  dated rows. The derivation lives in `chat/recent-activity.js` and is the
  shared freshness primitive the hygiene checks build on. Refs #415.

- **`reorder_rows` chat tool.** New row-level primitive in
  `chat/tools.js` for reordering an array of rows inside a card's
  data block. Args are tiny (`{id, path, key, order:[<value>, ...]}`),
  so reordering a 20-item peptide card costs a few hundred bytes
  instead of round-tripping the ~75 KB data block via
  `write_manifest_data` (which would routinely time out the gateway).
  The tool description and the system prompt's routing table both
  steer the model to this tool for any reorder-only intent. Errors
  return `{error, code}` with a new `ORDER_MISMATCH` code for
  missing / extra / duplicate entries; the existing
  `BAD_PATH / NO_MATCH / WRONG_TYPE / AMBIGUOUS` codes are reused
  where applicable. Honours `meta.writeable.fromWebapp` like every
  other mutator. Closes #398.

### Changed

- **Welcome card is now a proper first-run empty state.** When a fresh
  install has zero user cards, `eh-welcome-card` leads with a short
  explanation of how cards come to exist (drop a `.json` manifest into
  the data folder, or ask Klebbius to make one) and a primary "Add your
  first card" CTA. The CTA seeds the chat via the existing
  `klebb-paste-into-chat` event with a "Help me create my first card"
  prompt, so it works today with no extra plumbing; it also dispatches a
  `klebb-open-card-gallery` event as a forward-compat seam for a future
  card gallery to listen on. The three existing add-a-card paths (starter
  prompt, describe-it-yourself, hand-author JSON) are kept below as
  secondary options. Server-side seed + auto-hide behaviour is unchanged.
  Refs #424.

- **Notifications row mobile touch + a11y polish.** The Notifications
  tab toggles in `eh-settings-notifications` now meet a 44×44 touch
  target (WCAG 2.5.5 / Apple HIG): the visible 36×20 track is wrapped
  in a 44×44 button so the hit area extends without changing the
  visual geometry. On viewports ≤560px a one-line privacy hint
  renders next to the privacy toggle ("Lock screen says 'You have a
  reminder'." / "Lock screen shows the full reminder text."), driven
  by `item.privacy`, so the explanation is reachable without a
  hover-only `title` tooltip. The "Show full text" caption is now
  tappable and flips the privacy toggle, matching its dotted-underline
  affordance. Both toggles carry `aria-busy` while a state POST is in
  flight, with a small animated dots indicator in a reserved slot
  next to the toggle so a tap is visibly acknowledged before the
  switch flips. The two toggles also carry stable `data-role="enabled"`
  / `data-role="privacy"` selectors used by the e2e spec, replacing
  the brittle `.toggle:first()` lookup. Fixes #393.

### Fixed

- **Line-chart config docs now match the renderer.** The docs and the
  chat system prompt described `line-chart`/`area-chart`/`bar-chart`
  config as `xKey`/`yKey`/`unit`, but the renderer actually reads
  `meta.trends.xAxis` (default `"date"`), `series:[{field, label?,
  colour?}]` (auto-detecting a y-field when omitted), `title`, and
  `yAxisLabel`. Corrected across `docs/CARDS.md` and the system-prompt
  renderer line in `config/env.js`, and added `eh-line-chart.js` to the
  chat docs catalogue so the renderer source is the durable contract.
  Refs #441.

- **`generic-card` trend arrow is metric-aware.** The arrow colour was
  hardcoded to up=red / down=green, which is right for weight (rising
  is bad) but inverted for "more is better" metrics like sleep hours,
  steps, and protein, where a rising trend should read green. Card
  authors can now set `meta.view.display.trendArrow.goodDirection` to
  `"up"`, `"down"` (the default, unchanged behaviour), or `"neutral"`.
  The signed delta (e.g. `+0.4`) is now printed next to the arrow so the
  direction is carried by the number, not by colour alone (the prior
  colour-only signal failed colour-blind readers). The legacy
  `lowerIsBetter: true` flag is accepted as an alias for `"down"`.
  (Annotating the shipped templates with per-metric `goodDirection` is
  tracked separately.) Fixes #423.
- **Chart colours now follow the active theme.** `chartTheme()` in
  `public/js/components/eh-chart-base.js` read three CSS custom
  properties (`--accent-amber`, `--accent-red`, `--accent-green`) that
  were never defined in `public/css/app.css`, so the amber/red/green
  entries in the chart palette always fell through to their hardcoded
  hex fallbacks and ignored both the light theme and any custom
  accent. The palette now reads the real `--warning`, `--danger`, and
  `--success` tokens, which resolve per theme. The hex fallbacks are
  retained as a safety net. Fixes #425.

- **`set_notification` clears `lastFired` when it changes a trigger.**
  Cached `notifications.state.json#items[<id>].lastFired` is computed
  under whatever trigger configuration was active at the time, so once
  the chat agent mutates a notification's trigger (time, type,
  weekly days, schedule_due slot) the cached slot belongs to a
  different trigger config and the scheduler must re-evaluate from
  scratch. Without this, the next slot under the new trigger could
  share an instant with the old `lastFired` (the sharp case: a
  `schedule_due` trigger that suppressed today, then mutated to plain
  `daily` at the same time) and the scheduler would treat the slot as
  already-fired and silently skip the reminder. `chat/tools.js`
  `set_notification` now deep-equals the old vs new trigger and calls
  through to a new `lib/notifications-state.clearLastFired` when they
  differ; benign updates (label/title/body changes, same trigger)
  preserve `lastFired`. `remove_notification` also drops the runtime
  sidecar entry via a new `removeItem` helper, so a per-item delete
  doesn't leave orphan toggle/`lastFired`/privacy state behind for a
  future item that reclaims the same id. The registry's `onDelete`
  hook still handles whole-card deletes. Closes #394.

- **Chat agent fails fast when no tool fits.** When the user asks for
  something that no available tool can carry out (reorder rows, merge
  cards, etc.), the model used to fudge it through the closest tool
  (typically `write_manifest_data` regenerating the whole data block).
  On a card with a 75 KB data block that generation routinely ran
  past the 180s gateway ceiling, the request died with `gateway_timeout`,
  and the user saw three minutes of dead air per attempt. The system
  prompt now carries an explicit "When no tool fits" section that
  steers the model to a fast plain-language refusal instead. As a
  belt-and-braces backstop, `runAgentLoop` enforces a soft per-iter
  budget (`CHAT_ITER_TIMEOUT_MS`, default 60000ms): if any single
  gateway iteration runs past it, the agent loop aborts and replies
  with the standard refusal copy at HTTP 200, not 504. Closes #399.

## [3.2.0] - 2026-06-16

### Added

- **Time-of-day chips in Trends + Reports.** The same `schedule.time_of_day`
  chip (☀️ / 🌤️ / 🌙 / 💤) that the schedule-card and checklist-card
  surface now also renders next to the item label in `eh-schedule-timeline`
  cycle headers and `eh-adherence-report` cycle rows. Items without
  `schedule.time_of_day` render unchanged. Per-slot adherence breakdown
  columns are deferred to a future change. Fixes #401.

### Changed

- Silenced the `MODULE_TYPELESS_PACKAGE_JSON` warning on boot by
  renaming `lib/schedule.js` to `lib/schedule.mjs`. Pure rename, no
  behaviour change. Fixes #405.

### Fixed

- Manifest validator throws now map to HTTP 422 (not 500) on
  `POST /api/manifests` and `PATCH /api/manifests/:id`. Specifically
  the `invalid notifications: ...` and `invalid schedule.time_of_day:
  ...` prefixes from the strict-mode validators were falling through
  to the generic 500 handler, so well-behaved clients (the chat agent
  in particular) misread bad input as a server bug and retried. Closes
  #404.

## [3.1.0] - 2026-06-16

### Added

- **`schedule_due` notification trigger.** A new trigger type that
  reads another card's schedule and fires only when something is
  actually due in the matching slot today. Previously every
  notification was a dumb wall-clock fire: the user got buzzed at
  08:00 every day even on rest days, even off-cycle, even when the
  dose had already been logged. The new trigger walks the named
  card's `data.items[]` and keeps an item only when today is inside
  an "on" cycle, the weekday matches the schedule, the item's
  `schedule.time_of_day` matches the trigger's slot, and no taken
  dose is recorded for today. If nothing survives, the slot
  suppresses silently. The first trigger type that consults card
  data, not just the wall clock.
- **`schedule.time_of_day` on schedule items.** Optional bound vocab
  (`morning | midday | evening | night`), single token or array.
  Acts as a join key between the trigger's slot and the item's
  schedule; also surfaces as a chip (sun / partly-sunny / moon / zzz)
  on the schedule-card and checklist-card next to each item. Chips
  render in canonical slot order regardless of how the array was
  authored. The presence of the field is the toggle: no view-config
  option, no per-card emoji override.
- **Same-day carry-forward of missed doses.** When a `schedule_due`
  trigger fires, it additionally pulls in any item from the same
  card whose `time_of_day` is "earlier" in the day's slot order
  (`morning < midday < evening < night`), is scheduled today, and
  has no taken dose yet. These appear in the new `{missed_earlier}`
  body placeholder, prefixed with `". Also missed earlier: "` when
  non-empty so the body reads cleanly in both states. Cross-day
  reset is automatic. Missed-only-morning days do not get a follow-up
  reminder: carry-forward is opportunistic, not nagging.
- **`{schedule_due}` and `{missed_earlier}` body placeholders.**
  Substitute on render with the surviving items' `short_name` (or
  `name`). Backwards-compatible with `daily` / `weekly` triggers,
  where both placeholders substitute to empty string. Privacy-private
  items keep the generic wire body; substitution lands on `realBody`
  / `realTitle` for after-decryption display. Fixes #397.

### Changed

- **Schedule resolution helpers moved from `public/js/lib/schedule.js`
  to `lib/schedule.js`** so the server can consume them too. The file
  stays a single ESM source; the browser still fetches it via
  `/lib/schedule.js` through a precise carve-out in the static handler
  (no general `/lib/*` window). Pure relocation, no behaviour change.
  Unblocks the upcoming `schedule_due` notification trigger (#397),
  which needs `isScheduledOnDate` + `effectiveCycles` server-side
  every minute. Fixes #396.

- **Settings > Cards: Reorder is now a top-of-page section that takes
  you to Today.** The old inline button shared a flex row with the
  filter input and the on/off summary, which clipped its right edge
  on iPhone 13 mini. More importantly, the button silently did
  nothing on `/settings` because reorder mode lives on the Today
  view: dispatching the old `klebb-enter-reorder-mode` event went
  unheard with no Today renderer mounted. The button now sits in its
  own labelled section above the filter row, with a short blurb
  explaining the navigation, and tapping it sets a one-shot
  sessionStorage flag and routes to `/`. The Today view consumes the
  flag once cards have loaded, drops into reorder mode, and the
  existing Done button keeps the user on Today. Hidden when fewer
  than 2 cards exist or in demo mode. Fixes #395.

## [3.0.4] - 2026-06-12

### Fixed

- **Privacy toggle override now persists across page reloads and is
  honoured at send time.** Reported behaviour: flipping "Show full
  text" on for a notification appeared to work (toggle visually
  flipped) but reverted to off after navigating away from the
  Settings tab and back. Two bugs combined.

  The POST handler at `/api/notifications/state` was correctly
  writing `privacy` into `notifications.state.json`, but two read
  paths were ignoring it:

  1. `GET /api/notifications` returned `item.privacy` from the
     manifest, so the next page load showed the toggle in its
     manifest-default state regardless of what the state file said.

  2. The scheduler's send-side built dispatch events from the raw
     manifest item, so the actual push went out with the manifest's
     privacy. The user could flip "Show full text" on, but the lock
     screen still received the generic "Klebb / You have a
     reminder." payload.

  Fixed by resolving privacy with state-file-wins precedence
  everywhere the value is read: `routes/notifications.js` GET
  aggregate and `lib/notifications-scheduler.js` event builder both
  do `itemState.privacy || item.privacy || 'private'`. Manifest
  privacy stays the default; the user's per-notification toggle in
  Settings overrides it.

  New unit tests: `tests/notifications-routes.test.js` round-trips
  privacy through POST + GET; `tests/notifications-scheduler.test.js`
  asserts the dispatched event reflects the state file when set and
  the manifest when not.

## [3.0.3] - 2026-06-12

### Fixed

- **Notification click navigates the focused tab.** Reported on
  Windows + Edge: clicking a notification in Action Center opened a
  default-search-engine search for "Klebb" instead of taking the
  user to the Klebb app. Two bugs combined: the SW's
  `notificationclick` handler called `c.focus()` to bring the
  existing Klebb tab forward but never actually navigated it, and
  the page's `klebb-deep-link` listener gated on `event.source`
  being the active SW controller, which Edge/Windows can deliver as
  `null`. The deep-link `postMessage` was silently dropped, the tab
  came forward without changing URL, and Edge fell back to its own
  Action Center default (search the manifest's `name`). Fix: SW now
  calls `WindowClient.navigate(absoluteTarget)` before `c.focus()`,
  which always lands the tab on the intended URL regardless of
  whether the message is delivered. The page listener relaxes its
  source check to origin-only - the cross-frame attack we cared
  about (a third-party iframe spoofing) is fully addressed by
  `event.origin === location.origin`. Both `clients.openWindow` and
  `WindowClient.navigate` receive an absolute URL now, since some
  browsers treat path-only arguments as opaque address-bar strings
  when called from a click delivered via Action Center. Refs #392.

### Changed

- **Settings > Notifications: Test button removed.** The per-row
  Test button was scaffolding for early use and is no longer
  needed. The redundant "On" caption next to the enabled toggle is
  also gone (the switch position is the affordance; aria-label +
  aria-checked carry semantics for AT). The "Show full text"
  caption next to the privacy toggle stays - a bare switch can't
  communicate lock-screen-privacy. The `/api/notifications/test`
  endpoint and rate limiter are unchanged server-side; only the UI
  affordance is removed. Refs #392.

- **Notifications row wraps below 560px.** On iPhone 13 Mini
  (375px viewport) the [time | label | toggles] row was overflowing
  and the toggles visually overlapped the label. New `@media
  (max-width: 560px)` rule (matching the breakpoint convention used
  by Settings > Connections and Settings > Diagnostics) wraps the
  toggles strip onto its own line, right-aligned under the label.
  Adds `overflow-wrap: anywhere` on `.item-label` as defence
  against pathological labels pushing the toggle strip off the row
  on desktop, plus the project-standard `prefers-reduced-motion`
  guard around the toggle transitions. Refs #392.

## [3.0.2] - 2026-06-12

### Fixed

- **Test push from a foreground tab now surfaces the OS notification.**
  The service worker's `push` handler was branching on
  `visibleClients.length > 0`: when any Klebb tab was visible it
  posted a `klebb-foreground-notification` message and skipped
  `showNotification` entirely, on the theory that an in-app toast
  would render the notification inline. The toast component never
  shipped, so `klebb-foreground-notification` had no listener and the
  banner silently dropped. The most visible symptom was test pushes
  from the device the user was looking at: server logs showed `201`
  back from the push provider but the user saw nothing. Foreground
  branch is now additive: postMessage to visible clients (so a future
  toast layer can opt in) AND call `showNotification` so the banner
  always fires.

### Added

- **Push send logging on every dispatch.** `lib/web-push-send.js` now
  emits a one-line summary per send (`[notifications] send ev=... recipients=...`)
  plus a per-recipient line with the short id, UA hint, and provider
  status code, plus a final `done` line with sent/failed counts. Lets
  `docker logs` answer "did device X get the push" without parsing
  `notifications.state.json`.

## [3.0.1] - 2026-06-12

### Fixed

- **Dockerfile now copies `lib/` and `routes/`.** v3.0.0 introduced
  these top-level directories but the Dockerfile's explicit per-
  directory `COPY` list missed them, so the container image crashed
  on boot with `Cannot find module './lib/user-tz'`. Hotfix release;
  no other v3.0.0 functionality changed.

## [3.0.0] - 2026-06-12

Push notifications: cards declare reminders, the dashboard delivers
them. The five PRs landing in this release (#388 / #389 / #390 /
#391 / #392) ship the full feature: a tabbed Settings shell, the PWA
service worker + manifest fixes that Web Push requires, the
manifest-side schema for `meta.notifications`, the VAPID + push
endpoints + send module, and finally the Notifications + Diagnostics
tabs plus two new Klebbius tools (`set_notification` /
`remove_notification`).

The dark/light theme toggle moved out of the Klebb wordmark and into
Settings > General. The settings dropdown collapsed into a direct
gear-icon link.

### Added

- **Settings > Notifications tab: per-card toggles, quiet hours, pause.**
  Replaces the placeholder from PR #383. Renders a status banner that
  walks through the permission states (default / denied / granted+
  subscribed / granted-but-unsubscribed / iOS-needs-install), per-card
  sections grouped by manifest with one row per declared item sorted
  by trigger time, two toggles per row (enabled, "Show full text" =
  privacy public/private), and an always-visible Test button. Global
  controls: Quiet hours window (start/end times persisted to
  `notifications.state.json`) and Pause-for chips (1h / 4h / 1 day,
  with a persistent app-wide banner the operator can dismiss with
  Resume). Empty state and a footer note: *"If a notification you want
  is missing, ask Klebbius to add it."* Refs #387.

- **Settings > Diagnostics tab: real surface.** Server timezone, VAPID
  keyId, subscribed-devices table (truncated id, nickname, last-sent,
  last-status, dead state), and the recent-fires audit ring back-to-
  front. Reads from `/api/diagnostics`; demo-mode 410 surfaces as a
  copy explaining the disable. Refs #387.

- **Browser-side notifications client (`public/js/lib/notification-client.js`).**
  Lazy enable: prompt for permission only when the user clicks Enable
  or flips a toggle for the first time. Subscribe via `pushManager`,
  POST the subscription, store the VAPID keyId in localStorage so we
  can detect operator key rotation and silently force-resubscribe.
  Foreground heartbeat fires on every `visibilitychange` to visible
  and on app boot in standalone PWA mode, calling
  `/api/push/subscribe/heartbeat`; on 404 the client transparently
  resubscribes. Disable() unsubscribes both server and device. Refs
  #387.

- **Service worker now substitutes real text for `private`
  notifications.** The wire payload from PR #386 already carries
  `realTitle`/`realBody`; the SW reads them and surfaces the real
  content on-device after decryption (lock screen still shows generic
  "Klebb / You have a reminder." per the wire). Foreground branch:
  when a Klebb tab is visible, the SW posts a
  `klebb-foreground-notification` message and skips
  `showNotification` entirely (iOS would suppress the banner anyway,
  and skipping avoids a budget violation). Deep-link intent is
  persisted to IndexedDB BEFORE `showNotification` so an iOS cold-
  start launch (which can strip query strings off `clients.openWindow`
  URLs) reads-and-clears it on app boot. Same-origin URL validation
  on every `notificationclick` navigation. Refs #387.

- **Klebbius gains `set_notification` + `remove_notification` tools.**
  `set_notification` is idempotent by `(card_id, notification_id)`:
  if an item with that id exists it's replaced, otherwise a new one
  is appended. When `notification_id` is omitted, an id is auto-
  generated as a snake-case slug from `label`. `remove_notification`
  drops a named item; the system prompt requires one-shot user
  confirmation before calling. The chat agent's system prompt gains
  notification copy rules: titles up to 30 chars, bodies up to 80,
  second person, no emoji unless the card has `meta.emoji`, never
  include numerical values or content of past entries (notifications
  are reminders TO ACT, not summaries of what happened). Refs #387.

- **Embellishment chip: "Add a daily reminder?"** After the chat
  agent creates a card with a renderer that supports logging
  (`generic-card`, `schedule-card`, `checklist-card`, `list-card`)
  and the card declares no notifications yet, the post-turn chip
  panel offers a starter prompt the user can edit before sending:
  *"Add a notification to remind me to log {label} every evening at
  8pm."* Refs #387.

### Added

- **Web Push delivery: real notifications hit real devices.** New
  `/api/push/*` endpoints (`vapid-public-key`, `subscribe`,
  `subscribe/heartbeat`, `unsubscribe`) accept a browser
  `pushManager` subscription and persist it to
  `$HEALTH_HOME/push-subscriptions.json` (mode 0o600, atomic). Capped
  at 20 active subs per instance, oldest evicted on overflow. The
  scheduler from PR #385 now fires Web Push events through the
  `web-push` npm package; private notifications carry generic
  `Klebb / You have a reminder.` on the wire and the real text in a
  separate field the SW substitutes after decryption. Tag is the
  opaque `klebb-<sha256-prefix>` so the push provider can't infer
  medical category from the collapse key. `Urgency: high` and
  `TTL: 300` make late-fire batching unlikely on iOS Low Power Mode.
  Refs #386.

- **VAPID keypair: lazy generation + operator rotation.**
  `$HEALTH_HOME/keys/vapid.json` is generated on first push API call
  and stored mode 0o600 with atomic+fsynced writes. Operator
  rotation is "delete the file and restart" - existing subs return
  401/403 from the push provider on next send, are marked dead, and
  re-subscribe on the client's next Settings open via the keyId
  fingerprint comparison (lands in PR #387). The keys live under
  `keys/`, not `sessions/`, because conflating long-lived asymmetric
  identity with session ephemera invites accidental nuke during
  session-troubleshooting resets. Refs #386.

- **`/api/notifications/*` HTTP surface: state, global controls, test
  fire, diagnostics.** `GET /api/notifications` aggregates every
  declared item across every manifest plus its toggle/lastFired.
  `POST /api/notifications/state` flips per-item `enabled` /
  `privacy`. `POST /api/notifications/global-state` writes
  `quiet_hours` and `paused_until`. `POST /api/notifications/test`
  fires a configured payload right now to every live subscription
  (rate-limited at 1/min per notification id, so a session-token
  leak can't spam the operator's phone). `GET /api/diagnostics`
  surfaces TZ, VAPID keyId fingerprint, subscription metadata
  (truncated id + nickname + last_seen + last_status; never the
  raw endpoint URLs), and the recent-fires ring buffer. Every
  state-changing endpoint goes through an Origin-allowlist
  middleware that rejects requests whose `Origin` header doesn't
  match `ENV.WEBAUTHN_ORIGIN` - SameSite=Lax cookies don't block
  cross-fetch from same-eTLD+1 subdomains, so this is the actual
  CSRF defense. In `KLEBB_DEMO=1` every endpoint above 410s. Refs
  #386.

- **Recent-fires audit ring (100 entries) in
  `notifications.state.json`.** Each scheduler tick that dispatches
  appends `{ ts, id, sent, failed, statuses }` so the Diagnostics tab
  (lands in PR #387) can answer "why didn't I get reminded at 8pm
  yesterday". Refs #386.

### Changed

- **`web-push` npm package added.** Transitive deps: zero (a small
  set of Node-builtin-equivalents). Justification: this is the
  cryptographic surface (VAPID JWT signing per RFC 8292, content
  encryption per RFC 8291). One audited package replaces ~250 lines
  of from-scratch ECE and AES-128-GCM we'd otherwise own and is
  widely exercised in production. Refs #386.

### Added

- **`meta.notifications` schema: declarative push reminders per card.**
  Cards may declare an `items[]` array of notifications inside their
  `meta.notifications` block. Each item has an `id`, `label`, `title`,
  `body`, a `trigger` (v3.0.0 supports `daily` and `weekly` types),
  and optional `action`, `privacy`, and `default` fields. Validator
  is lenient at load (drops bad items silently so a malformed sidecar
  can't wedge the registry) and strict at create / PATCH (returns 422
  with an `invalid notifications: ...` prefix). Caps: 10 items per
  manifest, 50 active items per instance. Documented in
  `MANIFEST-SCHEMA.md`. Refs #385.

- **In-process notifications scheduler.** A self-rescheduling
  `setTimeout` lands on the start of each minute, walks the registry,
  evaluates triggers, and dispatches due notifications. Idempotent:
  `lastFired` stores the slot ISO (not the wall-clock fire time) so a
  restart inside the minute doesn't refire. Coalesces same-minute
  fires into a single dispatch event. Honours global `paused_until`
  (skips and does not advance `lastFired`, so the most recent missed
  slot fires when paused expires) and `quiet_hours` (advances
  `lastFired` but skips the dispatch). The dispatch path is
  logging-only in this PR; the Web Push send arrives in #386.
  Started at server boot when `!KLEBB_DEMO`; stopped on SIGTERM /
  SIGINT. Refs #385.

- **Per-instance runtime state file at
  `$HEALTH_HOME/notifications.state.json`.** Mode `0o600`, atomic
  tmp+rename writes with `fsync`. Stores per-item enabled/lastFired,
  global quiet hours, and the global pause deadline. Created lazily
  on first toggle. The registry's new `onDelete` hook prunes orphan
  entries when a card is deleted. Refs #385.

- **User-timezone capture for the scheduler.** New `POST /api/user/tz`
  endpoint validates against `Intl.supportedValuesOf('timeZone')` and
  persists to `$HEALTH_HOME/user.json` (mode `0o600`, atomic). The
  client sends the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`
  on each session boot, idempotently (skipped when unchanged since
  last post). The scheduler reads the user's TZ first and falls back
  to `process.env.TZ`, so reminders fire in the user's local time
  even when they travel. Refs #385.

- **PWA shell: a real service worker.** `public/sw.js` registers at
  scope `/` from the app shell on first load. The handlers wrap every
  task in `event.waitUntil()` so iOS doesn't terminate the SW
  mid-flight; the body is currently a stub that surfaces a generic
  notification (the notifications PR fills in real payload handling).
  `notificationclick` validates payload URLs are same-origin before
  navigating. Refs #384.

- **Klebb minimum Content-Security-Policy.** `/index.html` (and the
  SPA fallback for client-side routes) sends a CSP that confines the
  page to `'self'` plus `https://esm.sh` for scripts and the three
  Web Push providers (Google FCM, Mozilla autopush, Apple's web push
  relay) for `connect-src`. Style sources keep `'unsafe-inline'` for
  Lit; image sources allow `data:` for inline icons. Adding push
  without a baseline CSP would make any future XSS dramatically more
  durable. Refs #384.

### Changed

- **Web app manifest tightened for installability.** `public/manifest.json`
  declares `id`, `scope`, `description`, `categories`, and a stable
  `start_url` (`/?source=pwa`). The 192/512 icons now declare
  `purpose: "any maskable"` so Android adaptive shapes don't clip the
  glyph. `theme_color` matches `background_color` (`#0f0f1a`) so the
  PWA's status bar reads dark. The stray `<meta name="theme-color">`
  in `index.html` (which was a different colour) is gone; the
  manifest is the sole source of truth. Refs #384.

- **`/sw.js` and `/manifest.json` are served `Cache-Control: no-cache`.**
  Without this, deployed service worker updates can take days to
  propagate (especially on iOS Safari, where the HTTP cache is
  conservative). The exact-path match on the static handler avoids
  any future user-controlled path inheriting the policy. The manifest
  is also served as `application/manifest+json` so older browsers
  parse it with manifest-format expectations rather than as generic
  JSON. Refs #384.

- **Demo mode 404s `/sw.js`.** The public demo at `demo.klebb.app`
  should not capture push subscriptions for a tenant that no one
  owns. Service-worker registration on the demo now fails harmlessly
  in the browser instead of installing a dead handler. The web app
  manifest still serves on the demo so install metadata stays correct
  for visitors who bookmark it. Refs #384.

- **Theme bootstrap script in `index.html`.** A tiny inline IIFE
  reads `klebb-theme` from localStorage and applies the `data-theme`
  attribute on `<html>` before stylesheets evaluate. Removes the
  dark-mode flash-of-light on reload that the previous module-load
  timing made unavoidable. Refs #384.

- **Settings is now a tabbed view: General / Notifications /
  Connections / Cards / Diagnostics.** The 1029-line monolithic
  Settings page is broken into one component per pane, with the shell
  hosting a tab strip (WAI-ARIA `role=tab`, arrow-key + Home/End
  navigation, mobile horizontal scroll-snap). Health Auto Export
  moves to Connections; the per-card master enable/disable list moves
  to Cards. Notifications and Diagnostics are placeholders that get
  populated when the notifications feature lands in a follow-up PR.
  Refs #383.

- **Dark/light theme toggle moved from the wordmark to Settings >
  General.** Tapping the Klebb wordmark in the top-left no longer
  flips the theme. The theme is now controlled exclusively by a
  toggle in the new General tab. The underlying preference key
  (`klebb-theme` in localStorage) and the `data-theme` attribute on
  `<html>` are unchanged, so existing themed CSS keeps working. The
  shared theme bootstrap lives in `public/js/lib/theme.js`. The
  former settings dropdown collapses into a single ⚙️ button that
  opens `/settings` directly; the "Reorder cards" item is now a
  button at the top of the Cards tab. Refs #383.

### Fixed

- **Ingest tests no longer race the `.error` sidecar write on Node
  22.** Two end-to-end ingest tests (`unsupported extension lands in
  _failed/` and `audio drop without FISH_AUDIO_API_KEY`) were
  polling for the moved file in `_failed/` and then immediately
  reading the sibling `.error` sidecar. The pipeline writes those in
  two steps (rename, then a separate `writeFileSync`), and Node 22's
  fs scheduler in CI occasionally landed the rename before the
  sidecar write completed. Both tests now poll for the sidecar
  itself (the LAST artefact written) with non-empty content, then
  assert the moved file is also present. Removes intermittent
  ENOENT failures on the Node 22 CI job. Closes #377.

- **Chat widget no longer aborts in-flight replies when the tab is
  backgrounded.** A defensive `visibilitychange` watcher in
  `health-chat.js` was calling `AbortController.abort()` on the
  in-flight `/api/chat` fetch whenever the tab had been hidden for
  more than three seconds, then pushing a "Tab was backgrounded:
  reply was lost. Send again." error into the chat. Browsers do not
  kill in-flight network requests in hidden tabs (they only throttle
  timers), so the abort was self-inflicted: the fetch would have
  completed cleanly if left alone. Cheap when chat turns took ~5s,
  but tool-using turns now legitimately run 30 - 60s and routinely
  straddle a quick tab switch. The watcher and its error copy are
  removed entirely; the request rides through visibility changes and
  the reply lands when the tab comes back. Closes #372.

- **Schedule-card previous-dose hint no longer points at today's dose
  after logging.** When a `checkOffForm` declares `previousDoseFields`
  (the reactions-at-prior-site flow), the form surfaces a "Last:"
  context line summarising the most recent dose, and merges any
  `previousDoseFields` payload values back onto that same dose. Both
  lookups walked backwards through `item.doses` to find the most
  recent entry with `takenAt` set. After the user logged today's dose
  and re-opened the form to fill in the prior-site reaction, that
  walk landed on today's entry instead of the one before it: the hint
  showed today's location, and the reaction got stamped onto today's
  dose. Both call sites (`_findPreviousDose` and the inline walk-back
  in `_submitCheckOffForm`) now skip any dose whose `scheduledDate`
  matches the currently-viewed date. Closes #378.

## [2.4.0] - 2026-06-10

### Fixed

- **Schedule-card check-off form: top action bar now sits above the
  prev-dose context, and both bars right-align as intended.** The
  Cancel / Log dose pair at the top of the popped-out form
  previously rendered below "How does the last injection site look?",
  and both bars rendered left-aligned despite their CSS asking for
  the right. Two bugs: (1) the prev-dose context (`Last: ...` panel
  + prompt) was rendered by `eh-schedule-card` outside the form, so
  the form's top action bar slotted in below it. Moved into the form
  via a new `.headerSlot` Lit-template prop on `eh-input-form`,
  sitting between the top action bar and the inputs. Order is now:
  top actions, prev-dose context, divider + new-dose chips, bottom
  actions. (2) An orphan CSS brace inside `eh-input-form`'s
  stylesheet (`color: var(--text-inverse, white); }` with no matching
  opener, left over from an earlier stepper-input batch) was causing
  the browser's CSS parser to drop the `.actions { justify-content:
  flex-end; ... }` rule on the floor. Removed the dead three lines;
  both action bars now sit at the right edge of the form. Closes #375.

### Added

- **Row-level chat tools.** The chat agent gains five new tools that
  operate on a single row at a time instead of round-tripping the
  whole `data` block: `read_manifest_meta` (meta + description +
  schema only, no rows), `read_manifest_rows` (addressable slice of
  the data block, auto-truncates long arrays to 10 with
  `{truncated, total}` and collapses long sub-arrays to
  `{omittedArray, count}`; `order: "desc"` for the latest entries),
  `append_row`, `update_row`, `remove_row`. All three writers respect
  the existing `meta.writeable.fromWebapp` gate and surface typed
  failure codes (`BAD_PATH`, `NO_MATCH`, `AMBIGUOUS`, `WRONG_TYPE`)
  so the model can self-correct without a wholesale retry. The path
  language is documented inline in each tool's description: tiny
  equality-only grammar, `seg.seg[k=v]` with `[index=N]` and a
  leading `[k=v]` for array-rooted cards. Existing `read_manifest`
  and `write_manifest_data` stay as fallbacks for non-array shapes
  and wholesale restructures. Closes the long-running cause of chat
  gateway timeouts on edits to large schedule cards: a row append
  that previously rewrote ~67 kB of JSON now round-trips a single
  dose. Closes #363.

### Changed

- **Schedule-card check-off form: actions render at top and bottom.**
  Tapping a scheduled item's ✓ now shows Cancel / Log dose bars both
  above and below the inputs, so the common "tick a dose without
  logging the site" path is two thumb-adjacent taps with no scrolling
  past the chip rows. The bottom bar stays for users who do fill the
  fields. Driven by a new `actions-position` prop on `eh-input-form`
  (`bottom` (default) / `top` / `both`); other cards using the form
  are unchanged. Closes #370.

### Internal

- **Manifest path parser + resolver.** New pure module
  `manifests/path.js` providing `parsePath()` and `resolvePath()`
  for an equality-only path language (`segment.segment[k=v]`,
  with `[index=N]` for direct array indexing, and a leading
  `[k=v]` form for filtering an array-typed root). Returns
  `{container, key, value}` so callers can mutate via the parent
  reference; throws typed `BadPath` / `NoMatch` / `Ambiguous` /
  `WrongType` errors with stable `code` fields. Phase 1 of the
  row-level chat tools work; nothing user-visible yet. Refs #363.
- **Registry row-level read/write functions.** New `readRows`,
  `appendRow`, `updateRow`, `removeRow` on `manifests/registry.js`
  composed on top of the path module above. All writers atomically
  deep-clone, mutate, schema-check, and persist via the existing
  tmp+rename idiom; on any error before rename, on-disk state and
  the in-memory cache are unchanged. Path / shape failures bubble
  up with their `code` fields preserved. Step-0 cleanup pulled the
  envelope-build and atomic-persist patterns out of `writeData` /
  `setMasterEnabled` / `patchManifest` into shared helpers so all
  callers share one persistence path. Phase 2 of #363; nothing
  user-visible yet. Refs #366.

## [2.3.1] - 2026-06-08

### Added

- **Schedule-card check-off form labels its new-dose section.** The
  three site chip rows (Side / Region / Position) now sit under a
  small heading after the form's section divider, anchoring what
  they collectively describe. New optional
  `meta.view.checkOffForm.currentDosePrompt` field on schedule-card
  manifests sets the heading text; defaults to a generic
  `"This dose"` when the field is absent. Mirrors the existing
  `previousDosePrompt`. Only rendered when the form has both
  previous- AND current-dose sections (i.e. when there's a divider
  to label). Closes the operator-reported gap where the new-dose
  section had no framing for what its chips were about. Demo
  fixture and Recipe 13 set `"This injection"` so the canonical
  recipe ships the more specific phrasing. The renderer's
  `eh-input-form` gains a generic `divider-label` attribute that
  pairs with `divider-after-key`. Fixes #361.

## [2.3.0] - 2026-06-08

### Added

- **`eh-input-form` accepts `divider-after-key`.** Optional attribute
  that renders a thin horizontal separator after the input whose key
  matches. Generic, opt-in; absent = no divider. Used by
  schedule-card to split previous-dose fields from new-dose fields
  visually. Refs #359.

### Changed

- **Schedule-card check-off form visually separates previous-dose
  context from new-dose fields.** The "Last: ..." line + the
  `previousDosePrompt` now render inside a tinted panel
  (`background: var(--bg-input)`, padding, rounded corners) so it
  reads as a discrete block. The `right thigh middle` value renders
  at 13px font-weight 600 to stand out. The previously-rendered
  dashed bottom border on the panel is gone — its job (separating
  prev-dose content from new-dose fields) is now done by a
  `divider-after-key` rendered inside `eh-input-form` after the last
  previousDoseField. The reactions chips still sit outside the
  panel, in normal styling, and the divider now sits below them
  rather than above. Closes the operator-reported confusion where
  reactions looked like just another field on today's dose despite
  semantically belonging to dose N-1. Fixes #359.

### Changed

- **`"none"` removed from the canonical reactions chips-multi
  options** in `demo/fixtures/peptide-cycle.json`, `docs/RECIPES.md`
  Recipe 13, and the `docs/CARDS.md` schedule-card per-dose metadata
  example. The chips-multi field allows multi-select, so offering
  `"none"` as an option meant a user could tick `"none"` alongside
  `"bruised"` — nonsensical. Absence of selection is already the
  implicit "no reaction" state. The renderer's defensive
  `'none'`-filter in `_summariseDoseForCard` (#354) stays in place
  so any legacy dose entries that already carry `reactions:
  ["none"]` continue to render cleanly. Refs #357.

### Added

- **Schedule-card surfaces logged per-dose metadata on the card and
  pre-fills the form on re-tap.** Two related improvements to the
  `meta.view.checkOffForm` flow added in v2.2.0 (#345):
  - The values logged via the form (site, reactions, etc.) now render
    as a small muted summary line on the item itself for the viewed
    date, between the cycle text and the week dots. Format: current-
    dose values joined with spaces, then ` · ` separator, then any
    previous-dose values joined with `, `. The chips-multi reactions
    value `"none"` is filtered from the rendered line — it's
    implicit, either by ticking the chip or leaving the field empty.
    The chip stays available so users can explicitly mark "I checked
    and it was fine"; the renderer just doesn't echo it back.
  - Re-tapping ✓ on a date that already has a dose entry opens the
    form pre-filled with that entry's values for editing. Submit
    replaces the entry wholesale (no second dose stacked). The
    `previousDoseFields` merge still targets the most recent prior
    taken dose, not the entry being edited. Closes the workflow gap
    where editing a logged dose required ticking → unticking →
    re-ticking → re-filling every chip from scratch. Fixes #354.

### Changed

- **Demo Injections card showcases per-dose injection-site logging.**
  `demo/fixtures/peptide-cycle.json` now declares
  `meta.view.checkOffForm` and the four chip inputs (side / region /
  position + reactions) introduced in #344 / #345. Historical doses
  on BPC-157 and Ozempic are annotated with plausible rotation
  patterns and the occasional `bruised` / `tender` / `red, itchy`
  reaction so the "Last:" context line renders something real when
  a visitor taps ✓ on demo.klebb.app. Insulin's last six doses are
  annotated; the 24 older daily entries stay bare. Refs #352.

## [2.2.0] - 2026-06-08

### Added

- **Schedule-card per-dose metadata + retroactive review of the
  previous dose.** Setting `meta.view.checkOffForm` opts a
  schedule-card into a form-driven check-off: tapping the ✓ now
  expands an inline form sourced from `meta.writeable.inputs` instead
  of hardcoding `{scheduledDate, takenAt}`. Two ordered field lists
  drive the form: `currentDoseFields` (stamped onto the new dose
  entry) and `previousDoseFields` (merged onto the most recent prior
  dose with `takenAt` set — the retroactive-review channel). Above
  the form, a "Last:" context line summarises the previous dose's
  current-dose-field values plus a relative date (e.g. `Last: 3d ago
  · right belly upper`). Hidden when no prior taken dose exists. An
  optional `previousDosePrompt` string customises the label above the
  previous-dose inputs. Untick is unchanged and never opens the form.
  Schedule-cards without `checkOffForm` keep the original one-tap
  behaviour exactly as before (purely additive). Documented in
  `docs/CARDS.md` "Schedule-card per-dose metadata" + a new recipe
  in `docs/RECIPES.md`. Renderer-source summary in `chat/docs.js`
  updated so the chat agent's catalogue reflects the new contract.
  Fixes #345.

- **Chip pills as a new input type — `chips` and `chips-multi`.** Two
  new entries in `meta.writeable.inputs[*].type` for tappable pill
  chips. `chips` is single-select and stores the selected option's
  value (string); tapping the selected chip clears it. `chips-multi`
  is multi-select and stores an array of values; `required: true`
  means at least one chip must be selected. Both share `select`'s
  `options` shape (`["a", "b"]` or `[{value, label}]`). Used in
  every renderer that already routes through `eh-input-form` —
  generic-card, list-card, combination-card edit, prompt-modal in
  modal mode. Prefer `chips` over `select` for short option lists
  (≤ 8) where all options should be visible at once; stay on `select`
  for long lists. Documented in `docs/CARDS.md` and
  `MANIFEST-SCHEMA.md`. Fixes #344.

- **Chat agent can fetch built-in renderer source through `read_doc`.**
  The `chat/docs.js` allowlist now exposes the twelve `eh-*.js` Lit
  components under `public/js/components/` (every built-in card
  renderer plus `eh-input-form` and `eh-prompt-modal`) as a separate
  "Renderer source" subsection in the system-prompt catalogue. The
  agent reaches for docs first; renderer source is the second-stop
  source of truth when the docs leave a gap on a specific behaviour or
  the user asks for a code-level explanation. Each entry's one-line
  summary states the renderer's most-asked contract fact (consults
  `meta.writeable.inputs` vs hardcodes the write shape, primarily) so
  the agent can usually answer without fetching the file. Same
  allowlist + path-traversal guard + 200KB cap as before; no globbing,
  manual entries only. The "Verifying renderer behaviour" section in
  the system prompt is updated to a three-step ladder: docs first,
  renderer source if the docs leave a gap, declare uncertainty
  otherwise. Fixes #348.

- **Renderer behaviour reference in `docs/CARDS.md`.** New section
  documenting, per built-in renderer, what it reads from the manifest,
  what it writes to data on user interaction, and what it ignores. The
  most load-bearing fact is the table of which renderers route their
  write path through `meta.writeable.inputs` (generic-card, list-card,
  combination-card edit, prompt-modal in modal mode) and which
  hardcode the write shape (schedule-card check-off, checklist-card,
  prompt-modal in checklist mode). Refs #346.

- **Hours-as-time display hint.** New optional `format: "hm"` field on
  `meta.view.combines[]` entries renders the legend value and goal as
  `H:MM` instead of decimal hours (e.g. `8.17` → `8:10`, `8` → `8:00`).
  A matching `{key:hm}` modifier in the display-template engine lets
  atomic generic-cards (e.g. `sleep-hours`) use the same conversion.
  The on-disk shape is unchanged — manifests still store decimal
  hours. Fixes #312.
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

- **Chat agent verifies renderer behaviour from docs first.** The
  default system prompt now carries a "Verifying renderer behaviour"
  section telling the agent to consult the new **Renderer behaviour
  reference** in `docs/CARDS.md` before claiming what a built-in
  renderer reads / writes / ignores, and to declare uncertainty
  ("I can't verify this from the docs") when the answer isn't there.
  Reasoning by analogy across renderers is forbidden — the fact that
  one renderer consults `meta.writeable.inputs` is not evidence that
  another does. Closes the failure mode where the agent confidently
  proposed a `meta.writeable.inputs` patch for `schedule-card`'s
  check-off path, which the renderer doesn't consult. Fixes #346.

- **Chat agent stance.** The default system prompt now carries a
  short "Your stance" section that frames the user as an informed
  adult driving their own regimen and tells the agent not to refuse
  or hedge on peptide / supplement / dosing questions. Carve-out is
  narrow: genuine emergencies and acute diagnosis (chest pain,
  suspected stroke, suicidal ideation, anaphylaxis, unknown lump).
  Without this framing the underlying model fell back to a generic
  refusal on a fresh chat, then engaged once the user re-asked with
  manifest-tool framing; the inconsistency erodes trust.
  `HEALTH_SYSTEM_PROMPT` and `HEALTH_SYSTEM_PROMPT_FILE` overrides
  still take precedence. Fixes #326.

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

- **`auth/invites` no longer hides config-read failures.** A bare
  `try { ... } catch { return {}; }` in `_readConfig` collapsed every
  failure mode (missing file, EACCES, parse error) into the same
  empty-config return value, so an unreadable `config.json` (commonly
  caused by `docker exec ... node scripts/invite.js` writing the file
  as root while the server runs as UID 1001) was indistinguishable
  from legitimate first-run state and surfaced as "this invite link
  is invalid or expired" with no log line. Now ENOENT is the only
  silent path; other read or parse errors log the path + errno to
  stderr and rethrow. `_writeConfig` errors include the path for the
  same symmetry, and `scripts/invite.js` warns to stderr after a
  successful write if the resulting file's uid/gid does not match the
  current process. Fixes #301.
- **Guard `manifests.writeData` against malformed `data` writes.** A
  card's `data` block could be persisted as a JSON-encoded string
  (`"data": "{...}"` instead of `"data": {...}`) when an upstream
  caller double-serialised before write, breaking renderers. The
  registry now coerces a string `data` value: it parses once, accepts
  the result if it's a structured object/array (with a console warn
  naming the manifest), and throws otherwise. When a manifest declares
  a top-level `schema.type`, the runtime shape of the new value is
  also checked against it before any disk write. The HTTP boundary
  (`POST /api/manifests/:id/data`) returns 400 instead of silently
  rescuing string `data`. Fixes #342.
- **Modal prompt fires for hidden donor surfaced by a visible combo
  card.** The #316 carve-out ("a hidden atomic card surfaced by a
  visible combination card still prompts") worked in the unit-test
  path but was undone in the live app: `checkPromptsForToday`
  fetched data only for prompt candidates, then handed that slim
  list to `buildPromptQueue`, whose internal `surfaced` recompute
  no longer saw the combo card. `buildPromptQueue` now accepts a
  pre-computed `surfaced` set, and the network wrapper passes one
  derived from the full manifest list. Fixes #338.
- **`generic-card` renders every entry per day when
  `maxReadingsPerDay > 1`.** The save path already capped multiple
  rows correctly, but the display path returned the first matching
  row only and the UI offered a single edit/add affordance, so cards
  intended as event logs (stool, BMs, BP across the day) silently lost
  earlier entries from view. Cards with `maxReadingsPerDay > 1` now
  render every row dated the current day as its own list line, sorted
  by `time` if present, with per-row edit + delete and a separate
  ➕ Add control. `fallbackToLatest` is suppressed in this mode (showing
  yesterday's *list* on Today is more confusing than helpful). The
  default `maxReadingsPerDay: 1` path is unchanged. Fixes #336.
- **Chat-agent system prompt steers event logs at `generic-card`, not
  `list-card`.** The renderer summary previously described `list-card`
  as a "persistent chronological list of entries; data is `[{date,
  ...}]`", which was wrong on both counts (`list-card` is a permanent
  roster, rows do not carry a `date`). The agent therefore reached for
  `list-card` whenever the user asked for any kind of repeated log,
  and the resulting card showed every row on every day with no
  per-date scoping. The renderer summary now matches the actual
  contract and explicitly points event-style multi-entry logs at
  `generic-card` with `maxReadingsPerDay`. Fixes #334.
- **`list-card` honours the declared input type on the primary field.**
  In edit mode the primary field was hardcoded to `<input type="text">`
  regardless of what `writeable.inputs[primary].type` declared, so a
  card with a `select` primary rendered as an empty text box. The
  primary now dispatches on `type` (text, select, time, date, number,
  textarea), and view mode resolves `{value, label}` option labels
  before display. Existing list-cards (text primaries) are unchanged.
  Fixes #332.
- **"New chat" button now aborts the in-flight reply.** Clicking the
  📝 button while a chat reply was still on the wire cleared the
  message list but left the textarea disabled until the server eventually
  responded (and the reply was discarded into the empty chat). The button
  now aborts the `/api/chat` fetch, drops the loading state immediately
  so the textarea re-enables, suppresses the spurious "Request timed
  out" error in the freshly-cleared chat, and refocuses the input on
  desktop. Fixes #325.
- **`no-personal-refs` test honours gitignore.** The scanner walked
  the working tree directly and so flagged operator-private files
  that exist on disk but never ship (`BRIEF-FOR-CC.md`, `CLAUDE.md`,
  `.claude/`, `data/sessions/*.json`). CI was unaffected (clean
  checkout) but local `npm test` was noisy with up to 17 spurious
  hits, conditioning developers to ignore the scanner. The scanner
  now drives off `git ls-files`, so it only sees what actually
  ships. Real residue in tracked files still fails the test.
  Fixes #330.
- **Chat client no longer times out on slow multi-iter turns.** The
  chat widget aborted at 120s while the server-side tool-calling loop
  could legitimately take longer (a single gateway hop is capped at
  180s, and a turn can chain several). The client default now matches
  the other long-poll routes at 600s, and both call sites use that
  default. The matching nginx ceiling on `/api/chat` is raised
  separately at the operator level. Fixes #323.
- **Hidden donor cards keep their daily prompts when surfaced through
  a combination card.** The prompt queue used to skip any card with
  `meta.enabled: false`, even when the user had hidden the atomic card
  only because it was rolled into a visible combination card. Now the
  queue checks whether at least one visible combination card lists the
  donor in its `meta.view.combines[].sourceId`; if so, the donor's
  prompt fires as before. Hidden cards with no combo references stay
  suppressed. Fixes #316.
- **Voice ASR works on iOS Safari again.** `MediaRecorder` on iOS only
  produces fragmented MP4, whose `moov` atom sits at the end of the
  stream. The transcode helper was piping bytes into `ffmpeg -i pipe:0`,
  which can't seek backward, so the demuxer rejected the input with
  `Invalid data found when processing input` and the `/api/voice/asr`
  endpoint returned 500. The helper now stages input in a tempfile
  before invoking ffmpeg, restoring seek and unblocking iOS recordings.
  Same helper is used by the inbox audio extractor, so that path
  benefits too. Fixes #319.
- **List-card row detail form no longer crashes in edit mode.** On a
  list-card with secondary fields, tapping the per-row `…` button after
  pressing the pencil to enter edit mode replaced the card with
  `Render failed: Can't find variable: display`. `_renderEditMode` was
  passing a `display` identifier to the inline `eh-input-form` that was
  only defined in `renderCard` / `_renderViewMode`. The variable is now
  threaded through to edit mode the same way it is to view mode.
  Fixes #317.
- **Voice replies no longer read markdown syntax aloud.** The
  voice-mode chat agent is told to put plain prose in `speak`, but
  occasionally leaks bold/italic, links, or inline code through. Fish
  Audio then read the syntax verbatim ("asterisk asterisk bold
  asterisk asterisk"). The TTS endpoint now sanitises text before it
  reaches Fish: bold/italic/strike, inline + fenced code, markdown
  links (`[label](url)` keeps the label), bare URLs, bare square
  brackets, and leading line markers (`#`, `>`, `-`, `*`, `+`,
  `1.`) are all stripped. Parentheses are left alone so prose like
  "your weight (in kg) trended down" still reads naturally. Fixes #314.
- **PWA / apple-touch-icon home-screen artwork.** The five
  `public/icons/icon-*.png` tiles still showed the legacy "Eddz"
  wordmark and rocket image, so adding Klebb to the iOS home screen
  produced a bookmark with the old branding. They have been
  regenerated from `logo-dark.png` with the dog-head mark centred on
  the brand-dark `#0f0f1a` tile (no wordmark; iOS already prints the
  bookmark label beneath the tile). A new
  `scripts/regen-pwa-icons.py` makes the generation reproducible from
  the source logo. Note: iOS caches apple-touch-icons per-bookmark,
  so existing home-screen shortcuts must be removed and re-added
  after deploy. Fixes #305, #307.
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

[Unreleased]: https://github.com/Aristocles/klebb/compare/v3.3.0...HEAD
[3.3.0]: https://github.com/Aristocles/klebb/compare/v3.2.0...v3.3.0
[2.0.0]: https://github.com/Aristocles/klebb/releases/tag/v2.0.0
