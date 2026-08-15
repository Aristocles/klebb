# Health Auto Export — iPhone health data into klebb

Klebb can receive a webhook push from the iPhone
[Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567069)
app. Each push stores every sample it carries, then dispatches the
parsed metric data to whichever manifests subscribe to it via
`meta.ingest`.

This page tells you how to set it up, what metrics are supported, and
how to author your own HAE-backed cards.

---

## How it works

Klebb ships a **catalogue** of supported Apple Health metrics in
`health-auto-export/catalogue.js`. Each catalogue entry knows how to
turn an HAE payload entry into a normalised row and how to aggregate
multiple rows for the same date.

A card receives HAE data by subscribing to a catalogue metric from its
manifest:

```json
"meta": {
  "id": "sleep",
  "label": "Sleep",
  "emoji": "😴",
  "ingest": { "source": "hae", "metric": "sleep_analysis" },
  "view": {
    "enabled": true,
    "component": "generic-card",
    "display": { "template": "{hours:round(1)}", "unit": "hrs" }
  },
  "writeable": { "fromWebapp": false }
}
```

On every push, the dispatcher finds every manifest whose
`meta.ingest.source === "hae"`, shapes the corresponding payload slice
using the catalogue, and upserts the rows by date into that manifest's
`data[]`. Any number of manifests can subscribe to the same metric.

### Where the history is kept

Every sample in a push is stored in the instance's SQLite datastore
(`$HEALTH_HOME/db/klebb.db`), deduplicated by content. This matters
because HAE re-sends a rolling window rather than a delta: the same
sample arrives in push after push. Storing each unique sample once
keeps months of history in a few megabytes instead of hundreds.

Two consequences worth knowing:

- The datastore is part of every backup and export path, so the
  history travels with the instance. `scripts/export-embed.js` writes
  it to `data/auto-export/samples.json` in the exported tree, and a
  fresh instance imports that file on first boot.
- Deduplication is on the **full content** of a sample, not on
  `metric + timestamp`. Apple Health legitimately emits several
  distinct samples at the same minute from the same device, and all
  of them are kept.

A payload that is not valid JSON has no samples to store, so its raw
bytes are kept instead, at
`$HEALTH_HOME/data/auto-export/unparsed/<stamp>.json`. Only the most
recent few are retained; the endpoint still answers `200` so the
phone does not retry-loop, and `last-push.json` records the warning.

---

## Supported metrics (day-one catalogue)

| Metric key (use in `meta.ingest.metric`) | Row shape | Aggregation |
|---|---|---|
| `sleep_analysis` | `{ date, hours, asleep?, inBed?, deep?, rem?, core?, awake?, bedTime?, wakeTime?, source? }` | last per date |
| `step_count` | `{ date, count }` | sum per date |
| `apple_exercise_time` | `{ date, minutes }` | sum per date |
| `workouts` (pseudo-metric, reads from `data.workouts[]`) | `{ date, trained, type?, durationMin?, distanceKm?, calories?, avgHr?, maxHr?, elevationM?, startTime?, sessionCount }` | merge per date |
| `heart_rate_variability` | `{ date, ms }` | mean per date |
| `resting_heart_rate` | `{ date, bpm }` | last per date |
| `walking_heart_rate_average` | `{ date, bpm }` | last per date |
| `blood_oxygen_saturation` | `{ date, pct }` | mean per date |
| `mindful_minutes` | `{ date, minutes }` | sum per date |
| `body_mass` | `{ date, kg }` | last per date |
| `body_fat_percentage` | `{ date, pct }` | last per date |
| `blood_pressure_systolic` | `{ date, systolic }` | last per date |
| `blood_pressure_diastolic` | `{ date, diastolic }` | last per date |

`bedTime` and `wakeTime` are the night's local wall-clock `HH:MM`
exactly as the phone sent them, never reinterpreted through the
server's timezone, and `bedTime` can belong to the previous calendar
day: a 22:36 bedtime sits on the row dated the following morning.
`body_mass` reads the payload's declared units and normalises
`lb`/`lbs` and `st`/`stone` to kilograms on ingest, so the row is
always `kg` regardless of the phone's unit preference.

Metrics not in the catalogue are **stored but not ingested**: their
samples go into the datastore like any other, they simply have no
card to shape them into rows yet. A real iPhone pushes roughly
twenty-five metrics and the catalogue covers thirteen, so this is the
normal case rather than an edge one, and it is what makes adding a
metric later a genuine backfill rather than a fresh start.

Adding a new metric is a one-line entry in
`health-auto-export/catalogue.js`; open a feature request if you need
something that's not here. Once it is in the catalogue, creating a
card for it replays the stored samples, including everything that
arrived before the metric was supported.

Blood pressure is two separate entries; combine them with a
combination card if you want them shown together.

---

## Setup

### 1. Generate a token in Settings

Open Klebb in the browser, go to **Settings**, and find the
**Health Auto Export** panel. Click **Generate token**. Klebb mints a
64-char hex secret, persists it to
`$HEALTH_HOME/config.json` under `cfg.hae.token` (atomic write,
`0o600`), and reveals it briefly in the panel so you can copy it
straight to the clipboard.

Without a token the endpoint returns **501**: the feature is off by
default.

You can rotate at any time with the **Regenerate** button. Rotating
invalidates the previous token immediately, so update the iPhone HAE
app's Authorization header before the next push.

### 2. Configure the iPhone app

In Health Auto Export:

1. **Automations** → **Add Automation** → **REST API**.
2. **URL**: `https://<your-klebb-host>/api/health-auto-export`
3. **Method**: `POST`
4. **Headers**:
   ```
   Content-Type: application/json
   Authorization: Bearer <token-from-Settings>
   ```
5. **Metrics**: pick from the table above. Enabling more than you
   subscribe to is harmless — unsubscribed metrics are archived only.
6. **Export format**: JSON.
7. **Frequency**: every 6 hours is a reasonable default. Hourly also
   works; klebb is cheap to hit.

### 3. Create subscriber manifests

Klebb no longer auto-seeds cards on first push. Pick the cards you
want and create them explicitly. The fastest path is the Templates
gallery in Settings — four templates ship for the canonical HAE-backed
cards (`sleep-hours`, `steps`, `active-minutes`, `workouts`).

To hand-author one, drop a file like this into
`$HEALTH_HOME/data/my-hrv.json`:

```json
{
  "$schema": "klebb.datafile.v1",
  "meta": {
    "id": "my-hrv",
    "label": "HRV",
    "emoji": "💓",
    "order": 540,
    "ingest": { "source": "hae", "metric": "heart_rate_variability" },
    "view": {
      "enabled": true,
      "component": "generic-card",
      "display": { "template": "{ms}", "unit": "ms" }
    },
    "trends": {
      "enabled": true,
      "component": "line-chart",
      "field": "ms"
    },
    "writeable": { "fromWebapp": false }
  },
  "description": "Heart rate variability (SDNN) from Apple Watch via HAE.",
  "data": []
}
```

You can also ask klebbius in chat: *"Create a new HAE-backed card for
heart rate variability"* and it will write the file for you.

### 4. Verify

Manually trigger the first push from the HAE app, or wait for the
schedule.

```
$ curl -s https://<your-klebb>/api/manifests/sleep-hours/data | jq '.data[-1]'
{
  "date": "2026-05-04",
  "hours": 7.8,
  "source": "Apple Watch"
}

$ sqlite3 $HEALTH_HOME/db/klebb.db     'SELECT metric, COUNT(*), MIN(sample_date), MAX(sample_date)
       FROM hae_samples GROUP BY metric ORDER BY metric;'
sleep_analysis|142|2026-01-02|2026-05-04
step_count|3891|2026-01-02|2026-05-04
vo2_max|37|2026-01-05|2026-05-03
```

(`sqlite3` is not in the container image; the same figures are in the
migration script's output, and the status endpoint reports the most
recent push.)

If nothing shows up:

- Check klebb's logs for `[hae]` lines.
- Hit the endpoint manually with `curl -X POST -H "Authorization:
  Bearer <token>" -H "Content-Type: application/json" -d
  '{"data":{}}'` — expect `200 {"ok":true,"ingested":{}}`.
- Wrong token → `401`.
- No token configured → `501`.

---

## Response shape

A successful push returns:

```json
{
  "ok": true,
  "ingested": { "sleep-hours": 1, "steps": 1 },
  "availableUnsubscribed": ["heart_rate_variability", "resting_heart_rate"]
}
```

- `ingested` maps manifest id → rows written.
- `availableUnsubscribed` lists metric keys present in the payload that
  no manifest subscribes to. This is how you discover "I could build a
  card for this".

---

## Settings panel

Klebb's Settings view leads with a Health Auto Export panel showing:

- The effective webhook URL (copy to clipboard).
- The token, with **Generate** when none is configured, or a masked
  display (`••••<last 4>`) plus **Copy** and **Regenerate** buttons
  when one is. Regenerate prompts an inline confirmation that warns
  the iPhone HAE app must be updated before the next push will be
  accepted.
- Time and summary of the most recent push, expandable to show the
  full diagnostic (rows per subscriber, unsubscribed metrics seen,
  warnings).

The panel is the first place to look when debugging "is my iPhone
pushing?". The URL shown is derived from the request host and
`X-Forwarded-Proto`, so whatever it shows is what your HAE
automation should be posting to.

---

## Backfill on card create

When you create an HAE-backed manifest — whether via klebbius, a
template, or by dropping a file in `$HEALTH_HOME/data/` — klebb
replays the stored samples for that manifest's metric and populates
`data[]` in one go. So "the iPhone pushed yesterday, I built the
card today" still ends up with yesterday's data visible on the
card, and so does "the iPhone has been pushing this metric for six
months and klebb only started supporting it today".

The replay is per-metric: it only affects the freshly-created
manifest, and only if `data[]` is empty. Creating a card over an
existing manifest that already has data is a no-op.

True historical backfill (multi-year Apple Health export) still
comes from a manual export in the HAE app: set the date range,
tap export, the app POSTs one big push, klebb upserts everything
by date into whichever subscribers exist.

---

## Discovering new metrics

When a push contains metrics that no manifest subscribes to, klebb
records them in `$HEALTH_HOME/data/auto-export/discovered.json`. A
discovery card appears at the top of Today listing the metrics and
offering two actions per row:

- **Build a card** — seeds the chat widget with a prompt asking
  klebbius to create a subscriber manifest for that metric. You
  review, tweak if needed, and send. Once the subscriber exists, the
  discovery is removed on the next push.
- **Dismiss** — permanently hides the metric. Dismissed metrics are
  listed in Settings under "Hidden Apple Health metrics" with an
  un-hide button.

Dismissals persist across pushes: once you dismiss HRV, a re-push
won't resurface it unless you un-hide it first. If you delete a
subscriber card and the metric re-appears in a future push, it
becomes a fresh discovery.

---

## Diagnostics: last-push snapshot

Every push (success, parse failure, or overflow) overwrites
`$HEALTH_HOME/data/auto-export/last-push.json` with a snapshot of
what happened. Shape:

```json
{
  "receivedAt": "2026-05-08T14:22:11.003Z",
  "payloadBytes": 42318,
  "subscribers": [
    { "id": "sleep-hours", "metric": "sleep_analysis", "rowsWritten": 1 },
    { "id": "steps", "metric": "step_count", "rowsWritten": 0,
      "note": "no entries in payload" }
  ],
  "availableUnsubscribed": ["heart_rate_variability"],
  "warnings": []
}
```

This is a single-snapshot diagnostic, not an audit log; the stored
samples are the durable history. The snapshot powers the
authenticated status endpoint:

```
GET /api/health-auto-export/status
```

Returns `{ tokenSet, endpointUrl, lastPush }`. The `endpointUrl` is
computed from the request's host header and `X-Forwarded-Proto` (if
set), so whatever URL the status page reports is the same URL your
iPhone app should be posting to.

The settings view reads from this endpoint to render the HAE panel.

### Body size limit

The webhook accepts payloads up to 100 MB. Historical manual-backfill
pushes from the iPhone app can be in the tens of MB; 100 MB gives
multiple years of headroom. Anything larger is rejected with `413`
and a diagnostic warning.

---

## Migrating an existing install

If you have existing manifests from a klebb version that auto-seeded
the four canonical HAE cards, run the migration script once to add
`meta.ingest` to them:

```bash
node scripts/migrate-hae-ingest.js
# or with an explicit data dir:
node scripts/migrate-hae-ingest.js /path/to/data
# --dry-run shows what would change without writing anything.
```

Takes a timestamped backup (`<file>.pre-hae-<stamp>.json`) before
writing. Idempotent: re-running is a no-op.

---

## Ingest-only writes, manual-entry cards, combination cards

Subscriber manifests typically set `writeable.fromWebapp: false` so the
webapp shows them read-only — input forms and write APIs would fight
the next push.

If you want a card that holds *both* ingested data and manual entries
(e.g. HAE sleep hours alongside a manual sleep-quality rating), don't
try to make one manifest do both. Build it as a combination card:

1. A read-only HAE-backed manifest for the objective metric.
2. A manual-input manifest for the subjective one.
3. A combination card that lists both as donors. The pencil icon only
   appears on the writeable donor.

See `MANIFEST-SCHEMA.md` ("Combination cards") for the CC contract.

---

## Failure modes

| Scenario | Behaviour |
|---|---|
| Manifest subscribes to a metric the payload omits | Logged; manifest untouched |
| Payload contains a metric no manifest subscribes to | Archived; reported in `availableUnsubscribed` |
| All entries for a metric are malformed (no date, non-numeric qty) | Logged; manifest untouched |
| Mixed: some entries valid, some malformed | Valid rows upserted, invalid ones dropped silently |
| `meta.ingest.metric` is not in the catalogue | Manifest loads; warning logged per push |
| Webhook body is not valid JSON | `200 + {warning}`, bytes quarantined under `auto-export/unparsed/` |

The no-op-on-empty invariant means a card's data is only written when
the dispatcher produced at least one row for it. A push that does
nothing writes nothing. Ingested rows land in the embedded datastore
(`$HEALTH_HOME/db/klebb.db`), not the manifest file: a push updates
data without rewriting `meta`, and the manifest file's mtime does not
change. Read a card's ingested rows back over the API
(`GET /api/manifests/<id>/data`), not by opening the manifest file.

---

## Endpoint reference

```
POST /api/health-auto-export
Authorization: Bearer <token-from-Settings>
Content-Type: application/json
```

| Response | Meaning |
|---|---|
| `200 {ok:true, ingested:{...}, availableUnsubscribed:[...]}` | Parsed and dispatched |
| `200 {ok:true, warning:"..."}` | Parse or dispatch failed; the payload is recoverable (samples stored, or bytes quarantined) and HAE will retry |
| `401` | Token missing or wrong |
| `501 {error:"ingest disabled"}` | No token configured (visit Settings → Health Auto Export) |

Errors after auth passes are swallowed into `200 + warning` on
purpose: the iPhone app retries aggressively on non-2xx, and we'd
rather have the payload recoverable than a retry spiral.

---

## Upgrading from older Klebb

Older versions used a `HEALTH_AUTO_EXPORT_TOKEN` env var instead of an
in-app Settings flow. On first boot under the new code:

- If `cfg.hae.token` already exists in `config.json`, nothing changes.
- If it doesn't exist *and* the env var is set, Klebb copies the env
  value into `cfg.hae.token` once and logs a deprecation warning. The
  iPhone app keeps working with the same token.
- After that, the env var is ignored. You can drop the line from your
  `.env` / systemd unit / docker-compose `environment` block at your
  leisure.
