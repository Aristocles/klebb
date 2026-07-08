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

## Writing a scenario

Scenarios live in `evals/scenarios/*.js`, exported as an array. Each is:

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
| `registryClean` | no loader/validation errors after the turn |
| `chips.present` / `labelsInclude` / `maxCount` | follow-up chip constraints |

Design rule: assert **properties, not wording**. An off-topic refusal can
be phrased a hundred ways; what matters is that no write tool fired and
the store didn't change. When an eval keeps failing on something the
server could enforce, harden the server and pin it with a deterministic
test in `tests/` — evals discover, tests pin.
