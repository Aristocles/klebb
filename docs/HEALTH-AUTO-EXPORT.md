# Health Auto Export — iPhone health data into klebb

Klebb can receive a webhook push from the iPhone
[Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567069)
app. Each push archives the raw payload, then dispatches the parsed
metric data to whichever manifests subscribe to it via `meta.ingest`.

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

The raw payload is archived unchanged at
`$HEALTH_HOME/data/auto-export/raw/<ms-stamp>.json` regardless of
whether parsing succeeds. Safe to delete if disk space is tight.

---

## Supported metrics (day-one catalogue)

| Metric key (use in `meta.ingest.metric`) | Row shape | Aggregation |
|---|---|---|
| `sleep_analysis` | `{ date, hours, asleep?, inBed?, deep?, rem?, core?, awake?, source? }` | last per date |
| `step_count` | `{ date, count }` | sum per date |
| `apple_exercise_time` | `{ date, minutes }` | sum per date |
| `workouts` (pseudo-metric, reads from `data.workouts[]`) | `{ date, trained, type? }` | any-true per date |
| `heart_rate_variability` | `{ date, ms }` | mean per date |
| `resting_heart_rate` | `{ date, bpm }` | last per date |
| `walking_heart_rate_average` | `{ date, bpm }` | last per date |
| `blood_oxygen_saturation` | `{ date, pct }` | mean per date |
| `mindful_minutes` | `{ date, minutes }` | sum per date |
| `body_mass` | `{ date, kg }` | last per date |
| `body_fat_percentage` | `{ date, pct }` | last per date |
| `blood_pressure_systolic` | `{ date, systolic }` | last per date |
| `blood_pressure_diastolic` | `{ date, diastolic }` | last per date |

Metrics not in the catalogue are archived in the raw payload but not
ingested. Adding a new metric is a one-line entry in
`health-auto-export/catalogue.js`; open a feature request if you need
something that's not here.

Blood pressure is two separate entries; combine them with a
combination card if you want them shown together.

---

## Setup

### 1. Enable the endpoint

Set `HEALTH_AUTO_EXPORT_TOKEN` in your klebb `.env` to any long random
string. `openssl rand -hex 32` is a fine source.

```
HEALTH_AUTO_EXPORT_TOKEN=<your-random-hex>
```

Restart klebb (or `docker compose restart` if you run in Docker).

Without this env var the endpoint returns **501** — the feature is
off by default.

### 2. Configure the iPhone app

In Health Auto Export:

1. **Automations** → **Add Automation** → **REST API**.
2. **URL**: `https://<your-klebb-host>/api/health-auto-export`
3. **Method**: `POST`
4. **Headers**:
   ```
   Content-Type: application/json
   Authorization: Bearer <your-HEALTH_AUTO_EXPORT_TOKEN>
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

$ ls $HEALTH_HOME/data/auto-export/raw/
2026-05-04T115853012Z.json
```

If nothing shows up:

- Check klebb's logs for `[hae]` lines.
- Hit the endpoint manually with `curl -X POST -H "Authorization:
  Bearer <token>" -H "Content-Type: application/json" -d
  '{"data":{}}'` — expect `200 {"ok":true,"ingested":{}}`.
- Wrong token → `401`.
- Missing env var → `501`.

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
- Whether `HEALTH_AUTO_EXPORT_TOKEN` is set.
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
replays its raw archive for that manifest's metric and populates
`data[]` in one go. So "the iPhone pushed yesterday, I built the
card today" still ends up with yesterday's data visible on the
card.

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

This is a single-snapshot diagnostic, not an audit log; the raw
archive under `auto-export/raw/` is the durable history. The snapshot
powers the authenticated status endpoint:

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
| Webhook body is not valid JSON | `200 + {warning}`, raw archived for inspection |

The no-op-on-empty invariant means manifest files are only rewritten
when the dispatcher produced at least one row for them. A push that
does nothing does not churn any file.

---

## Endpoint reference

```
POST /api/health-auto-export
Authorization: Bearer <HEALTH_AUTO_EXPORT_TOKEN>
Content-Type: application/json
```

| Response | Meaning |
|---|---|
| `200 {ok:true, ingested:{...}, availableUnsubscribed:[...]}` | Parsed and dispatched |
| `200 {ok:true, warning:"..."}` | Parse or dispatch failed but raw was archived; HAE will retry |
| `401` | Token missing or wrong |
| `501 {error:"ingest disabled"}` | `HEALTH_AUTO_EXPORT_TOKEN` env var not set |

Errors after auth passes are swallowed into `200 + warning` on
purpose: the iPhone app retries aggressively on non-2xx, and we'd
rather have a raw archive to debug than a spiral.
