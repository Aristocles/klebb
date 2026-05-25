---
title: Home blood-pressure monitoring
summary: Twice-daily BP and heart-rate logging with a rolling weekly average and an optional antihypertensive checklist.
tags: [blood-pressure, cardiovascular, monitoring, daily]
---

Please set up a dashboard for monitoring blood pressure at home.
Propose the manifests first and confirm with me before creating.

1. **Blood pressure card** — twice-daily entry (morning and evening)
   capturing:
   - Systolic (mmHg)
   - Diastolic (mmHg)
   - Heart rate (bpm)
   - Which arm (left / right)
   - Which session (morning / evening)
   - Optional notes (e.g. "post-coffee", "after walk")

   Use whichever renderer best supports two readings per day. If the
   shape doesn't fit cleanly, fall back to one entry per reading and
   tag the session.

2. **Weekly average trend** — derived chart showing the 7-day rolling
   average of systolic and diastolic side by side. This is the number
   that actually matters; single readings are noisy.

3. **Antihypertensive checklist (optional)** — only create this if
   I tell you I'm on BP medication. Ask me first. If yes, ask which
   meds, dose, and frequency, and build it as a daily checklist-card.

Before creating anything, ask me:
- Whether I'm on any antihypertensive medication
- My target BP range if my GP has given me one (so we can later add
  a threshold marker; not required for the initial build)
- Preferred units; default to mmHg

Don't add a "salt intake" card or any lifestyle sidekick. Keep this
to the measurement loop.
