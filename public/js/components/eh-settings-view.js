// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-view.js
//
// Settings shell. Five tabs: General, Notifications, Security, Cards,
// Diagnostics. Active tab is component-local state. No router lib, no URL
// hash, no history API: settings is a single page in the app shell, the
// active tab does not need to be bookmarkable, and there is no second
// consumer that would justify a reusable tabs primitive.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './eh-settings-general.js';
import './eh-settings-notifications.js';
import './eh-settings-security.js';
import './eh-settings-cards.js';
import './eh-settings-diagnostics.js';

const TABS = [
  { id: 'general',       label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'security',      label: 'Security' },
  { id: 'cards',         label: 'Cards' },
  { id: 'diagnostics',   label: 'Diagnostics' },
];

export class EhSettingsView extends LitElement {
  static properties = {
    _activeTab: { state: true },
  };

  constructor() {
    super();
    this._activeTab = 'general';
  }

  _onTabClick(id) {
    this._activeTab = id;
  }

  // Arrow-key navigation across the tab strip. ArrowLeft/ArrowRight move
  // selection; Home/End jump to the ends. Matches WAI-ARIA tabs pattern.
  _onTabKey(e) {
    const idx = TABS.findIndex(t => t.id === this._activeTab);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    this._activeTab = TABS[next].id;
    const btn = this.renderRoot.querySelector(`[data-tab="${TABS[next].id}"]`);
    if (btn) btn.focus();
  }

  static styles = css`
    :host { display: block; max-width: 640px; margin: 0 auto; }

    .tabstrip {
      display: flex;
      gap: 4px;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
    }
    .tabstrip::-webkit-scrollbar { display: none; }

    .tab {
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      padding: 10px 14px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
      scroll-snap-align: start;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab:hover {
      color: var(--text-primary);
    }
    .tab[aria-selected="true"] {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .tab:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
      border-radius: 4px;
    }

    @media (prefers-reduced-motion: reduce) {
      .tab { transition: none; }
    }
  `;

  render() {
    return html`
      <div class="tabstrip" role="tablist" @keydown=${this._onTabKey}>
        ${TABS.map(t => html`
          <button
            class="tab"
            role="tab"
            data-tab=${t.id}
            id="tab-${t.id}"
            aria-selected=${this._activeTab === t.id}
            aria-controls="panel-${t.id}"
            tabindex=${this._activeTab === t.id ? 0 : -1}
            @click=${() => this._onTabClick(t.id)}
          >${t.label}</button>
        `)}
      </div>

      <div role="tabpanel" id="panel-general" aria-labelledby="tab-general"
           ?hidden=${this._activeTab !== 'general'}>
        ${this._activeTab === 'general' ? html`<eh-settings-general></eh-settings-general>` : ''}
      </div>
      <div role="tabpanel" id="panel-notifications" aria-labelledby="tab-notifications"
           ?hidden=${this._activeTab !== 'notifications'}>
        ${this._activeTab === 'notifications' ? html`<eh-settings-notifications></eh-settings-notifications>` : ''}
      </div>
      <div role="tabpanel" id="panel-security" aria-labelledby="tab-security"
           ?hidden=${this._activeTab !== 'security'}>
        ${this._activeTab === 'security' ? html`<eh-settings-security></eh-settings-security>` : ''}
      </div>
      <div role="tabpanel" id="panel-cards" aria-labelledby="tab-cards"
           ?hidden=${this._activeTab !== 'cards'}>
        ${this._activeTab === 'cards' ? html`<eh-settings-cards></eh-settings-cards>` : ''}
      </div>
      <div role="tabpanel" id="panel-diagnostics" aria-labelledby="tab-diagnostics"
           ?hidden=${this._activeTab !== 'diagnostics'}>
        ${this._activeTab === 'diagnostics' ? html`<eh-settings-diagnostics></eh-settings-diagnostics>` : ''}
      </div>
    `;
  }
}
customElements.define('eh-settings-view', EhSettingsView);
