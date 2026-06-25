// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/card-settings.js
// Declarative model behind the per-card settings gear.
//
// A "descriptor" describes one toggleable manifest field:
//   { path, label, kind, help?, default, section?, availableWhen?, unavailableHint? }
//   - path:    dotted, rooted at meta (e.g. "view.enabled"). NOT prefixed
//              with "meta." — buildMetaPatch wraps the result in { meta }.
//   - kind:    "toggle" (boolean) for now.
//   - default: the value the field takes when absent from the manifest.
//   - availableWhen(ctx): optional predicate; ctx is { meta, data }.
//              When it returns false the control is shown disabled with
//              unavailableHint (a setting that would be a silent no-op).
//   - needsData: set true when availableWhen reads ctx.data, so the modal
//              knows to fetch the data block (most descriptors gate on meta
//              alone and avoid the round-trip).
//
// COMMON_SETTINGS apply to every card; each renderer contributes its own
// via `static get settingsSchema()`. mergeSchema() combines the two.

export const COMMON_SETTINGS = [
  {
    path: 'view.enabled', label: 'Show on Today', kind: 'toggle',
    section: 'Visibility', default: false,
    help: 'Include this card in the Today view.',
    availableWhen: ({ meta }) => !!meta?.view?.component,
    unavailableHint: 'Ask Klebbius to set up the Today view for this card.',
  },
  {
    path: 'trends.enabled', label: 'Show in Trends', kind: 'toggle',
    section: 'Visibility', default: false,
    help: 'Include this card in the Trends view.',
    availableWhen: ({ meta }) => !!meta?.trends?.component,
    unavailableHint: 'Ask Klebbius to set up the Trends view for this card.',
  },
  {
    path: 'calendar.enabled', label: 'Show in Calendar', kind: 'toggle',
    section: 'Visibility', default: false,
    help: 'Include this card in the Calendar month-grid.',
    availableWhen: ({ meta }) => !!meta?.calendar?.component,
    unavailableHint: 'Ask Klebbius to set up the Calendar view for this card.',
  },
  {
    path: 'reports.enabled', label: 'Show in Reports', kind: 'toggle',
    section: 'Visibility', default: false,
    help: 'Include this card in the Reports view.',
    availableWhen: ({ meta }) => !!meta?.reports?.component,
    unavailableHint: 'Ask Klebbius to set up the Reports view for this card.',
  },
  {
    path: 'writeable.fromWebapp', label: 'Allow editing from the app', kind: 'toggle',
    section: 'Input', default: false,
    help: 'Show the add/edit button so entries can be logged in the browser.',
  },
  {
    path: 'writeable.todayAllowed', label: 'Allow entries for today', kind: 'toggle',
    section: 'Input', default: true,
    availableWhen: ({ meta }) => !!meta?.writeable?.fromWebapp,
    unavailableHint: 'Turn on "Allow editing from the app" first.',
  },
  {
    path: 'writeable.pastAllowed', label: 'Allow entries for past dates', kind: 'toggle',
    section: 'Input', default: false,
    availableWhen: ({ meta }) => !!meta?.writeable?.fromWebapp,
    unavailableHint: 'Turn on "Allow editing from the app" first.',
  },
  {
    path: 'writeable.futureAllowed', label: 'Allow entries for future dates', kind: 'toggle',
    section: 'Input', default: false,
    availableWhen: ({ meta }) => !!meta?.writeable?.fromWebapp,
    unavailableHint: 'Turn on "Allow editing from the app" first.',
  },
  {
    path: 'writeable.prefillFromLatest', label: 'Prefill new entries from the last one', kind: 'toggle',
    section: 'Input', default: false,
    help: 'Seed a new entry from the most recent prior entry. Handy for slowly-changing values.',
    availableWhen: ({ meta }) => !!meta?.writeable?.fromWebapp,
    unavailableHint: 'Turn on "Allow editing from the app" first.',
  },
  {
    path: 'prompt.enabled', label: 'Prompt me to log this daily', kind: 'toggle',
    section: 'Behaviour', default: false,
    help: 'Show a once-a-day modal until the entry is logged or dismissed.',
    availableWhen: ({ meta }) => Array.isArray(meta?.writeable?.inputs) && meta.writeable.inputs.length > 0,
    unavailableHint: 'Needs logging inputs; ask Klebbius to set them up.',
  },
];

// Merge COMMON_SETTINGS with a renderer's static settingsSchema. The
// renderer schema is appended after the common one; sections keep their
// first-seen order in the modal.
export function mergeSchema(rendererSchema) {
  const extra = Array.isArray(rendererSchema) ? rendererSchema : [];
  return [...COMMON_SETTINGS, ...extra];
}

// Shared descriptor for the adherence sparkline toggle used by the
// checklist + schedule renderers. Both render the same 30-day adherence
// strip behind meta.view.showSparkline and gate it on the same signal, so
// they declare it identically. `hasSignal(items)` and `itemsOf(data)` are
// injected from lib/adherence-series.esm.js to keep this file dependency-free.
export function adherenceSparklineDescriptor(hasSignal, itemsOf) {
  return {
    path: 'view.showSparkline', label: 'Show adherence sparkline', kind: 'toggle',
    section: 'Behaviour', default: false,
    help: 'A small 30-day done/scheduled trend on Today.',
    needsData: true,
    availableWhen: ({ data }) => hasSignal(itemsOf(data)),
    unavailableHint: 'Needs a few days of check-offs first.',
  };
}

export function getAtPath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setAtPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

// The control's current value: the live manifest value when present (and
// the right type), else the descriptor default.
export function resolveSettingValue(meta, descriptor) {
  const v = getAtPath(meta, descriptor.path);
  if (typeof v === 'boolean') return v;
  return descriptor.default;
}

export function isSettingAvailable(descriptor, ctx) {
  if (typeof descriptor.availableWhen !== 'function') return true;
  try {
    return !!descriptor.availableWhen(ctx);
  } catch {
    return false;
  }
}

// Build a minimal RFC 7396 merge-patch from edited values. `edited` maps
// descriptor.path -> new value. Only paths that actually differ from the
// current manifest value are emitted, so a save with no real change is a
// no-op (returns null).
export function buildMetaPatch(descriptors, originalMeta, edited) {
  const meta = {};
  let changed = false;
  for (const d of descriptors) {
    if (!(d.path in edited)) continue;
    const next = edited[d.path];
    const current = resolveSettingValue(originalMeta, d);
    if (current === next) continue;
    setAtPath(meta, d.path, next);
    changed = true;
  }
  return changed ? { meta } : null;
}
