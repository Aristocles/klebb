# Klebbius evals

Simulated user conversations driven against a running instance with a
**real model** behind the chat gateway, asserting on what actually
happened: the reply, the follow-up chips, the tool calls the agent made,
and a full before/after diff of the manifest store.

These are **evaluations, not tests**. The model is probabilistic, so each
scenario runs N times and the report shows pass rates. They never run in
CI; run them on demand or after a deploy/model swap. The harness's own
machinery (log parser, differ, assertion engine) is deterministic and
covered by `tests/eval-harness.test.js`, which does run in CI.

## Running

Against a self-spawned sandbox server (real gateway from your env):

```bash
CHAT_ENDPOINT_URL=... CHAT_API_KEY=... CHAT_MODEL=... node evals/run.js
```

Against any running instance:

```bash
node evals/run.js \
  --base-url https://name.example.com \
  --token <AGENT_API_TOKEN> \
  --log-cmd "ssh host 'docker logs -f --tail 0 klebb-name 2>&1'"
```

`--log-cmd` is any command that follows the instance's log stream; the
instance must run with `HEALTH_DEBUG=1` for the `[chat:*] tool ...`
forensic lines the tool assertions parse. Without `--log-cmd`, tool
assertions are skipped and reply/chip/state checks still run.

Other flags: `--reps N` (default 3), `--only <substr>`, `--out report.json`,
`--list`.

Every scenario cleans up after itself: seeds, expected creations, and any
stray card the model invented are deleted at the end (diffed against the
scenario-start snapshot), so repeated runs against a live instance leave
no residue. Still: **never point this at an instance holding real data**;
scenarios mutate cards by design.

**Engagement guard.** If a turn comes back with no reply text and no tool
call, the model never actually ran (gateway down, budget exhausted, request
timed out); the runner flags that turn as a failure instead of letting it
pass. This matters for adversarial scenarios: "must NOT write" is trivially
satisfied by a dead gateway, so without the guard a whole run could go green
against a model that never answered. If you see `engagement:` findings, fix
the gateway before trusting any result. On the shared cloud dev instance the
usual cause is the per-key LiteLLM budget; a full 3-rep corpus run needs
enough headroom for ~50 real tool-turns.

## Writing a scenario

Scenarios live in `evals/scenarios/*.js`, each exporting an array:
`happy.js` (journeys that must work), `features.js` (per-feature surfaces:
trends, reports, combination cards, notifications, schedules, multi-card
reads, confirmed deletion, targeted row edits), and `adversarial.js`
(journeys that must not do damage). Each scenario is:

```js
{
  name: 'my-scenario',
  seeds: [/* full manifests created before the run */],
  turns: [
    { say: 'user message',
      viewedCardId: 'optional-focus-card',
      expect: { /* assertion vocabulary below */ } },
    { chip: 0,  // "click" the first offered chip: feeds its prompt back
      expect: { ... } },
  ],
  cleanupIds: ['ids-the-model-is-expected-to-create'],
}
```

Assertion vocabulary (all optional, all deterministic):

| Key | Meaning |
|---|---|
| `http.status` | exact response status |
| `reply.match` / `reply.noMatch` | case-insensitive regexes over the reply text |
| `tools.required` / `forbidden` / `allowOnly` | tool-name constraints for the turn |
| `tools.noErrors` | every tool call this turn returned ok |
| `state.created` / `deleted` | ids that must appear/disappear |
| `state.noCreates` / `noDeletes` / `noChanges` | nothing new / nothing gone / nothing at all |
| `state.modifiedOnly` | only these ids may change |
| `cardShape` | assert the *shape* a card ended up in (see below) |
| `registryClean` | no loader/validation errors after the turn |
| `chips.present` / `labelsInclude` / `maxCount` | follow-up chip constraints |

### `cardShape` — asserting *how* a card changed

`state`/diff tell you *which* cards changed; `cardShape` tells you the shape
they ended up in. It reads the post-turn snapshot and resolves paths with the
same tiny grammar the chat tools use (`manifests/path.js`): dotted properties
plus equality filters.

```js
cardShape: {
  // key is a card id, or '$created' for the single card created this turn
  'weight': {
    'meta.trends.enabled':                 { equals: true },
    'meta.view.combines[index=0].sourceId': { exists: true },
    'data[date="2026-07-05"].value':        { equals: 82.1 },
  },
  '$created': {
    'meta.view.component':  { equals: 'combination-card' },
    'meta.view.combines':   { type: 'array', minLength: 2 },
  },
}
```

Matchers (combine any on one path): `exists` (true/false), `equals`
(deep-equal), `oneOf` (deep-equal to one of), `type`
(`array`/`object`/`string`/`number`/`boolean`/`null`), `length`, `minLength`.
A value matcher on a path that resolves to nothing is a failure (not a silent
pass). `$created` fails unless exactly one card was created this turn.

> Card data lives in the datastore, so `GET /api/manifests` is meta-only; the
> runner fetches each card's `data` block separately and merges it into the
> snapshot. This is also why `state.modifiedOnly`/`noChanges` now catch
> data-only edits (a logged row) that used to be invisible to the differ.

Design rule: assert **properties, not wording**. An off-topic refusal can
be phrased a hundred ways; what matters is that no write tool fired and
the store didn't change. When an eval keeps failing on something the
server could enforce, harden the server and pin it with a deterministic
test in `tests/` — evals discover, tests pin.
