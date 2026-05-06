# Contributing to Klebb

Thanks for thinking about contributing. Klebb is a file-driven personal
health dashboard — this doc covers how to get a dev environment, the
conventions we follow, and how to propose changes.

## Quick start

```bash
git clone https://github.com/Aristocles/klebb.git
cd klebb
npm ci

# Data dir for your dev instance
export HEALTH_HOME="$HOME/klebb-dev"
mkdir -p "$HEALTH_HOME/data"

# Run
npm start
# → http://localhost:8080
```

Run the test suite before every commit:

```bash
npm test
```

All tests should pass on Node 20 and Node 22. CI enforces both.

## Project layout

See the Architecture section of [`README.md`](README.md#architecture).

Short version:
- `server.js` — HTTP + static + API entry point
- `config/` — env + paths
- `manifests/` — card registry (discover, validate, cache, write)
- `auth/` — WebAuthn + invites
- `voice/` — Fish Audio TTS/ASR (optional)
- `public/` — frontend (Lit web components)
- `tests/` — Node built-in `node --test` suite
- `scripts/` — CLI tools (migrate, invite, deploy, verify-install)
- `docs/` — user + contributor docs

## Adding a new card type

Cards are manifest files in `$HEALTH_HOME/data/`. Most don't need any
code — use the `generic-card` renderer with a `display.template` and
`writeable.inputs`. See [`docs/CARDS.md`](docs/CARDS.md) for the full
guide.

If you genuinely need a bespoke renderer (complex interactions,
specialised charts), see the next section.

## Adding a new renderer component

1. Create `public/js/components/eh-yourcomponent.js`
2. Extend `EhBaseCard` from `eh-base-card.js`
3. Implement `renderCard()`
4. Self-register at the bottom of the file:
   ```js
   customElements.define('eh-yourcomponent', EhYourComponent);
   registerRenderer('your-component', 'eh-yourcomponent');
   ```
5. Add the import to `public/js/components/eh-view-renderer.js`
6. Document it in `docs/CARDS.md` and `MANIFEST-SCHEMA.md`

## Commit messages

One-line subject + optional body:

```
Subject in imperative mood, no trailing period

Longer explanation if useful. Wrap at 72 chars. Describe WHY, not just
WHAT (the diff shows what). Reference issue numbers like #42 where
relevant.
```

Good: `Fix date-keyed mood data auto-conversion on agent writes`
Bad: `fixed stuff`, `wip`, `final version`

Squash "fix typo" and "address review" commits before requesting final
review. We prefer a clean history.

## Tests

- New features ship with tests. Integration tests use
  `tests/helpers/sandbox.js` for ephemeral `$HEALTH_HOME` + server.
- Pure-function libraries get unit tests. See `tests/display-template.test.js`
  for the shape.
- Lit web components are not unit-tested in CI (DOM required). Manual QA
  + integration via the HTTP API covers them in practice.
- Don't add test dependencies — the stdlib `node --test` + assert is
  enough.

## Pull requests

1. Fork, create a branch off `main`
2. Keep commits focused (one logical change per commit)
3. Update `CHANGELOG.md` under `## Unreleased`
4. Run `npm test` locally before pushing
5. Open a PR; CI runs automatically
6. Address review comments with additional commits (don't force-push
   during review — we can squash at merge time)

## Style

- Australian/British English in docs and comments (colour, organise,
  apologise)
- No emdashes (—); use colons, semicolons, or parentheses
- 2-space indent in JS; 4-space in Bash
- No build step: this is hand-written ES modules loaded from `esm.sh`
- Keep dependencies minimal. A new `npm install` needs justification
  in the PR.

## Reporting bugs or asking for features

Use the issue templates at
<https://github.com/Aristocles/klebb/issues/new/choose>.

For security issues, see [`SECURITY.md`](SECURITY.md).
