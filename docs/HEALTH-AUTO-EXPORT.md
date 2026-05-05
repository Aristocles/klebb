# Health Auto Export — iPhone health data into klebb

Klebb can receive a webhook push from the iPhone
[Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567069)
app. Each push writes the raw payload to disk for audit, then upserts
daily rows into four atomic manifests that the Sleep and Activity
combination cards consume.

This page tells you how to set it up.

---

## What gets populated

With the webhook enabled, each HAE push updates these four manifests:

| Source metric (HAE) | Klebb manifest | Row shape |
|---------------------|----------------|-----------|
| `sleep_analysis` | `sleep-hours` | `{ date, hours, source? }` |
| `step_count` (summed per date) | `steps` | `{ date, count }` |
| `apple_exercise_time` (summed per date) | `active-minutes` | `{ date, minutes }` |
| `workouts[]` | `workouts` | `{ date, trained: true, type }` |

A manifest is created automatically on the first push if it doesn't
already exist. Re-posting the same date overwrites only that date's
row; other dates are untouched.

The raw payload is archived unchanged at
`$HEALTH_HOME/data/auto-export/raw/<ms-stamp>.json` regardless of
whether parsing succeeds. Safe to delete at any time if disk space
is tight.

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
5. **Metrics**: select at minimum Sleep Analysis, Step Count, Apple
   Exercise Time, Workouts. Add any others you want archived — the
   server ignores metrics it doesn't recognise but still keeps them
   in the raw archive.
6. **Export format**: JSON.
7. **Frequency**: every 6 hours is a reasonable default. Hourly also
   works; klebb is cheap to hit.

### 3. Verify

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
  '{"data":{}}'` — expect `200 {"ok":true,"ingested":{...}}`.
- Wrong token → `401`.
- Missing env var → `501`.

---

## Atomic manifests are ingest-only by default

The four atomic manifests listed above (`sleep-hours`, `steps`,
`active-minutes`, `workouts`) ship with `writeable.fromWebapp: false`.
That means klebb's webapp shows them read-only: no `+` button, no
edit form. HAE is their only writer.

The rationale: manual entry plus ingest would double-display the same
metric on Today (combo card + atomic card + input form) and every
HAE push would silently overwrite whatever you typed. Ingest-only
avoids both problems.

If you're not using HAE and want to log these metrics by hand,
either:

- Flip `writeable.fromWebapp: true` in the manifest file (and add an
  `inputs[]` block), or
- Ask klebbius: "make the steps card writeable from the webapp with
  a single number input for count". It'll patch the manifest in
  place.

---

## Endpoint reference

```
POST /api/health-auto-export
Authorization: Bearer <HEALTH_AUTO_EXPORT_TOKEN>
Content-Type: application/json
```

| Response | Meaning |
|----------|---------|
| `200 {ok:true, ingested:{...}}` | Parsed and upserted. Counts per source. |
| `200 {ok:true, warning:"..."}` | Parse or upsert failed but raw was archived. HAE will retry. |
| `401` | Token missing or wrong. |
| `501 {error:"ingest disabled"}` | `HEALTH_AUTO_EXPORT_TOKEN` env var not set. |

Errors after auth passes are swallowed into `200 + warning` on
purpose: the iPhone app retries aggressively on non-2xx, and we'd
rather have a raw archive to debug than a spiral.

---

## What's not in MVP

- **Richer sleep manifests** (stages, bed/wake times, HRV, respiration).
  Coming in a follow-up that adds `sleep-stages` and `sleep-bed-wake`
  manifests alongside the current `sleep-hours`.
- **Per-workout detail** (type, duration, avg/max HR, distance). The
  current `workouts` card is a one-bit `trained: true` summary;
  richer data lands with a `workouts-detailed` manifest later.
- **Vitals ingestion** (heart rate, HRV, SpO₂, blood oxygen). Raw is
  archived; the parser doesn't yet fan out to manifests.
- **File-drop mode** (iCloud sync). HTTP webhook is the only
  supported transport today.

See the ingest parser at `health-auto-export/ingest.js` if you want to
add metrics — the parser is pure, ~100 lines, and straightforward to
extend.
