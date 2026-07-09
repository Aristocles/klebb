# Demo fixtures

This directory holds the curated dataset shown on the public Klebb
demo (e.g. `demo.klebb.app`). Every JSON file is a complete, valid
`klebb.datafile.v1` manifest with a couple of weeks of plausible-but-
fake history so the dashboard renders trends, calendars, schedules,
and reports the moment a visitor lands.

These fixtures are **not** templates. They are full manifests with
data already populated. Templates live under `templates/` and ship
empty starter scaffolding for real users.

## Layout

```
demo/fixtures/
├── *.json                      # manifest cards, copied to $HEALTH_HOME/data/
└── reports/
    └── *.md                    # narrative reports, copied to $HEALTH_HOME/reports/
```

The cards include both small per-metric fixtures (weight, sleep, mood,
hydration, steps, etc.) and richer reports-page cards (a fasting blood
panel, a categorised SNP / genome card, and a peptide cycle that
exposes adherence). The markdown narrative reports under
`reports/` show up on the Reports page underneath the manifest-driven
cards: a blood debrief, a genome overview, a quarterly debrief, and a
baseline profile.

## Date placeholders

`data[].date`, `cycles[].start` / `cycles[].end`, `doses[].scheduledDate`,
`doses[].takenAt`, and `takenDates[]` use `__OFFSET_DAYS:N__`
placeholders that resolve to *today minus N* (or *today plus N* for
positive numbers) at the moment the reset script runs. So
`__OFFSET_DAYS:0__` is today, `__OFFSET_DAYS:-7__` is a week ago.

In **filenames** (e.g. `BLOODS-__OFFSET_DAYS_-30__.md`) use the
underscore form `__OFFSET_DAYS_N__` since `:` is not a legal NTFS
character. The reset script accepts both forms; it resolves the
filename placeholder on copy, so the seeded report ends up named
`BLOODS-2026-04-21.md` (or whatever date 30 days before today
produces).

Mixing literal ISO dates with placeholders inside the same array is
not supported. Pick one shape per fixture and stick with it.

## Resetting

`scripts/reset-demo.js` wipes `$HEALTH_HOME/data/` and
`$HEALTH_HOME/reports/`, then copies every JSON manifest from this
directory into the data dir and every markdown report from
`reports/` into the reports dir, rewriting every offset placeholder
against the current date along the way. A running server's file
watcher imports each fixture's inline `data` block into the datastore
within a second, so no restart is needed. The script refuses to run
unless `KLEBB_DEMO=1` is set so it can never be invoked against a
real instance by accident.

```
KLEBB_DEMO=1 HEALTH_HOME=/srv/klebb-demo node scripts/reset-demo.js
```

Hook this into a cron / systemd timer on the demo host so the
dashboard always looks like it was updated this week.

Rows of cards *removed* from the fixture set linger in the datastore
(never served: their manifests are gone). To purge them, stop the
server, run the script with `--wipe-db`, and start it again; the boot
import repopulates the store from the fixtures. Never `--wipe-db`
under a running server: its reload would import into the deleted DB
file and the next boot would come up empty.
