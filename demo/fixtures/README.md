# Demo fixtures

This directory holds the curated dataset shown on the public Klebb
demo (e.g. `demo.klebb.app`). Every file is a complete, valid
`klebb.datafile.v1` manifest with a couple of weeks of plausible-but-
fake history so the dashboard renders trends, calendars, schedules,
and reports the moment a visitor lands.

These fixtures are **not** templates. They are full manifests with
data already populated. Templates live under `templates/` and ship
empty starter scaffolding for real users.

## Date placeholders

`data[].date`, `cycles[].start` / `cycles[].end`, `doses[].scheduledDate`,
`doses[].takenAt`, and `takenDates[]` use `__OFFSET_DAYS:N__`
placeholders that resolve to *today minus N* (or *today plus N* for
positive numbers) at the moment the reset script runs. So
`__OFFSET_DAYS:0__` is today, `__OFFSET_DAYS:-7__` is a week ago.

Mixing literal ISO dates with placeholders inside the same array is
not supported. Pick one shape per fixture and stick with it.

## Resetting

`scripts/reset-demo.js` wipes `$HEALTH_HOME/data/`, copies every file
from this directory into it, and rewrites every offset placeholder
against the current date. It refuses to run unless `KLEBB_DEMO=1` is
set so it can never be invoked against a real instance by accident.

```
KLEBB_DEMO=1 HEALTH_HOME=/srv/klebb-demo node scripts/reset-demo.js
```

Hook this into a cron / systemd timer / docker-compose `restart`
policy on the demo host so the dashboard always looks like it was
updated this week.
