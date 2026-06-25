// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/sparkline.esm.js
// ES-module mirror of the sparkline scaling + path maths. Keep in sync
// with sparkline.js (UMD): Node tests use the UMD version, the
// eh-sparkline component imports this one.

// A single point is not a trend; below this we render nothing.
export const MIN_POINTS = 2;

function toNumbers(values) {
  return (Array.isArray(values) ? values : [])
    .map(v => (v === null || v === undefined || v === '' ? null : Number(v)));
}

export function buildSparklinePath(values, opts = {}) {
  const width = Number(opts.width) || 64;
  const height = Number(opts.height) || 22;
  const pad = opts.pad == null ? 2 : Number(opts.pad);

  const nums = toNumbers(values);
  const finite = nums.filter(v => v !== null && Number.isFinite(v));
  const empty = { points: '', count: 0, lastPoint: null, min: 0, max: 0 };
  if (finite.length < MIN_POINTS) return empty;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = (max - min) || 1;
  const innerH = height - 2 * pad;
  const stepX = nums.length > 1 ? (width - 2 * pad) / (nums.length - 1) : 0;

  const scaleY = (v) => height - pad - ((v - min) / range) * innerH;
  const scaleX = (i) => pad + i * stepX;

  const coords = [];
  nums.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    coords.push({ x: round(scaleX(i)), y: round(scaleY(v)) });
  });

  const points = coords.map(c => `${c.x},${c.y}`).join(' ');
  const lastPoint = coords.length ? coords[coords.length - 1] : null;
  return { points, count: coords.length, lastPoint, min, max };
}

export function referenceY(values, value, opts = {}) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const height = Number(opts.height) || 22;
  const pad = opts.pad == null ? 2 : Number(opts.pad);

  const finite = toNumbers(values).filter(v => v !== null && Number.isFinite(v));
  if (finite.length < MIN_POINTS) return null;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = (max - min) || 1;
  const innerH = height - 2 * pad;
  return round(height - pad - ((Number(value) - min) / range) * innerH);
}

export function summarise(values) {
  const finite = toNumbers(values).filter(v => v !== null && Number.isFinite(v));
  if (finite.length === 0) return { direction: 'flat', latest: null, label: 'no data' };

  const latest = finite[finite.length - 1];
  let direction = 'flat';
  if (finite.length >= MIN_POINTS) {
    const prev = finite[finite.length - 2];
    if (latest > prev) direction = 'up';
    else if (latest < prev) direction = 'down';
  }
  return { direction, latest, label: `trend ${direction}, latest ${trim(latest)}` };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function trim(n) {
  return Number.isInteger(n) ? String(n) : String(round(n));
}
