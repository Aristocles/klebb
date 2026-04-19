// public/js/components/eh-base-card.js
// Base class for every generic renderer card.
//
// Every card receives:
//   .card        — the manifest entry { id, meta, viewConfig }
//   .data        — data block fetched from /api/manifests/:id/data
//   .date        — ISO date string (YYYY-MM-DD) representing the current DateView context
//   .dateMode    — "today" | "past" | "future"
//   .config      — the meta.<viewName> block for the current view
//   .writeable   — { fromWebapp, pastAllowed, todayAllowed, futureAllowed }
//
// Subclasses implement renderCard() and optionally renderExpanded().
// The base handles the shell chrome: header, expand/collapse, loading,
// and error states. All styling uses CSS variables so light/dark themes
// work automatically.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhBaseCard extends LitElement {
  static properties = {
    card: { type: Object },          // { id, meta, viewConfig }
    data: { state: true },
    date: { type: String },
    dateMode: { type: String },      // today | past | future
    expanded: { state: true },
    loading: { state: true },
    error: { state: true },
  };

  constructor() {
    super();
    this.card = null;
    this.data = null;
    this.date = null;
    this.dateMode = 'today';
    this.expanded = false;
    this.loading = true;
    this.error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  async _fetchData() {
    if (!this.card?.id) return;
    this.loading = true;
    this.error = null;
    try {
      const res = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      this.data = body.data;
    } catch (e) {
      this.error = e.message || 'fetch failed';
    } finally {
      this.loading = false;
    }
  }

  // Subclasses override these
  renderCard() {
    return html`<div class="card-body">—</div>`;
  }

  renderExpanded() {
    return html`<div class="card-expanded">No detail available.</div>`;
  }

  // Is this view's click-expand enabled for this card?
  get _canExpand() {
    const exp = this.card?.viewConfig?.expanded;
    return exp && exp.enabled === true;
  }

  get _config() {
    return this.card?.viewConfig || {};
  }

  get _meta() {
    return this.card?.meta || {};
  }

  // Can we edit on this date?
  get _canWrite() {
    const w = this._meta.writeable;
    if (!w || !w.fromWebapp) return false;
    if (this.dateMode === 'today')  return w.todayAllowed !== false;
    if (this.dateMode === 'past')   return w.pastAllowed === true;
    if (this.dateMode === 'future') return w.futureAllowed === true;
    return false;
  }

  _toggleExpand() {
    if (!this._canExpand) return;
    this.expanded = !this.expanded;
  }

  static styles = css`
    :host {
      display: block;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.08));
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px 6px;
      cursor: default;
      user-select: none;
    }
    .card-header.clickable { cursor: pointer; }
    .card-header.clickable:hover { background: var(--bg-hover, rgba(255,255,255,0.03)); }
    .title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--text-muted, var(--text-secondary));
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title .emoji { font-size: 14px; }
    .expand-indicator {
      color: var(--text-muted, var(--text-secondary));
      font-size: 11px;
      transition: transform 0.15s;
    }
    .expand-indicator.open { transform: rotate(180deg); }
    .card-body { padding: 6px 16px 16px; }
    .card-expanded {
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border);
      background: var(--bg-input, transparent);
    }
    .future-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      background: var(--accent-bg, rgba(255,170,0,0.15));
      color: var(--accent-amber, #ffaa00);
      font-weight: 600;
    }
    .past-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      background: var(--bg-hover, rgba(255,255,255,0.05));
      color: var(--text-muted, var(--text-secondary));
      font-weight: 600;
    }
    .error-placeholder {
      padding: 10px 14px;
      font-size: 12px;
      color: var(--accent-red, #ff4444);
      background: rgba(255, 68, 68, 0.06);
      border-top: 1px solid var(--border);
    }
    .loading {
      padding: 16px;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      text-align: center;
    }
  `;

  render() {
    const m = this._meta;
    return html`
      <div
        class="card-header ${this._canExpand ? 'clickable' : ''}"
        @click=${this._canExpand ? this._toggleExpand : undefined}
      >
        <div class="title">
          ${m.emoji ? html`<span class="emoji">${m.emoji}</span>` : ''}
          <span>${m.label || m.id || ''}</span>
          ${this.dateMode === 'future' ? html`<span class="future-badge">🔮 Planned</span>` : ''}
          ${this.dateMode === 'past'   ? html`<span class="past-badge">Past</span>` : ''}
        </div>
        ${this._canExpand ? html`
          <span class="expand-indicator ${this.expanded ? 'open' : ''}">▼</span>
        ` : ''}
      </div>
      ${this.loading ? html`<div class="loading">Loading…</div>` : ''}
      ${this.error ? html`<div class="error-placeholder">⚠︎ ${this._meta.label || this.card?.id}: ${this.error}</div>` : ''}
      ${!this.loading && !this.error ? html`
        <div class="card-body">${this._safeRender(() => this.renderCard())}</div>
        ${this.expanded ? html`<div class="card-expanded">${this._safeRender(() => this.renderExpanded())}</div>` : ''}
      ` : ''}
    `;
  }

  _safeRender(fn) {
    try {
      return fn();
    } catch (e) {
      console.error(`[${this.card?.id || 'card'}] render error`, e);
      return html`<div class="error-placeholder">Render failed: ${e.message}</div>`;
    }
  }
}
