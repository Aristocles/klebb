# Blood panel (demo)

> ⚠️ **DEMO DOCUMENT.** This is fake sample data shipped with a fresh Klebb install so you can see how the Reports view surfaces markdown files from `$HEALTH_HOME/reports/`. None of these values are real.
>
> **Where this lives:** `$HEALTH_HOME/reports/DEMO-bloods.md`
>
> **Drop your own in:** Put any `.md` file into `$HEALTH_HOME/reports/` and it will appear in the Reports view. The first `# Heading` becomes the title; an ISO date in the filename (`YYYY-MM-DD`) becomes the sort key. See [`docs/CARDS.md#reports`](https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md#reports) for the full spec.

---

## Summary

Routine annual panel. All values within reference range. No follow-up required.

## Key results

| Marker | Value | Reference | Status |
|---|---|---|---|
| HbA1c | 5.2% | <5.7% | ✅ Normal |
| Fasting glucose | 4.7 mmol/L | 3.9-5.5 | ✅ Normal |
| Total cholesterol | 4.8 mmol/L | <5.2 | ✅ Normal |
| LDL | 2.9 mmol/L | <3.0 | ✅ Borderline |
| HDL | 1.4 mmol/L | >1.0 | ✅ Good |
| Triglycerides | 0.9 mmol/L | <1.7 | ✅ Normal |
| eGFR | 98 | >90 | ✅ Normal |
| TSH | 2.1 mIU/L | 0.4-4.0 | ✅ Normal |
| Vitamin D | 72 nmol/L | 50-150 | ✅ Normal |
| Ferritin | 140 µg/L | 30-300 | ✅ Normal |

## Commentary

LDL at 2.9 is the one worth watching — right at the upper edge of the "optimal" band. Continue with current diet and weekly cardio. Re-test in 12 months.

## Next steps

- Retest in 12 months.
- If LDL rises above 3.2, consider plant-sterol spread and a conversation about statins.

---

*Everything above is fabricated demo data. Do not use for any clinical purpose. To replace this file with your own, save a real blood panel as `$HEALTH_HOME/reports/bloods-YYYY-MM-DD.md` and delete this one.*
