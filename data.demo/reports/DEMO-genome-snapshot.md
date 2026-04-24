# Genomic snapshot (demo)

> ⚠️ **DEMO DOCUMENT.** This is fake sample data shipped with a fresh Klebb install so you can see how the Reports view surfaces markdown files from `$HEALTH_HOME/reports/`. None of these values are real.
>
> **Where this lives:** `$HEALTH_HOME/reports/DEMO-genome-snapshot.md`
>
> **Drop your own in:** Save a genomic report (from 23andMe, Nebula, Dante, or a clinical lab) as markdown at `$HEALTH_HOME/reports/genome-YYYY-MM-DD.md` and it will appear in the Reports view. Large SNP tables should stay in the markdown file; if you want summary stats as a card, see the `data.example/snps.example.json` pattern in the repo and [`docs/CARDS.md#reports`](https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md#reports) for the full spec.

---

## About this report

A genomic snapshot summarises selected single-nucleotide polymorphisms (SNPs) relevant to common health themes — caffeine metabolism, folate cycle, lipid handling, and sleep. The data below is **entirely fabricated** for demo purposes.

## Selected SNPs

| Gene | SNP | Genotype | Note |
|---|---|---|---|
| CYP1A2 | rs762551 | AA | Fast caffeine metaboliser |
| MTHFR | rs1801133 | CT | One copy of the 677T variant, some folate-cycle reduction |
| APOE | rs429358 / rs7412 | ε3/ε3 | Neutral lipid handling |
| PER3 | rs57875989 | 4/5 | Intermediate circadian phase |
| CLOCK | rs1801260 | TC | No strong morningness/eveningness bias |

## What this suggests (educational, not medical)

- **Caffeine:** fast metaboliser profile. Consistent with tolerating moderate intake without sleep impact, provided timing is controlled.
- **Folate:** with one MTHFR 677T allele, some advisers recommend methylated folate (L-methylfolate) over folic acid. Speak to a clinician.
- **APOE ε3/ε3:** the most common genotype, neutral risk profile.

## What this is NOT

- A diagnosis.
- A prescription.
- A substitute for a real genomic report from a certified lab.

---

*Fabricated demo. Genome data in Klebb is read-only — drop your own markdown report into `$HEALTH_HOME/reports/` and it will show up here.*
