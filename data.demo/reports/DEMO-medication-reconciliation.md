# Medication reconciliation (demo)

> ⚠️ **DEMO DOCUMENT.** Fake sample data to show how the Reports view surfaces markdown files from `$HEALTH_HOME/reports/`.
>
> **Where this lives:** `$HEALTH_HOME/reports/DEMO-medication-reconciliation.md`
>
> **Auto-generated alternative:** The `medications` card has `meta.reports.enabled: true` with the `adherence-report` component, which computes compliance percentages directly from your dose log. That card-driven report appears at the top of the Reports view. This file demonstrates the other path — a hand-written or agent-written markdown document.

---

## Current regimen

| Item | Dose | Schedule | Adherence (30d) |
|---|---|---|---|
| Omega-3 fish oil | 2g EPA/DHA | daily, morning | 93% |
| Vitamin D3 | 5000 IU | Mon/Wed/Fri | 86% |
| Magnesium glycinate | 400 mg | daily, bedtime | 81% |

## Interactions

- No known clinically significant interactions between the three above.
- Magnesium can reduce absorption of some antibiotics (bisphosphonates, tetracyclines, fluoroquinolones). Separate by 2+ hours if any are prescribed.

## Notes

- Magnesium adherence lowest — bedtime timing is the friction point. Consider moving to dinner.
- Vitamin D3 target: maintain serum 25(OH)D between 75 and 125 nmol/L. Next check due in six months.

---

*Fabricated reconciliation. Real reports pull from your medication card's adherence data. See [`docs/CARDS.md#reports`](https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md#reports) for how `meta.reports.enabled` turns any card into a report.*
