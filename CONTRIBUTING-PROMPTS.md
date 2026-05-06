# Contributing prompts

A **prompt** is a natural-language starter that lives in `prompts/` and
shows up in the Klebb prompts gallery. Users pick a prompt, load it
into the chat widget, edit if they want, and hit send. The chat agent
builds a set of cards based on the prompt's instructions.

Prompts are the highest-leverage way to contribute to Klebb:
no code, no schema knowledge required, just a well-thought-out
use case.

## File shape

Each prompt is a `.md` file in `prompts/` with YAML frontmatter:

```markdown
---
title: GLP-1 injection cycle (with weight + waist)
summary: Weekly injectable with titration, plus weight and waist tracking.
tags: [glp1, injection, weight-loss, cycle]
---

I'd like to set up a dashboard for tracking a GLP-1 injection
protocol. I want three cards:

1. **Injection card** — weekly injectable, reconstituted peptide...
```

Required frontmatter:

- `title` — the gallery row label. Keep it under ~60 characters.
- `summary` — one sentence, shown under the title in the gallery.
- `tags` — list of short tags. Used for filtering in the gallery.

The body is the prompt the user will paste into the chat agent.

## Writing a good prompt

The agent is the one building cards, so the prompt is really a
briefing for the agent, not the user. Good prompts:

- **State the goal up front.** "Set up a dashboard for tracking X."
- **List the cards you want.** Numbered, one per card. For each card,
  mention the renderer shape if you know it (generic-card, checklist-
  card, etc.) or describe the behaviour (daily rating, weekly
  check-off, etc.) and let the agent pick.
- **Tell the agent what to ask the user.** If a card needs user-
  specific values (dose, start date, name of the substance), list the
  questions explicitly: *"Ask me which peptide, the dose per injection
  with units, and the cycle length in weeks."*
- **Require confirmation before creating.** The agent has a tendency
  to create first and ask questions after. Your prompt should say
  *"propose the manifests first; confirm with me before creating."*
- **Set the tone.** Klebb's audience is technical self-hosters. "Don't
  over-explain" is welcome guidance. "Use Australian English" is fine
  if that matches the content.
- **Specify what NOT to do.** If the prompt is single-card, say "do
  not create additional cards unless I ask." Prompts drift toward
  adding extras otherwise.

## Contribution checklist

- [ ] Frontmatter has `title`, `summary`, `tags`.
- [ ] Body is prose directed at the chat agent, not at a human reader.
- [ ] No personal or identifying data.
- [ ] No prescription brand names where a generic exists. Say
      "semaglutide", not a brand name.
- [ ] No medical claims or specific dosing recommendations. Prompts
      describe tracking structures, not protocols to follow. Let the
      user or their clinician decide the actual values.
- [ ] The prompt produces a realistic, useful dashboard for a real
      user persona (e.g. "someone on a GLP-1", "a post-op patient",
      "a strength athlete"). Not a kitchen-sink demo of every
      renderer.
- [ ] File name is `kebab-case.md` and matches the topic.

## Examples

See `prompts/new-to-klebb.md` for the conversational onboarding
prompt. See `prompts/glp1-cycle.md` for a multi-card protocol with
explicit follow-up questions. See `prompts/mood-sleep-basics.md` for a
minimal "just do it" prompt with no follow-ups.
