---
title: Peptide cycle (generic)
summary: A single injectable peptide with reconstitution details, a cycle window, and a fixed weekly schedule.
tags: [peptide, injection, cycle]
---

Please set up a single injection card for a peptide cycle. Ask me the
details I need to fill in; don't guess or default silently.

What you need from me:

- Peptide name
- Dose per injection (with units: mcg, mg, IU)
- Reconstitution volume and diluent (usually bacteriostatic water;
  sometimes sterile saline)
- Vial strength so the draw volume is computable
- Injection days (e.g. Mon/Wed/Fri, or daily, or once-weekly)
- Time of day (morning, before bed, etc.) if it matters for the
  compound
- Cycle start date and cycle length in weeks
- Injection site rotation if I want to track it (optional extra field)

Once you have the answers:

1. Propose the card shape (one checklist-card or schedule-card manifest).
2. Confirm with me.
3. Create it with create_manifest.
4. Tell me in one sentence how I log a completed injection (check off
   the scheduled dose on the card, don't delete the item).

Do not create any additional cards (weight, waist, sides) unless I
ask. This prompt is single-card by design.
