// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-general.js
//
// Settings > General pane. Today: dark/light theme toggle, instance label,
// build info. Future home for any global preference that doesn't belong
// in a more specific tab.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { readTheme, setTheme } from '../lib/theme.js';

export class EhSettingsGeneral extends LitElement {
  static properties = {
    _theme: { state: true },
    _instance: { state: true },
    _build: { state: true },
  };

  constructor() {
    super();
    this._theme = readTheme();
    this._instance = null;
    this._build = null;
    this._onThemeChanged = (e) => { this._theme = e.detail.theme; };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('klebb-theme-changed', this._onThemeChanged);
    this._loadInstance();
    this._loadBuild();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('klebb-theme-changed', this._onThemeChanged);
  }

  async _loadInstance() {
    try {
      const r = await fetch('/api/instance');
      if (!r.ok) return;
      this._instance = await r.json();
    } catch {}
  }

  async _loadBuild() {
    try {
      const r = await fetch('/api/build');
      if (!r.ok) return;
      this._build = await r.json();
    } catch {}
  }

  _onThemeToggle(e) {
    setTheme(e.target.checked ? 'dark' : 'light');
  }

  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    .lede {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      background: var(--bg-card);
    }
    .row-label {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .row-sub {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    .row-main { flex: 1; min-width: 0; }
    .row-value {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--text-secondary);
      text-align: right;
      overflow-wrap: anywhere;
    }
    .toggle {
      appearance: none;
      width: 44px;
      height: 24px;
      border-radius: 12px;
      background: var(--border);
      position: relative;
      cursor: pointer;
      border: none;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    .toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--bg-card);
      transition: transform 0.15s;
    }
    .toggle:checked { background: var(--accent); }
    .toggle:checked::after { transform: translateX(20px); }
    .toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .toggle, .toggle::after { transition: none; }
    }
  `;

  render() {
    return html`
      <h2>General</h2>
      <div class="lede">
        Theme and instance information.
      </div>

      <label class="row">
        <span class="row-main">
          <span class="row-label">Dark theme</span>
          <div class="row-sub">Switch between the light and dark colour palette.</div>
        </span>
        <input
          type="checkbox"
          class="toggle"
          .checked=${this._theme === 'dark'}
          @change=${this._onThemeToggle}
          aria-label="Dark theme"
        >
      </label>

      ${this._instance ? html`
        <div class="row">
          <span class="row-main">
            <span class="row-label">Instance</span>
            <div class="row-sub">The name shown in the navigation and on devices.</div>
          </span>
          <span class="row-value">${this._instance.name || 'Klebb'}</span>
        </div>
      ` : ''}

      ${this._build && (this._build.branch || this._build.commitShort) ? html`
        <div class="row">
          <span class="row-main">
            <span class="row-label">Build</span>
            <div class="row-sub">${this._build.builtAt || 'Local build'}</div>
          </span>
          <span class="row-value">
            ${this._build.branch || ''}${this._build.branch && this._build.commitShort ? ' @ ' : ''}${this._build.commitShort || ''}
          </span>
        </div>
      ` : ''}
    `;
  }
}
customElements.define('eh-settings-general', EhSettingsGeneral);
