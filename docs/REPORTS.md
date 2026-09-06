# Reports: uploading documents and how Klebb reads them

Upload a health document from your browser and Klebb turns it into a report:
a titled card with a short summary, available to the chat agent, with the
original kept alongside it.

Blood panels, scan reports, doctors' letters, DNA results, lab csv exports,
hand notes, voice memos. Anything you would otherwise squint at in a PDF
viewer and then try to remember.

---

## 1. The flow at a glance

```
$HEALTH_HOME/
├── inbox/                # transient: a file lives here for seconds
│   └── _failed/          # things the pipeline could not read
└── reports/              # the reports themselves
    └── _archive/         # the original files, kept
```

1. **Upload** from the Reports page. One or more files; each goes up on its
   own request.
2. **Extract.** Digital PDFs, Word documents, text and csv are read locally
   and deterministically: their extraction is exact. Photos and scans are
   read by a **vision-capable model through your chat gateway** when one is
   configured (`KLEBB_OCR_MODE=auto`, the default), because it reads a phone
   photo, a fax-quality scan or handwriting far better than local OCR ever
   will. Tesseract remains the reader when no gateway is configured, when
   the gateway is unavailable, or when you set `KLEBB_OCR_MODE=local`; when
   the model does the reading, tesseract also runs as a local **witness**
   whose job is to corroborate the numbers. Audio goes to ffmpeg plus speech
   recognition, as before.
3. **Comprehend**: one call to your configured chat gateway turns the extracted
   text into a title, the date on the document, up to five bullets, and a body
   with your own identifying details removed. This runs in the background; the
   upload has already returned.
4. **Verify**, for photos and scans only, whichever reader produced the text.
   OCR misreads a digit into garbage; a vision model misreads it into
   something plausible. Both are exactly what the human check exists to
   catch, so you compare against the original before the chat agent is
   allowed to use it.

The original file moves to `reports/_archive/` and stays there, because
re-reading a document later needs it.

---

## 2. Supported file types

| Extension | How it is read | Needs |
|-----------|----------------|-------|
| `.pdf` (digital) | `pdftotext -layout` | `poppler-utils` |
| `.pdf` (scanned) | `pdftoppm` renders the pages; the gateway vision model reads them (tesseract fallback + witness) | `poppler-utils`; `tesseract-ocr` for fallback/witness |
| `.png`, `.jpg`, `.jpeg` | the gateway vision model (tesseract fallback + witness) | `ffmpeg` to downscale large photos; `tesseract-ocr`, `tesseract-ocr-eng` for fallback/witness |
| `.docx` | built-in reader (no dependency) | nothing |
| `.txt`, `.md`, `.csv` | read verbatim | nothing |
| `.mp3`, `.wav`, `.m4a`, `.ogg`, `.opus` | `ffmpeg` then speech recognition | `ffmpeg`, `FISH_AUDIO_API_KEY` |

With `KLEBB_OCR_MODE=local` (or no chat gateway configured) the photo and
scan rows read "tesseract OCR", exactly as they always did.

The Docker image ships every binary, so containerised deploys work out of the
box. Bare-metal deploys install the packages themselves; see
[DEPLOY.md](DEPLOY.md).

Anything else is refused at upload with a message naming the extension, and
never reaches disk. `.doc` (pre-2007 Word) is a different format entirely and
is not supported; re-save it as `.docx`.

**Scanned PDFs** are detected rather than declared: if a PDF's text layer is
too sparse to be real content, the pages are rendered and read as images
instead, and the report records `source_format: pdf-ocr`. Capped at 20 pages,
and if a document is longer the report says so rather than letting you believe
you have the whole thing.

**What the model is sent.** Never the original file. Pages are rendered and
downscaled to roughly 1568 px on the long edge first (anything larger is
discarded by the model anyway), one page per request. A page that fails or
comes back truncated fails the whole document over to tesseract: a report is
never silently half one reader, half the other. A gateway model that turns
out not to accept images at all is remembered until the next restart, so it
costs one failed call, not one per upload.

Limits: 30 MB per file, and 20 reports per instance by default (see
`KLEBB_REPORTS_MAX` below).

---

## 3. Report states

A report's badge tells you where it stands.

| State | Meaning |
|-------|---------|
| **processing** | uploaded, being read. Usually a few seconds; a multi-page scan takes longer. |
| **needs checking** | read from a photo or scan, by the vision model or by OCR. Chat cannot use it until you confirm the text. |
| **ready** | summarised and available to chat. |
| **not summarised** (`raw`) | the text was extracted fine, but the summary could not be produced. The report is complete and readable; it just has no bullets. The reason is shown. |
| **not health** (`rejected`) | the document had no health content (a receipt, a payslip). Kept visible so you can see what it was and delete it. |
| **failed** | could not be read at all. The reason is shown on the card. |

`raw` happens when the chat gateway is unreachable, returns something
unparseable, or when the numeric-fidelity check below rejects the summary. It
is a degradation, never a loss: the extracted text is always the report body.

### The numeric-fidelity check

Every number in a generated body is checked against the extracted text. If the
summary contains a figure that is not in the source, the summary is retried
once and then discarded: the report is published as `raw` with the raw text as
its body and the offending number named in the reason.

This is deliberately strict. A language model rewriting a blood panel is the
one failure in this feature with real consequences, and a report with no
summary is much better than a report with a wrong number in it. Formatting
differences do not trip it (`1,234` and `1234` match; `7.0` and `7` match), and
bullets are exempt because they are interpretation and may legitimately contain
a derived figure ("down 32 since March").

---

## 4. Verifying a photo or scan

Tap a report that needs checking, then **Check the text**. The text gets the
full width; **Open the original** puts the source document in its own tab
with the browser's zoom and rotate. Compare the numbers.

When the vision model did the reading, tesseract reads the same document as
an independent local witness, and any number the witness could not see is
**highlighted** in the text. Those are the values most likely to be wrong, so
give them the closest look; a note above the text says whether the witness
ran, corroborated everything, or could not run at all (in which case every
value is on you).

- **Looks right** marks it verified. The badge clears and chat can use it.
- **Retry** re-reads the document one rung down a ladder: the vision model
  first if it has not produced this text yet, then tesseract's page-layout
  modes, which suit different documents (a lab table often reads better on
  the second setting). The button names what the next attempt will use, and
  each retry re-arms verification, since the text has changed. A document
  first read by tesseract because the gateway happened to be down can be
  retried with the vision model once it is back.

Until you verify, the chat agent is told the report exists and that its content
is withheld. Ask about it and you are told it needs checking; you will not get
an answer drawn from unchecked text. That refusal is enforced in the tool the
agent calls, not merely requested in its instructions. The gate applies to
vision reads exactly as it does to OCR: a vision misread looks plausible
rather than garbled, which makes the human check more important, not less.

Text, markdown, csv, Word documents and digital PDFs never need verification:
their extraction is exact, so there is nothing to compare against. Audio is not
gated either, though speech recognition does mangle medical terms, so treat a
voice memo as a note rather than a record.

---

## 5. Managing reports

- **Reprocess** re-reads the archived original and regenerates the summary,
  overwriting the same report. Useful after a bad OCR pass, or once a gateway
  that was down comes back.
- **Delete** removes the report and its archived original, freeing a slot.
- **View full report** opens the whole text.

Reports you wrote by hand (any `.md` you put in `$HEALTH_HOME/reports/`
yourself) appear in the list and in chat with their full content, are never
gated, and do not count against the cap. Klebb will not delete or reprocess
them either: they are yours, not the app's.

### `KLEBB_REPORTS_MAX`

How many uploaded reports an instance holds. Defaults to 20.

This is a cost and context limit rather than a disk one: every report is one
gateway call when it arrives, and one entry in the chat agent's prompt on every
turn thereafter. Self-hosters with their own gateway can raise it:

```
KLEBB_REPORTS_MAX=100
```

At the cap, uploads are refused with a message naming the limit, and the
Reports page shows how many slots are used before you pick a file. Existing
reports keep working; nothing is deleted to make room. An instance that somehow
sits above its cap stays fully functional and simply accepts no new uploads.

### `KLEBB_OCR_MODE`

How photos and scans are read. Defaults to `auto`.

```
KLEBB_OCR_MODE=auto    # vision model via the chat gateway; tesseract as
                       # fallback and witness (the default)
KLEBB_OCR_MODE=local   # tesseract only; page images never leave the box
```

`auto` with no gateway configured behaves exactly like `local`. The setting
only affects how photos and scans are *read*; comprehension (the summary
pass) uses the gateway in both modes, as it always has.

---

## 6. What the chat agent sees

Every turn, the system prompt carries a catalogue of your reports, newest
first, each with its title, document date, and bullets:

```
## Available reports

- `2026-07-02-thyroid` — Thyroid panel, Melbourne Pathology (pdf, dated 2026-07-02)
    - TSH 2.1 mIU/L, within the 0.4-4.0 range
    - Free T4 14 pmol/L, mid-range
- `2026-03-12-bloods` — Full blood count (image, dated 2026-03-12)
    content withheld pending OCR verification; tell the user to check it in Reports
```

Ordering is by the date **on the document**, not the upload date, so a 2019
result uploaded today does not outrank last month's.

You do not need to name a report. "What did my last blood test say about
ferritin?" is enough: the agent picks it from the catalogue and calls its
`read_report` tool for the full text. It is told to read the document before
quoting any figure, since the catalogue holds summaries rather than documents.

The block is capped so it cannot grow without bound; past the cap the oldest
entries are dropped and the agent is told how many were left out.

---

## 7. Privacy: what leaves the box

Stated plainly, because it matters more here than anywhere else in Klebb.

- **Exact formats are read locally.** Digital PDFs, Word documents, text and
  csv are extracted entirely on your own machine.
- **Photos and scans go to your chat gateway by default.** In `auto` mode
  (the default, when a gateway is configured), downscaled page images of a
  photo or scan are sent to whatever `CHAT_ENDPOINT_URL` points at, once, to
  be read. The images carry everything on the page, identifiers included.
  Set `KLEBB_OCR_MODE=local` and extraction stays fully on-box (tesseract
  only), at the cost of much worse reading on photos and no handwriting at
  all. The witness pass is always local; it sends nothing anywhere.
- **Audio is remote too.** Speech recognition ships the audio to the
  configured provider, the same hop voice chat uses. See [VOICE.md](VOICE.md).
- **Comprehension sends the extracted text to your chat gateway, once**, when
  the report is created. Whatever endpoint `CHAT_ENDPOINT_URL` points at sees
  the document's text on that one call, whichever reader produced it. If none
  of that is acceptable for a given document, do not upload it: there is no
  local-only summarisation mode.
- **The processed report has your identifiers removed**: name, date of birth,
  address, phone, email, and Medicare, patient or accession numbers. Since the
  processed report is what goes into every subsequent chat turn, those details
  are not in the context the agent works from.
- **Clinicians and organisations are kept.** The requesting doctor, the
  reporting pathologist, the practice and the lab stay as written: they are
  useful context, and it is your own identity that is sensitive here.
- **The archived original keeps everything.** It has to: verifying OCR means
  comparing against the real document, and reprocessing means re-reading it.
  It lives at `$HEALTH_HOME/reports/_archive/`, is served only to an
  authenticated session, and is never cached by the browser.
- **A `raw` report is unscrubbed.** When comprehension fails, the body is the
  raw extracted text, identifiers included. Worth knowing if your gateway is
  down and you upload something sensitive.

---

## 8. Failure handling

A file the pipeline cannot read lands in `$HEALTH_HOME/inbox/_failed/` with a
sibling `.error` file, and shows on the Reports page as **failed** with its
reason, so a failure is visible in the app rather than only in a server log.

Common causes:

- **Audio without a key.** Audio needs `FISH_AUDIO_API_KEY`, the same key voice
  chat uses.
- **A binary missing.** Bare-metal deploys without `poppler-utils` or
  `tesseract-ocr`. Containerised deploys never hit this. A photo upload with
  no gateway AND no tesseract has nothing left to read it; the failure names
  both.
- **A corrupt or password-protected document.**

To retry, delete the report and upload the file again.

**The operator door.** A file placed directly into `$HEALTH_HOME/inbox/` (by
`docker cp`, or on the host filesystem) is picked up on the next restart. This
is the same pipeline and the same cap, and it exists for bulk seeding and for
recovering after a crash mid-read, not as a second ingest path. Files over the
cap go to `_failed/` with a message saying so.

---

## 9. On disk

An uploaded report is markdown with a frontmatter header:

```
---
klebb_ingest: v2
source_file: bloods-april.pdf
source_format: pdf-ocr
ingested_at: 2026-08-09T14:07:33Z
archive_path: reports/_archive/bloods-april.pdf
status: ready
verify: required
title: Full blood count, Melbourne Pathology
document_date: 2026-03-12
relevance: health
read_by: vision
ocr_attempts: vision
unwitnessed: 88
bullets:
  - Ferritin 88 ug/L, low end of the 30-300 range
  - Haemoglobin 147 g/L, within range
---

# Full blood count, Melbourne Pathology

<the processed text>
```

The reader-provenance fields exist only for photos and scans: `read_by` names
which reader produced the text, `ocr_attempts` is the retry ladder's memory
of the rungs that have already produced text, and `unwitnessed` lists the
numbers the local witness could not corroborate (`none` when it corroborated
everything; the line is absent when no witness could run). A tesseract read
records `ocr_psm`, its page-segmentation setting, as it always has.

The header is the source of truth for a report's state; there is no database
table. `klebb_ingest` marks the file as app-managed rather than hand-authored.

Reports written by earlier versions carry `klebb_ingest: v1` and no digest
fields. They keep working exactly as they did, are never rewritten, and read as
`ready` and needing no verification, which is what they have always been. There
is no migration to run.

Filenames are `<YYYY-MM-DD>-<stem>.md`, dated by upload, with `-2`, `-3`
appended on collision.

---

## 10. What is NOT included

- **Correcting text in the app.** If a read is slightly off, the options today
  are Retry (another rung on the reader ladder) or delete and re-photograph.
  Editing the text in place, and re-summarising from the corrected version, is
  the obvious next step and is not built yet; it matters more now that a
  vision read gets a document to 99% right.
- **Deduplication.** Upload the same document twice and you get two reports.
- **`.doc` and `.heic`.** Pre-2007 Word needs a different parser; iPhone's HEIC
  needs a decoder in the image. Re-save as `.docx`, and set the iPhone camera to
  "Most Compatible" to get JPEGs.
- **Tiling a dense page.** Pages are read whole at ~1568 px on the long edge.
  A page whose print is too small at that size would need cutting into tiles
  and reading in pieces, which risks slicing table rows in half; not built.
- **Report supersession.** "These bloods replace those" is inferred from
  document dates and nothing else.
- **Very large documents.** Text sent for comprehension is capped at 100 KB, so
  a whole-genome export is truncated for the summary, though the full extracted
  text is kept.
