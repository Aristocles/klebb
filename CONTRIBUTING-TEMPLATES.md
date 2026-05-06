# Contributing templates

A **template** is a starter card manifest that lives in `templates/` and
shows up in the Add Card gallery. Picking a template opens a small form;
filling it in produces a real card in `$HEALTH_HOME/data/`.

## File shape

Each template is a `.klebb.json` file in `templates/`. The filename
must match `meta.template.id` exactly: `weight.klebb.json` carries
`meta.template.id: "weight"`.

A template is a valid `klebb.datafile.v1` manifest with two additions:

1. A `meta.template` block describing how the template appears in the
   gallery.
2. Placeholder strings in place of user-supplied values.

### `meta.template`

```json
"template": {
  "id": "injection-protocol",
  "title": "Injection protocol",
  "summary": "Scheduled injectable with cycle start and end.",
  "category": "protocols",
  "tags": ["injection", "schedule", "cycle"]
}
```

All five fields are required. `category` should be one of the gallery
categories: `tracking`, `protocols`, `lifestyle`, `imported`.

### Placeholders

Placeholders let a template stay generic until a user fills in their
specifics. Syntax: `{{type:name}}` or `{{name}}` (default type =
string).

Supported types: `string`, `number`, `boolean`, `date`, `enum`.

```json
"id": "{{string:id}}",
"label": "{{string:label}}",
"order": 100
```

The Add Card form uses the type to pick the input element: number gets
a number input, date gets a date picker, enum gets a dropdown, etc.
Substitution happens server-side when the user submits.

Keep placeholder names `snake_case` and semantic: `dose_mg`,
`cycle_start`, not `field1`. The Add Card form uses the name as the
default field label if one is not supplied elsewhere.

## Contribution checklist

Before opening a PR:

- [ ] Filename matches `meta.template.id`.
- [ ] `meta.template` block is complete.
- [ ] Template is a valid `klebb.datafile.v1` manifest after placeholder
      substitution (run `npm test`; the template walker catches most
      errors).
- [ ] Placeholders only use the supported type set.
- [ ] No personal or identifying data in the manifest.
- [ ] No prescription brand names where a generic is available (e.g.
      use "semaglutide", not a brand name).
- [ ] `data` block is empty or minimal; users populate it themselves.
- [ ] The template describes a real-world tracking use case, not a
      demonstration of schema features.

## Examples

See the templates already in `templates/` for worked examples across
all four categories. The simplest one to copy is `weight.klebb.json`
(single-metric generic-card). The most complex is
`injection-protocol.klebb.json` (checklist-card with schedule +
cycles + calendar marker).

If your template needs a renderer capability that existing templates
don't demonstrate, look at the renderer's source under
`public/js/components/eh-*-card.js` for the shape it expects.
