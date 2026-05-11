# What changed

Brief summary of the problem this PR solves.

# Why

Context that reviewers need: why is this change necessary? Any prior
discussion, issue number, user report, or constraint driving it.

# How

Short description of the approach. Note any design decisions that
weren't obvious.

# Testing

- [ ] `npm test` passes locally (Node 20 and 22)
- [ ] `npm run test:e2e` passes locally (headless Playwright)
- [ ] New regression test added at the right layer:
  - Backend / manifest / schema change → `tests/api/*.test.js`
  - User-visible interaction / navigation → `tests-e2e/*.spec.js`
  - Pure logic → `tests/*.test.js`
  - No test? Explain why (doc-only change, pure rename, etc.)
- [ ] Test fails against `main` before the fix and passes with it
      (for bug-fix PRs)
- [ ] Manual QA against a local dev instance or the klebbtest
      container (describe what you clicked/tried)

# Checklist

- [ ] Commit messages follow the conventions in `CONTRIBUTING.md`
- [ ] `CHANGELOG.md` updated under `## Unreleased`
- [ ] Docs updated (`README.md` / `docs/*.md` / `MANIFEST-SCHEMA.md`)
      if behaviour or schema changed
- [ ] No personal identifiers or hardcoded paths introduced
      (the `no-personal-refs` test will flag these)
- [ ] No secrets or high-entropy tokens committed
      (the `no-secrets` test will flag these)

# Breaking changes

If yes, describe the migration path a user needs to follow.
