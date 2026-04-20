// public/js/components/eh-view-renderer.js
// Generic view composer. Fetches /api/views/:viewName, resolves each card's
// renderer via the renderer-registry, instantiates it with the right props.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { resolveRenderer } from '../renderer-registry.js';

// Ensure all core renderers are loaded
import './eh-unknown-card.js';
import './eh-metric-card.js';
import './eh-notes-card.js';
import './eh-greeting-banner.js';
import './eh-checklist-card.js';
import './eh-schedule-card.js';
import './eh-markdown-doc.js';
import './eh-line-chart.js';
import './eh-schedule-timeline.js';
import './eh-adherence-report.js';
import './eh-table-list.js';
import './eh-mood-card.js';

export class EhViewRenderer extends LitElement {
  static properties = {
    view: { type: String },       // "view" | "trends" | "reports" | etc.
    date: { type: String },
    dateMode: { type: String },
    cards: { state: true },
    _loading: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this.view = 'view';
    this.date = null;
    this.dateMode = 'today';
    this.cards = [];
    this._loading = true;
    this._error = null;
  }

  static styles = css`
    :host { display: block; }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
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
    }
    .slot-top {
      grid-column: 1 / -1;
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

  render() {
    if (this._loading) {
      return html`<div class="loading">Loading…</div>`;
    }
    if (this._error) {
      return html`<div class="loading">Failed to load: ${this._error}</div>`;
    }
    if (!this.cards || this.cards.length === 0) {
      return html`<div class="empty">No cards for this view.</div>`;
    }
    // Render into a grid; ensure slot="top" cards span the full row
    return html`
      <div class="grid">
        ${this.cards.map(c => this._renderCard(c))}
      </div>
    `;
  }
}
customElements.define('eh-view-renderer', EhViewRenderer);
