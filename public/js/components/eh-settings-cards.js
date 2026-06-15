// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-cards.js
//
// Settings > Cards pane. Master enable/disable for every card discovered
// in $HEALTH_HOME/data/. Toggling flips meta.enabled inside the file.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { repeat } from 'https://esm.sh/lit@3/directives/repeat.js';
import { errorFromResponse } from '../lib/save-error.js';

export class EhSettingsCards extends LitElement {
  static properties = {
    _cards: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _busyId: { state: true },
    _filter: { state: true },
    _demo: { state: true },
  };

  constructor() {
    super();
    this._cards = [];
    this._loading = true;
    this._error = null;
    this._busyId = null;
    this._filter = '';
    this._demo = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
    this._loadDemoFlag();
  }

  async _loadDemoFlag() {
    try {
      const r = await fetch('/api/instance');
      if (!r.ok) return;
      const j = await r.json();
      this._demo = !!j.demo;
    } catch {}
  }

  // Set `silent` when refreshing after a toggle: swapping the card
  // list into "Loading…" for a moment collapses the page height and
  // jerks the scroll position (see #194). On a refresh we have card
  // state already — keep it on screen until the new data lands.
  async _load({ silent = false } = {}) {
    if (!silent) this._loading = true;
    this._error = null;
    try {
      const r = await fetch('/api/settings/cards');
      if (!r.ok) throw await errorFromResponse(r);
      const { cards } = await r.json();
      this._cards = Array.isArray(cards) ? cards : [];
    } catch (e) {
      this._error = e.message;
    } finally {
      if (!silent) this._loading = false;
    }
  }

  async _toggle(card) {
    this._busyId = card.id;
    this._error = null;
    try {
      const action = card.enabled ? 'disable' : 'enable';
      const r = await fetch(`/api/settings/cards/${encodeURIComponent(card.id)}/${action}`, { method: 'POST' });
      if (!r.ok) throw await errorFromResponse(r);
      await this._load({ silent: true });
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

  _sortedCards() {
    return [...this._filteredCards()].sort((a, b) => {
      const la = (a.label || a.id || '').toLowerCase();
      const lb = (b.label || b.id || '').toLowerCase();
      return la.localeCompare(lb);
    });
  }

  _onFilterInput(e) {
    this._filter = e.target.value;
  }

  _onToggleKeydown(e, card) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this._toggle(card);
    }
  }

  _enterReorderMode() {
    // Reorder is a visual task that happens on the Today page. Set a
    // one-shot flag so the view renderer flips into reorder mode as
    // soon as it mounts on / and finishes its first card fetch.
    try { sessionStorage.setItem('klebb-pending-reorder', '1'); } catch {}
    window.dispatchEvent(new CustomEvent('navigate', { detail: { path: '/' } }));
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
    .reorder-section {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-card);
      padding: 12px 14px;
      margin-bottom: 14px;
    }
    .reorder-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .reorder-blurb {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .reorder-btn {
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-muted, rgba(255,255,255,0.04));
      color: var(--text-primary);
      cursor: pointer;
      width: 100%;
      text-align: center;
    }
    .reorder-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .reorder-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
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

    @media (prefers-reduced-motion: reduce) {
      .toggle, .toggle::after { transition: none; }
    }
  `;

  render() {
    if (this._loading) return html`<div class="lede">Loading…</div>`;

    const sorted = this._sortedCards();
    const totalShown = sorted.length;
    const totalAll = this._cards.length;
    const enabled = this._cards.filter(c => c.enabled !== false).length;
    const disabled = this._cards.filter(c => c.enabled === false).length;

    return html`
      <h2>Cards</h2>
      <div class="lede">
        ${this._demo ? html`
          Card visibility is locked in the public demo. Run your own instance to
          toggle, add, or delete cards.
        ` : html`
          Every card is a file in <code>$HEALTH_HOME/data/</code>. Toggle off to
          hide a card (keeps the data); delete the file to remove it entirely.
          <a href="https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md" target="_blank" rel="noopener">How to add a card →</a>
        `}
      </div>

      ${!this._demo && totalAll >= 2 ? html`
        <section class="reorder-section">
          <div class="reorder-title">⋮⋮ Reorder cards on Today</div>
          <div class="reorder-blurb">
            Tapping below takes you to the Today page so you can drag your
            cards into a new order. Tap <strong>Done</strong> on the
            reorder bar there when you're finished.
          </div>
          <button class="reorder-btn" @click=${this._enterReorderMode}>
            Reorder cards on Today
          </button>
        </section>
      ` : ''}

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
          <span class="count-summary">${enabled} on · ${disabled} off</span>
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
        ${repeat(sorted, c => c.id, c => this._renderCard(c))}
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
          ?disabled=${this._demo || this._busyId === c.id}
          title="${this._demo ? 'Locked in demo mode' : ''}"
          @click=${() => { if (!this._demo) this._toggle(c); }}
          @keydown=${(e) => { if (!this._demo) this._onToggleKeydown(e, c); }}
        ></button>
      </div>
    `;
  }
}
customElements.define('eh-settings-cards', EhSettingsCards);
