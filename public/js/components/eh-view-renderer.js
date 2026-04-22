// public/js/components/eh-view-renderer.js
// Generic view composer. Fetches /api/views/:viewName, resolves each card's
// renderer via the renderer-registry, instantiates it with the right props.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { resolveRenderer } from '../renderer-registry.js';

// Ensure all core renderers are loaded
import './eh-unknown-card.js';
import './eh-generic-card.js';
import './eh-greeting-banner.js';
import './eh-checklist-card.js';
import './eh-schedule-card.js';
import './eh-markdown-doc.js';
import './eh-line-chart.js';
import './eh-schedule-timeline.js';
import './eh-adherence-report.js';
import './eh-table-list.js';

export class EhViewRenderer extends LitElement {
  static properties = {
    view: { type: String },       // "view" | "trends" | "reports" | etc.
    date: { type: String },
    dateMode: { type: String },
    cards: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _manifestErrors: { state: true },
    _allCardsCount: { state: true },
    _disabledCount: { state: true },
    _errorsExpanded: { state: true },
  };

  constructor() {
    super();
    this.view = 'view';
    this.date = null;
    this.dateMode = 'today';
    this.cards = [];
    this._loading = true;
    this._error = null;
    this._manifestErrors = [];
    this._allCardsCount = 0;
    this._disabledCount = 0;
    this._errorsExpanded = false;
  }

  static styles = css`
    :host { display: block; }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      margin-top: 6px;
    }
    @media (min-width: 768px) {
      .grid {
        grid-template-columns: 1fr 1fr;
      }
    }
    @media (min-width: 1100px) {
      .grid {
        grid-template-columns: 1fr 1fr 1fr;
      }
    }
    .loading, .empty {
      padding: 40px 20px;
      text-align: center;
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      line-height: 1.5;
    }
    .empty code {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      background: var(--bg-muted, rgba(255,255,255,0.04));
      padding: 2px 6px;
      border-radius: 4px;
    }
    .slot-top {
      grid-column: 1 / -1;
    }
    .error-pill {
      background: var(--bg-card);
      border: 1px solid #ff7733;
      border-left-width: 4px;
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 10px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      user-select: none;
    }
    .error-pill:hover { border-color: #ff4466; }
    .error-pill-icon { margin-right: 6px; }
    .error-list {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
      font-family: ui-monospace, monospace;
      font-size: 11px;
      text-align: left;
    }
    .error-list-item {
      padding: 2px 0;
      color: var(--text-secondary);
    }
    .error-list-file { color: var(--text-primary); font-weight: 600; }
    .disabled-hint {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px 18px;
      margin-bottom: 10px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-primary);
      text-align: left;
    }
    .disabled-hint a {
      color: var(--accent);
      text-decoration: underline;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._fetchCards();
  }

  updated(changed) {
    // The card LIST only depends on the view name — not the date.
    // Don't re-fetch /api/views/:name when only the date changed; just
    // update the date/dateMode props on the child cards (Lit handles that
    // via the standard property reactivity in render()).
    if (changed.has('view')) {
      this._fetchCards();
    }
  }

  async _fetchCards() {
    this._loading = true;
    this._error = null;
    try {
      const res = await fetch(`/api/views/${encodeURIComponent(this.view)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      this.cards = Array.isArray(body.cards) ? body.cards : [];
      this._manifestErrors = Array.isArray(body.errors) ? body.errors : [];
      // If the view returned 0 cards, peek at the Settings list to figure
      // out WHY — to give a useful empty-state message.
      if (this.cards.length === 0) {
        try {
          const s = await fetch('/api/settings/cards');
          if (s.ok) {
            const sBody = await s.json();
            this._allCardsCount = Array.isArray(sBody.cards) ? sBody.cards.length : 0;
            this._disabledCount = Array.isArray(sBody.cards)
              ? sBody.cards.filter(c => c.enabled === false).length
              : 0;
          }
        } catch {}
      }
    } catch (e) {
      this._error = e.message || 'fetch failed';
    } finally {
      this._loading = false;
    }
  }

  _renderCard(card) {
    const tag = resolveRenderer(card.viewConfig?.component);
    const isTopSlot = card.viewConfig?.slot === 'top';
    // Create element dynamically to set `card` prop correctly
    const el = document.createElement(tag);
    el.card = card;
    el.date = this.date;
    el.dateMode = this.dateMode;
    if (isTopSlot) el.className = 'slot-top';
    return el;
  }

  _renderErrorPill() {
    const errs = this._manifestErrors || [];
    if (errs.length === 0) return '';
    return html`
      <div
        class="error-pill"
        role="button"
        tabindex="0"
        aria-expanded="${this._errorsExpanded}"
        @click=${() => { this._errorsExpanded = !this._errorsExpanded; }}
        @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._errorsExpanded = !this._errorsExpanded; } }}
      >
        <span class="error-pill-icon">⚠︎</span>
        ${errs.length} manifest file${errs.length === 1 ? '' : 's'} failed to load
        — click to ${this._errorsExpanded ? 'hide' : 'show'}
        ${this._errorsExpanded ? html`
          <div class="error-list">
            ${errs.map(e => html`
              <div class="error-list-item">
                <span class="error-list-file">${e.file}</span>: ${e.error}
              </div>
            `)}
          </div>
        ` : ''}
      </div>
    `;
  }

  _renderAllDisabledHint() {
    return html`
      <div class="disabled-hint">
        <strong>All cards are hidden.</strong>
        You have ${this._disabledCount} card${this._disabledCount === 1 ? '' : 's'}
        but they're all toggled off.
        Head to <a href="/settings">Settings</a> to re-enable some.
      </div>
    `;
  }

  render() {
    if (this._loading) {
      return html`<div class="loading">Loading…</div>`;
    }
    if (this._error) {
      return html`<div class="loading">Failed to load: ${this._error}</div>`;
    }
    if (!this.cards || this.cards.length === 0) {
      // Three empty-state shapes, most-specific first:
      // (1) There ARE cards but they're all disabled → point at Settings
      // (2) There are NO cards at all → docs link
      // (3) Fallback (e.g. cards exist but none have data yet)
      if (this._allCardsCount > 0 && this._disabledCount === this._allCardsCount) {
        return html`
          ${this._renderErrorPill()}
          ${this._renderAllDisabledHint()}
        `;
      }
      if (this._allCardsCount === 0) {
        return html`
          ${this._renderErrorPill()}
          <div class="empty">
            <p>No cards yet.</p>
            <p style="margin-top:8px;">
              Drop a manifest file into <code>$HEALTH_HOME/data/</code> to add
              one, or
              <a href="https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md"
                 target="_blank" rel="noopener"
                 style="color: var(--accent); text-decoration: underline;">
                read the docs →
              </a>
            </p>
          </div>
        `;
      }
      return html`
        ${this._renderErrorPill()}
        <div class="empty">
          <p>No data yet for this view.</p>
          <p style="margin-top:8px;">
            Your cards are set up but nothing's been logged yet.
            Switch to <a href="/" style="color: var(--accent);">Today</a>
            and tap ➕ to log your first entry.
          </p>
        </div>
      `;
    }
    // Normal render
    return html`
      ${this._renderErrorPill()}
      <div class="grid">
        ${this.cards.map(c => this._renderCard(c))}
      </div>
    `;
  }
}
customElements.define('eh-view-renderer', EhViewRenderer);
