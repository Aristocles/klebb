// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/validate-manifest.js
// Dry-run manifest validation for the Klebbius agent: the same structural
// gate the write path enforces (registry.validateManifestShape) PLUS a few
// renderer-shape checks keyed off meta.view.component, surfaced as a list of
// {path, message} so the agent can self-correct before committing a write.
//
// Important: the renderer checks only assert what genuinely breaks rendering.
// They do NOT invent requirements the renderers tolerate (e.g. line-chart
// auto-detects its y-field, so `series` is optional and is only shape-checked
// when present).

const registry = require('../manifests/registry');

// Renderer-specific shape checks. Each returns an array of {path, message}.
// Run against a structurally-valid manifest (validateManifestShape already
// passed), so meta/meta.view are safe to read defensively.
function rendererShapeErrors(manifest) {
  const errors = [];
  const meta = manifest.meta || {};
  const view = meta.view || {};
  const component = view.component;

  if (view.display !== undefined && (typeof view.display !== 'object' || Array.isArray(view.display) || view.display === null)) {
    errors.push({ path: 'meta.view.display', message: 'display must be an object (e.g. {template, unit}), not a string or array' });
  }

  if (component === 'combination-card') {
    const combines = view.combines;
    if (!Array.isArray(combines) || combines.length === 0) {
      errors.push({ path: 'meta.view.combines', message: 'combination-card requires meta.view.combines[] with at least one donor' });
    } else {
      combines.forEach((c, i) => {
        if (!c || typeof c !== 'object' || typeof c.sourceId !== 'string' || !c.sourceId) {
          errors.push({ path: `meta.view.combines[${i}].sourceId`, message: 'each combines entry needs a sourceId (the referenced manifest meta.id)' });
        }
      });
    }
  }

  if (component === 'line-chart' || component === 'area-chart' || component === 'bar-chart') {
    // series is OPTIONAL: the renderer auto-detects a y-field when absent.
    // Only shape-check it when the author has supplied it.
    if (view.series !== undefined) {
      if (!Array.isArray(view.series)) {
        errors.push({ path: 'meta.view.series', message: 'series, when set, must be an array of {field, label?, colour?}' });
      } else {
        view.series.forEach((s, i) => {
          if (!s || typeof s !== 'object' || typeof s.field !== 'string' || !s.field) {
            errors.push({ path: `meta.view.series[${i}].field`, message: 'each series entry needs a string field naming the numeric key to plot' });
          }
        });
      }
    }
  }

  return errors;
}

// Validate a candidate manifest object without writing anything. Returns
// { ok: true } or { ok: false, errors: [{path, message}] }. Mirrors the write
// path exactly for the structural subset (strictId:true, like create), then
// layers the renderer-shape checks on top.
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: [{ path: '', message: 'manifest must be an object' }] };
  }
  // validateManifestShape mutates its input (drops bad category, normalises
  // notifications). Validate a deep clone so a dry-run never alters what the
  // agent will later submit.
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(manifest));
  } catch {
    return { ok: false, errors: [{ path: '', message: 'manifest is not JSON-serialisable' }] };
  }

  const errors = [];
  try {
    registry.validateManifestShape(clone, { strictId: true, strictNotifications: true });
  } catch (e) {
    errors.push(structuralError(e.message || String(e)));
  }

  // Renderer-shape checks only run once the structure is sound; a missing
  // meta block makes per-renderer checks meaningless.
  if (errors.length === 0) {
    errors.push(...rendererShapeErrors(clone));
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Map a validateManifestShape throw message to a {path, message}. The
// validator's messages are already prefixed (missing meta.id, invalid id:
// ..., invalid notifications: ..., etc.); we lift the obvious JSON path out
// of the prefix so the agent gets a pointer, not just prose.
function structuralError(msg) {
  const m = String(msg);
  if (/^missing \$schema|unsupported \$schema/.test(m)) return { path: '$schema', message: m };
  if (/^missing meta\.id|^invalid id/.test(m)) return { path: 'meta.id', message: m };
  if (/^missing meta\.label/.test(m)) return { path: 'meta.label', message: m };
  if (/^missing meta/.test(m)) return { path: 'meta', message: m };
  if (/^invalid notifications/.test(m)) return { path: 'meta.notifications', message: m };
  if (/^invalid schedule\.time_of_day/.test(m)) return { path: 'data.items[].schedule.time_of_day', message: m };
  return { path: '', message: m };
}

module.exports = { validateManifest, rendererShapeErrors };
