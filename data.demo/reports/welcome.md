# 🎭 Welcome — this is demo data

Your new Klebb install auto-populated itself with **15 sample cards** and **5 sample markdown reports** so you can see what the dashboard looks like before you build your own.

**Nothing on this dashboard is real.** The weight graph, blood pressure readings, sleep hours, medication check-offs — all fabricated by the seed script. Poke around, then clear it and make it yours.

## Poke around

- **Today** — this page. Every card shows the most recent generated entry.
- **Trends** — 30 days of data per metric card, plotted as line charts.
- **Calendar** — heatmap of activity across every card that opts in.
- **Reports** — cards with `meta.reports.enabled` plus five sample markdown docs in `$HEALTH_HOME/reports/`.
- **Settings (⚙️)** — toggle any card off, or delete the data directly on disk.

## Make it yours

1. **Ask the chat agent** (🧠 button, bottom of screen). Say *"Add a card for tracking morning glucose"*. It drafts the manifest, drops the file in, restarts the registry. Card appears.
2. **Copy an example.** The repo's `data.example/` directory has 25 ready-made card files. Copy one to `$HEALTH_HOME/data/`, drop the `.example` from the filename.
3. **Write one by hand.** See `MANIFEST-SCHEMA.md` + `docs/CARDS.md` + `docs/RECIPES.md` in the repo.

## Clear the demo

When you're ready for your own data, either:

- Delete individual cards in **Settings** (toggles them off; the files stay).
- Or `rm $HEALTH_HOME/data/*.json $HEALTH_HOME/reports/*.md` and restart. The demo will **not** re-seed — a `.klebb-seeded` sentinel in `$HEALTH_HOME` records that the one-time seed has already run.

---

*Every card here is a JSON file. Drop a file in, a card appears. Delete the file, the card is gone. That is the entire app.*
