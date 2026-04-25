# 📘 Adding your own cards

Every card on this dashboard is a JSON file in `$HEALTH_HOME/data/`.

## Three ways

1. **Ask the chat agent.** Tap 🧠, say *"Add a card for tracking daily meditation minutes"*. It drafts the manifest, drops the file in, and the card appears.
2. **Copy an example.** Browse `data.example/` in the repo — 25 ready-made cards. Copy the one you want to `$HEALTH_HOME/data/` and drop the `.example` from the filename.
3. **Write one by hand.** Full spec: `MANIFEST-SCHEMA.md`. Patterns: `docs/CARDS.md`. Recipes: `docs/RECIPES.md`.

## Removing a card

Delete the file, or toggle it off in **Settings** (keeps the data, hides the card).

## Getting help

Ask the chat agent: *"Change the mood card to allow multiple entries per day"* or *"Why isn't my new card showing up?"*. It has access to the same docs you do.

---

*This is the **demo** how-to — the data around it is fake. Ready to build your own dashboard? See the welcome card above.*
