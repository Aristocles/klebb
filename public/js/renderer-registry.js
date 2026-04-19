// public/js/renderer-registry.js
// Central registry mapping component name strings (from data file meta.view.component)
// to Lit web component tag names.
//
// Usage:
//   import { registerRenderer, resolveRenderer } from './renderer-registry.js';
//   registerRenderer('metric-card', 'eh-metric-card');
//   const tag = resolveRenderer('metric-card', 'view'); // -> 'eh-metric-card' or fallback
//
// The fallback when a component is unknown is 'eh-unknown-card' which shows
// a small inline error placeholder. Keeps the UI resilient to typos or
// renderer-not-yet-implemented components.

const _registry = new Map();

export function registerRenderer(componentName, tagName) {
  _registry.set(componentName, tagName);
}

export function resolveRenderer(componentName) {
  if (!componentName) return null;
  return _registry.get(componentName) || 'eh-unknown-card';
}

export function listRenderers() {
  return Array.from(_registry.keys()).sort();
}
