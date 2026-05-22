# Reports: ingesting PDFs, scans, notes, and audio

Klebb watches `$HEALTH_HOME/inbox/` and turns anything you drop in
there into a markdown report under `$HEALTH_HOME/reports/`. The chat
agent picks up new reports automatically and can pull the full text
into a conversation on demand.

This is the workflow for getting blood panels, scan reports, hand
notes, voice memos, and similar artefacts into Klebb so you can ask
about them.

---

## 1. The flow at a glance

```
$HEALTH_HOME/
├── inbox/                # drop files here
│   └── _failed/          # things the pipeline could not extract
└── reports/              # extracted markdown lives here
    └── _archive/         # originals filed away after extraction
```

1. Drop a file into `$HEALTH_HOME/inbox/` (SSH, rsync, SCP, `docker
   cp`, syncthing: whatever you already use).
2. Klebb extracts the text using infra binaries (no LLM at ingest)
   and writes a deterministic `<YYYY-MM-DD>-<stem>.md` into
   `$HEALTH_HOME/reports/`.
3. The original file is moved into `$HEALTH_HOME/reports/_archive/`.
4. The chat agent's system prompt is regenerated on its next turn
   with the new report listed under `## Available reports`. Ask it
   anything about the file and it'll call its `read_report` tool to
   fetch the body.

The Reports view in the webapp shows the new `.md` file alongside any
hand-authored markdown you've put in `$HEALTH_HOME/reports/` directly.

---

## 2. Supported file types

| Extension | Extractor | Requires |
|-----------|-----------|----------|
| `.pdf` | `pdftotext -layout` | `poppler-utils` |
| `.png`, `.jpg`, `.jpeg` | `tesseract <abs> stdout -l eng` | `tesseract-ocr`, `tesseract-ocr-eng` |
| `.txt`, `.md` | `fs.readFile` | nothing |
| `.mp3`, `.wav`, `.m4a`, `.ogg`, `.opus` | `ffmpeg` -> Fish ASR | `ffmpeg`, `FISH_AUDIO_API_KEY` |

The Docker image ships with all four binaries baked in, so containerised
deploys work out of the box. Bare-metal deploys need to install the
packages themselves (see [DEPLOY.md](DEPLOY.md)).

Audio ingest reuses the same Fish ASR pipeline that powers voice chat,
so `FISH_AUDIO_API_KEY` is the only extra config you need. See
[VOICE.md](VOICE.md) for setup.

Anything else (`.docx`, `.zip`, `.heic`, etc.) is rejected and lands
in `inbox/_failed/`. The list is intentionally tight: the pipeline is
about predictable, auditable extraction, not a docx-to-markdown
adventure.

---

## 3. Output format

Every ingested report is a markdown file with YAML frontmatter:

```
---
klebb_ingest: v1
source_file: bloods-april-fast.pdf
source_format: pdf
ingested_at: 2026-05-22T14:07:33Z
archive_path: reports/_archive/bloods-april-fast.pdf
---

# 2026-05-22-bloods-april-fast

<raw extractor output, verbatim>
```

The `klebb_ingest: v1` sentinel is what marks a file as machine-ingested
versus hand-authored; the chat catalogue uses it to label entries
appropriately. The body is whatever the extractor returned, untouched.
Klebb does not summarise, restructure, or "clean up" the text at ingest
time; comprehension happens at chat time, where you can challenge the
answer in the same turn.

The output filename is `<YYYY-MM-DD>-<sanitised-stem>.md`, where the
date is taken from the ingest timestamp (UTC) and the stem is the
original filename with non-`[a-z0-9._-]` characters collapsed to dashes.
Collisions get `-2`, `-3`, ... appended.

---

## 4. The chat round-trip

Once a report is ingested, the next chat turn includes a block like
this in the system prompt:

```
## Available reports

The user has reports available in Klebb. Call `read_report(name)` to
fetch the full text of any of them. ...

- `2026-05-22-bloods-april-fast` (pdf, ingested 2026-05-22, source: bloods-april-fast.pdf)
- `2026-04-12-mri-knee-report` (pdf, ingested 2026-04-12, source: mri-knee-report.pdf)
```

You don't need to mention the report by its ingested name. Anything
like *"summarise my latest blood panel"* or *"what did the MRI say
about the meniscus?"* is enough; the agent picks the right report
from the catalogue and calls `read_report` to fetch the body.

Reports are capped at 200 KB on read (same as `read_doc`); long
extractions are truncated and the response includes `truncated: true`
so the agent knows.

---

## 5. Failure handling

Anything that throws inside the pipeline ends up in
`$HEALTH_HOME/inbox/_failed/`:

```
$HEALTH_HOME/inbox/_failed/
├── evil.docx           # the original
└── evil.docx.error     # ISO timestamp + error.message + truncated stderr
```

Common reasons:

- **Unsupported format.** `evil.docx`, `report.heic`, etc. The error
  reads `unsupported format: .docx`.
- **Audio without a Fish key.** Audio ingest requires
  `FISH_AUDIO_API_KEY`. Drops without it land in `_failed/` with
  `audio ingest disabled: FISH_AUDIO_API_KEY not set`. Set the key
  (same one as voice chat) and rename the file out of `_failed/` to
  retry.
- **Binary not on PATH.** If `pdftotext` or `tesseract` is missing,
  the spawn fails. Install the package and rename the file out to
  retry. Containerised deploys never hit this.
- **File never stabilises.** Klebb waits up to 3s for `mtime` + `size`
  to stop changing before extracting (so it doesn't race rsync
  mid-copy). Files still being written after 3s are punted to
  `_failed/` with `file mtime never stabilised`. Re-drop a complete
  copy.

To retry a failure, fix the root cause then `mv inbox/_failed/foo.pdf
inbox/foo.pdf`. The watcher picks the new mtime up immediately.

If your inbox is jammed and nothing is moving, check the server log
for `[ingest]` lines: every processed file leaves a trace, and watcher
init failures are logged at boot.

---

## 6. Operational notes

- **Crash resilience.** If the server crashes mid-extraction, the
  source stays in `inbox/`. On the next boot, the pipeline drains the
  inbox before attaching `fs.watch`, so leftover files get processed.
- **Hand-authored reports still work.** Anything you write directly
  into `$HEALTH_HOME/reports/foo.md` shows up in the Reports view and
  in the chat catalogue. The `klebb_ingest: v1` sentinel just lets
  the catalogue label machine-ingested entries with their source
  format and ingest date; hand-authored files appear with no metadata.
- **The archive is invisible to the UI.** `$HEALTH_HOME/reports/_archive/`
  is reserved on the server side; only the top level of `reports/` is
  scanned for the Reports view and the chat catalogue, so originals
  don't pollute either surface.
- **Privacy.** Inbox files are processed locally except for audio,
  which is shipped to Fish Audio for transcription (same hop voice
  chat uses). PDF, image, and text extraction never leaves the box.

---

## 7. What's NOT included

- **No upload UI in the webapp.** Files arrive via SSH/rsync/SCP/`docker
  cp`. A future browser-side drop zone could land on top of this
  pipeline; today the pipeline is the contract.
- **No LLM polish at ingest.** Output is whatever the extractor returned.
  This is deliberate: medical numbers and dates need to round-trip
  exactly. A future flag (`KLEBB_INGEST_STRUCTURE=1` or similar) could
  add a structuring pass behind it without changing the on-disk format.
- **No deduplication.** Drop the same PDF twice and you'll get two
  reports (`-2` suffix on the second). Delete one if you want to
  collapse.
- **No per-report metadata UI.** Tags, notes, "this report supersedes
  that one": none of that. The chat agent reasons over filenames and
  bodies.
