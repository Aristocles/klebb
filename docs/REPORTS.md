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
2. **Extract**, locally and deterministically: poppler for PDFs, tesseract for
   photos and scans, a built-in reader for Word documents, ffmpeg plus speech
   recognition for audio. No model involved at this step.
3. **Comprehend**: one call to your configured chat gateway turns the extracted
   text into a title, the date on the document, up to five bullets, and a body
   with your own identifying details removed. This runs in the background; the
   upload has already returned.
4. **Verify**, for photos and scans only. Their text came from OCR, which can
   misread a digit, so you check it against the original before the chat agent
   is allowed to use it.

The original file moves to `reports/_archive/` and stays there, because
re-reading a document later needs it.

---

## 2. Supported file types

| Extension | How it is read | Needs |
|-----------|----------------|-------|
| `.pdf` (digital) | `pdftotext -layout` | `poppler-utils` |
| `.pdf` (scanned) | `pdftoppm` renders the pages, then tesseract reads them | `poppler-utils`, `tesseract-ocr` |
| `.png`, `.jpg`, `.jpeg` | tesseract OCR | `tesseract-ocr`, `tesseract-ocr-eng` |
| `.docx` | built-in reader (no dependency) | nothing |
| `.txt`, `.md`, `.csv` | read verbatim | nothing |
| `.mp3`, `.wav`, `.m4a`, `.ogg`, `.opus` | `ffmpeg` then speech recognition | `ffmpeg`, `FISH_AUDIO_API_KEY` |

The Docker image ships every binary, so containerised deploys work out of the
box. Bare-metal deploys install the packages themselves; see
[DEPLOY.md](DEPLOY.md).

Anything else is refused at upload with a message naming the extension, and
never reaches disk. `.doc` (pre-2007 Word) is a different format entirely and
is not supported; re-save it as `.docx`.

**Scanned PDFs** are detected rather than declared: if a PDF's text layer is
too sparse to be real content, the pages are rendered at 300 dpi and OCRed
instead, and the report records `source_format: pdf-ocr`. Capped at 20 pages,
and if a document is longer the report says so rather than letting you believe
you have the whole thing.

Limits: 30 MB per file, and 20 reports per instance by default (see
`KLEBB_REPORTS_MAX` below).

---

## 3. Report states

A report's badge tells you where it stands.

| State | Meaning |
|-------|---------|
| **processing** | uploaded, being read. Usually a second or two; a multi-page scan takes longer. |
| **needs checking** | read by OCR from a photo or scan. Chat cannot use it until you confirm the text. |
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

Tap a report that needs checking, then **Check the text**.

You get the original document beside the text that was read out of it: side by
side on a wide screen, two tabs on a phone. Compare the numbers.

- **Looks right** marks it verified. The badge clears and chat can use it.
- **Retry reading it** runs OCR again with different settings. Tesseract has
  several page-layout modes and the best one depends on the document; a lab
  table often reads better on the second attempt than the first. Each retry
  advances one setting and re-arms verification, since the text has changed.

Until you verify, the chat agent is told the report exists and that its content
is withheld. Ask about it and you are told it needs checking; you will not get
an answer drawn from unchecked OCR text. That refusal is enforced in the tool
the agent calls, not merely requested in its instructions.

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

- **Extraction is local.** PDFs, photos, scans, Word documents, text and csv are
  read entirely on your own machine. Nothing is sent anywhere.
- **Audio is not.** Speech recognition ships the audio to the configured
  provider, the same hop voice chat uses. See [VOICE.md](VOICE.md).
- **Comprehension sends the extracted text to your chat gateway, once**, when
  the report is created. Whatever endpoint `CHAT_ENDPOINT_URL` points at sees
  the document's text on that one call. If that is not acceptable for a given
  document, do not upload it: there is no local-only summarisation mode.
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
  `tesseract-ocr`. Containerised deploys never hit this.
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
source_format: pdf
ingested_at: 2026-08-09T14:07:33Z
archive_path: reports/_archive/bloods-april.pdf
status: ready
verify: not_required
title: Full blood count, Melbourne Pathology
document_date: 2026-03-12
relevance: health
bullets:
  - Ferritin 88 ug/L, low end of the 30-300 range
  - Haemoglobin 147 g/L, within range
---

# Full blood count, Melbourne Pathology

<the processed text>
```

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

- **Correcting OCR text in the app.** If a photo reads badly, the options today
  are Retry (a different OCR setting) or delete and re-photograph. Editing the
  text in place, and re-summarising from the corrected version, is the obvious
  next step and is not built yet.
- **Deduplication.** Upload the same document twice and you get two reports.
- **`.doc` and `.heic`.** Pre-2007 Word needs a different parser; iPhone's HEIC
  needs a decoder in the image. Re-save as `.docx`, and set the iPhone camera to
  "Most Compatible" to get JPEGs.
- **Vision-model OCR.** Tesseract only. A vision model would read a bad photo
  far better, and would also silently invent plausible numbers, which is the
  exact failure this feature is built to avoid.
- **Report supersession.** "These bloods replace those" is inferred from
  document dates and nothing else.
- **Very large documents.** Text sent for comprehension is capped at 100 KB, so
  a whole-genome export is truncated for the summary, though the full extracted
  text is kept.
