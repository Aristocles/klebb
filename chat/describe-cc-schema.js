// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/describe-cc-schema.js
//
// Produces a compact, agent-facing description of the combination-card
// manifest contract. Injected into the chat system prompt so the agent
// writes CC manifests that match what the eh-combination-card renderer
// actually reads, instead of hallucinating plausible-looking keys like
// view.slots[] or view.sources[].
//
// The renderer's accepted shape is authoritative; this file mirrors
// what public/js/components/eh-combination-card.js parses. If that
// contract changes, update here too.

function describeCcSchema() {
  return [
    '## Combination cards',
    '',
    'A combination card (CC) is a manifest whose view is backed by the',
    '`combination-card` renderer. It composes existing atomic cards as',
    '"donors" rather than holding its own `data[]`.',
    '',
    'CANONICAL SHAPE — copy exactly:',
    '',
    '```json',
    '{',
    '  "$schema": "klebb.datafile.v1",',
    '  "meta": {',
    '    "id": "recovery-ring",',
    '    "label": "Recovery",',
    '    "emoji": "💓",',
    '    "category": "recovery",',
    '    "view": {',
    '      "enabled": true,',
    '      "component": "combination-card",',
    '      "layout": "stack",                       // "stack" or "rings"',
    '      "combines": [',
    '        {',
    '          "sourceId": "hrv",                   // required; matches another manifest\'s meta.id',
    '          "role": "primary",                   // "primary" | "secondary" | "annotation" | "ring-segment"',
    '          "label": "HRV",                      // optional display override',
    '          "unit": "ms"                         // optional display unit',
    '        },',
    '        {',
    '          "sourceId": "resting-heart-rate",',
    '          "role": "secondary"',
    '        }',
    '      ]',
    '    }',
    '  },',
    '  "description": "...",',
    '  "data": []',
    '}',
    '```',
    '',
    'RULES:',
    '- Donors live in `meta.view.combines`. The key on each donor is',
    '  `sourceId` (the referenced manifest\'s meta.id). No other key',
    '  is accepted.',
    '- Layouts: `"stack"` renders a vertical list; `"rings"` renders',
    '  concentric progress gauges. Only donors with `role: "ring-segment"`',
    '  appear in the ring when layout is `"rings"`.',
    '- `role` chooses visual weight: `"primary"` renders larger,',
    '  `"secondary"` is medium, `"annotation"` is subdued.',
    '- Ring segments require exactly one of `goalDaily` (number) or',
    '  `goalWeekly` (number) and optionally accept `colour` (hex/CSS',
    '  colour string). Use `goalDaily` when the ring fills against today\'s',
    '  value; use `goalWeekly` when the ring should accumulate Mon-Sun',
    '  (sum of the accessor across the week containing the viewed date,',
    '  resets each Monday). Examples:',
    '    `{ "sourceId": "steps", "role": "ring-segment", "goalDaily": 10000, "colour": "#44ff88" }`',
    '    `{ "sourceId": "workouts", "role": "ring-segment", "goalWeekly": 5, "colour": "#f59e0b" }`',
    '- A CC\'s own `data[]` MUST be an empty array. All values come',
    '  from the donor manifests via the registry at render time.',
    '- Do NOT inline per-donor display templates on combines[]. Each',
    '  donor row renders via the donor manifest\'s own',
    '  `meta.view.display.template`; the CC renderer ignores any',
    '  `display` block nested inside a combines[] entry.',
    '',
    'FORBIDDEN — observed hallucinations that must not be used:',
    '- `view.slots[]` with `cardId` — not a real shape.',
    '- `view.sources[]` with `id` — not a real shape.',
    '- Inlining a per-donor `display` or `thresholds` block inside a',
    '  combines[] entry.',
    '- Putting `data[]` entries on the CC itself.',
    '',
    'The CC manifest should carry `meta.category` matching the cluster',
    'it represents (e.g. a Recovery CC gets `"category": "recovery"`).',
    '',
  ].join('\n');
}

module.exports = { describeCcSchema };
