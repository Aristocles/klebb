// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-view.js
// Settings view (v2, post-Phase-0).
//
// Shows every card discovered in $HEALTH_HOME/data/ with a master enable/disable
// toggle. Toggling flips meta.enabled inside the file — no moving files, no
// archive dir. To remove a card entirely, delete the file (via chat/shell).
// To add a card, drop a valid manifest file into $HEALTH_HOME/data/ — see CARDS.md.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { errorFromResponse } from '../lib/save-error.js';

export class EhSettingsView extends LitElement {
  static properties = {
    _cards: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _busyId: { state: true },
    _filter: { state: true },
    _hiddenDiscoveries: { state: true },
    _busyMetric: { state: true },
  };

  constructor() {
    super();
    this._cards = [];
    this._loading = true;
    this._error = null;
    this._busyId = null;
    this._filter = '';
    this._hiddenDiscoveries = [];
    this._busyMetric = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
    this._loadHiddenDiscoveries();
  }

  async _loadHiddenDiscoveries() {
    try {
      const r = await fetch('/api/health-auto-export/discoveries');
      if (!r.ok) return;
      const body = await r.json();
      this._hiddenDiscoveries = Array.isArray(body.dismissed) ? body.dismissed : [];
    } catch {
      // Silent — settings still works without this section.
    }
  }

  async _unhideDiscovery(metric) {
    this._busyMetric = metric;
    try {
      const r = await fetch(
        `/api/health-auto-export/discoveries/${encodeURIComponent(metric)}/unhide`,
        { method: 'POST' });
      if (r.ok) {
        this._hiddenDiscoveries = this._hiddenDiscoveries.filter(d => d.metric !== metric);
      }
    } finally {
      this._busyMetric = null;
    }
  }

  async _load() {
    this._loading = true;
    this._error = null;
    try {
      const r = await fetch('/api/settings/cards');
      if (!r.ok) throw await errorFromResponse(r);
      const { cards } = await r.json();
      this._cards = Array.isArray(cards) ? cards : [];
    } catch (e) {
      this._error = e.message;
    } finally {
      this._loading = false;
    }
  }

  async _toggle(card) {
    this._busyId = card.id;
    this._error = null;
    try {
      const action = card.enabled ? 'disable' : 'enable';
      const r = await fetch(`/api/settings/cards/${encodeURIComponent(card.id)}/${action}`, { method: 'POST' });
      if (!r.ok) throw await errorFromResponse(r);
      await this._load();
    } catch (e) {
      this._error = e.message;
    } finally {
      this._busyId = null;
    }
  }

  _filteredCards() {
    const q = (this._filter || '').trim().toLowerCase();
    if (!q) return this._cards;
    return this._cards.filter(c => {
      const hay = `${c.id} ${c.label || ''} ${c.description || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  _groupedCards() {
    const cards = this._filteredCards();
    const enabled = cards.filter(c => c.enabled !== false);
    const disabled = cards.filter(c => c.enabled === false);
    return { enabled, disabled };
  }

  static styles = css`
    :host { display: block; max-width: 640px; margin: 0 auto; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 20px 0 6px;
    }
    .lede {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .lede a {
      color: var(--accent);
      text-decoration: underline;
    }
    .controls {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 14px;
    }
    .filter-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
      color: var(--text-primary);
      font-family: inherit;
      /* 16px prevents iOS Safari auto-zoom on focus */
      font-size: 16px;
    }
    .filter-input:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
      border-color: var(--accent);
    }
    .count-summary {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }
    .group-header {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted, var(--text-secondary));
      margin: 16px 0 6px;
      padding: 0 4px;
    }
    .group-header:first-child { margin-top: 0; }
    .card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      background: var(--bg-card);
    }
    .card.disabled { opacity: 0.55; }
    .card-main { flex: 1; min-width: 0; }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .card-sub {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .id {
      font-family: ui-monospace, monospace;
      font-size: 10px;
      color: var(--text-muted, var(--text-secondary));
      opacity: 0.6;
      margin-left: 6px;
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
    .toggle[aria-pressed="true"] {
      background: var(--accent);
    }
    .toggle[aria-pressed="true"]::after {
      transform: translateX(20px);
    }
    .toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .toggle[disabled] { opacity: 0.5; cursor: wait; }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--text-secondary);
      font-size: 13px;
      border: 1px dashed var(--border);
      border-radius: 10px;
    }
    .empty code {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      background: var(--bg-muted, rgba(255,255,255,0.04));
      padding: 1px 6px;
      border-radius: 4px;
    }
    .no-matches {
      padding: 24px;
      text-align: center;
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
    }
    .error { color: #ff4466; font-size: 12px; padding: 8px 0; }

    /* Respect reduced-motion preference */
    @media (prefers-reduced-motion: reduce) {
      .toggle, .toggle::after { transition: none; }
    }

    .discovery-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 20px;
    }
    .discovery-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
    }
    .discovery-label {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 13px;
      color: var(--text-primary);
    }
    .unhide-btn {
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
    }
    .unhide-btn:hover:not(:disabled) {
      border-color: var(--accent);
      color: var(--accent);
    }
    .unhide-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  `;

  _onFilterInput(e) {
    this._filter = e.target.value;
  }

  _onToggleKeydown(e, card) {
    // Space + Enter already toggle native <button>s, but the aria-pressed
    // role means screen readers expect explicit keyboard support on both.
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this._toggle(card);
    }
  }

  render() {
    if (this._loading) return html`<div class="lede">Loading…</div>`;

    const { enabled, disabled } = this._groupedCards();
    const totalShown = enabled.length + disabled.length;
    const totalAll = this._cards.length;

    return html`
      ${this._hiddenDiscoveries.length > 0 ? html`
        <h2>Hidden Apple Health metrics</h2>
        <div class="lede">
          Metrics you've dismissed from the discovery prompt. Un-hide to see
          them again the next time a push arrives.
        </div>
        <div class="discovery-list">
          ${this._hiddenDiscoveries.map(d => html`
            <div class="discovery-row">
              <span class="discovery-label">${d.metric}</span>
              <button
                class="unhide-btn"
                ?disabled=${this._busyMetric === d.metric}
                @click=${() => this._unhideDiscovery(d.metric)}
              >Un-hide</button>
            </div>
          `)}
        </div>
      ` : ''}

      <h2>Cards</h2>
      <div class="lede">
        Every card is a file in <code>$HEALTH_HOME/data/</code>. Toggle off to
        hide a card (keeps the data); delete the file to remove it entirely.
        <a href="https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md" target="_blank" rel="noopener">How to add a card →</a>
      </div>

      ${totalAll > 0 ? html`
        <div class="controls">
          <input
            class="filter-input"
            type="search"
            placeholder="Filter by name or id…"
            .value=${this._filter}
            @input=${this._onFilterInput}
            aria-label="Filter cards"
          />
          <span class="count-summary">
            ${this._cards.filter(c => c.enabled !== false).length} on
            · ${this._cards.filter(c => c.enabled === false).length} off
          </span>
        </div>
      ` : ''}

      ${this._cards.length === 0 ? html`
        <div class="empty">
          No cards yet. Drop a manifest file into <code>$HEALTH_HOME/data/</code>
          or ask the chat agent to create one.
        </div>
      ` : totalShown === 0 ? html`
        <div class="no-matches">
          No cards match "${this._filter}".
        </div>
      ` : html`
        ${enabled.length > 0 ? html`
          <div class="group-header">Enabled · ${enabled.length}</div>
          ${enabled.map(c => this._renderCard(c))}
        ` : ''}
        ${disabled.length > 0 ? html`
          <div class="group-header">Disabled · ${disabled.length}</div>
          ${disabled.map(c => this._renderCard(c))}
        ` : ''}
      `}

      ${this._error ? html`<div class="error">${this._error}</div>` : ''}
    `;
  }

  _renderCard(c) {
    return html`
      <div class="card ${c.enabled ? '' : 'disabled'}">
        <div class="card-main">
          <div class="card-title">
            ${c.emoji || ''} ${c.label || c.id}
            <span class="id">${c.id}</span>
          </div>
          ${c.description ? html`<div class="card-sub">${c.description}</div>` : ''}
        </div>
        <button
          class="toggle"
          role="switch"
          aria-checked="${c.enabled}"
          aria-pressed="${c.enabled}"
          aria-label="${c.enabled ? 'Disable' : 'Enable'} ${c.label || c.id}"
          ?disabled=${this._busyId === c.id}
          @click=${() => this._toggle(c)}
          @keydown=${(e) => this._onToggleKeydown(e, c)}
        ></button>
      </div>
    `;
  }
}
customElements.define('eh-settings-view', EhSettingsView);
