// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/lib/theme.js
//
// Theme: read/write the user's light/dark preference. The preference
// lives in localStorage under `klebb-theme` and is reflected on
// document.documentElement via the `data-theme` attribute, which all
// CSS variables key off.

const KEY = 'klebb-theme';
const DEFAULT_THEME = 'light';

export function readTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem(KEY, next); } catch {}
  applyTheme(next);
  window.dispatchEvent(new CustomEvent('klebb-theme-changed', {
    detail: { theme: next },
  }));
  return next;
}

export function toggleTheme() {
  return setTheme(readTheme() === 'dark' ? 'light' : 'dark');
}
