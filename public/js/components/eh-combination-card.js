// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-combination-card.js
// Read-only composite renderer. Consumes meta.view.combines[] and
// surfaces one row per combined source for the viewed date.
//
// Opt a manifest into this renderer by setting:
//   meta.view.component = "combination-card"
//   meta.view.layout    = "stack"   (MVP; "rings" and "chart" reserved)
//   meta.view.combines  = [ { sourceId, role, label?, accessor?, unit?, emojiMap? } ]
//
// See MANIFEST-SCHEMA.md "Combination cards" for the full contract.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { registerRenderer } from '../renderer-registry.js';
import { resolveCombines } from '../lib/combines-resolver.esm.js';

export class EhCombinationCard extends LitElement {
  static properties = {
    card: { type: Object },
    date: { type: String },
    dateMode: { type: String },
    _sources: { state: true },   // { [sourceId]: { loaded, data, meta } }
    _loading: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this.card = null;
    this.date = null;
    this.dateMode = 'today';
    this._sources = {};
    this._loading = true;
    this._error = null;
    this._onDataChanged = this._onDataChanged.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('manifest-data-changed', this._onDataChanged);
    this._fetchAll();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('manifest-data-changed', this._onDataChanged);
  }

  _onDataChanged(e) {
    const changedId = e?.detail?.id;
    if (!changedId) return;
    const combines = this._combines();
    if (combines.some(c => c.sourceId === changedId)) this._fetchAll();
  }

  _combines() {
    const vc = this.card?.viewConfig || {};
    return Array.isArray(vc.combines) ? vc.combines : [];
  }

  _layout() {
    const l = this.card?.viewConfig?.layout || 'stack';
    // Unknown layouts fall back to stack (documented behaviour).
    return l === 'stack' ? 'stack' : 'stack';
  }

  async _fetchAll() {
    this._loading = true;
    this._error = null;
    const ids = [...new Set(this._combines().map(c => c.sourceId).filter(Boolean))];
    const entries = await Promise.all(ids.map(id => this._fetchOne(id)));
    const next = {};
    for (const { id, loaded, data, meta } of entries) {
      next[id] = { loaded, data, meta };
    }
    this._sources = next;
    this._loading = false;
  }

  async _fetchOne(id) {
    try {
      const [dataRes, metaRes] = await Promise.all([
        fetch(`/api/manifests/${encodeURIComponent(id)}/data`),
        fetch(`/api/manifests/${encodeURIComponent(id)}`),
      ]);
      if (!dataRes.ok) return { id, loaded: false, data: null, meta: null };
      const dataBody = await dataRes.json();
      const metaBody = metaRes.ok ? await metaRes.json() : null;
      return {
        id,
        loaded: true,
        data: dataBody.data,
        meta: metaBody?.meta || null,
      };
    } catch {
      return { id, loaded: false, data: null, meta: null };
    }
  }

  updated(changed) {
    if (changed.has('card')) this._fetchAll();
  }

  _renderRow(resolved) {
    const label = resolved.label || resolved.sourceId;
    const roleClass = `role-${resolved.role || 'annotation'}`;

    if (resolved.state !== 'ok') {
      const hint = resolved.state === 'no-source' ? 'source not loaded'
                 : resolved.state === 'no-entry' ? 'no entry for this date'
                 : 'no value';
      return html`
        <div class="row ${roleClass} placeholder">
          <span class="row-label">${label}</span>
          <span class="row-placeholder">${hint}</span>
        </div>
      `;
    }

    return html`
      <div class="row ${roleClass}">
        <span class="row-label">${label}</span>
        <span class="row-value">
          ${resolved.displayValue}
          ${resolved.unit ? html`<span class="row-unit">${resolved.unit}</span>` : ''}
        </span>
      </div>
    `;
  }

  render() {
    const m = this.card?.meta || {};
    const combines = this._combines();

    if (this._loading) {
      return html`
        <div class="shell">
          <div class="header">
            ${m.emoji ? html`<span class="emoji">${m.emoji}</span>` : ''}
            <span class="title">${m.label || m.id || ''}</span>
          </div>
          <div class="loading">Loading…</div>
        </div>
      `;
    }

    const resolved = resolveCombines(combines, this._sources, this.date);
    const allMissing = resolved.length > 0 && resolved.every(r => r.state !== 'ok');

    return html`
      <div class="shell">
        <div class="header">
          ${m.emoji ? html`<span class="emoji">${m.emoji}</span>` : ''}
          <span class="title">${m.label || m.id || ''}</span>
          ${this.dateMode === 'future' ? html`<span class="badge future">🔮 Planned</span>` : ''}
          ${this.dateMode === 'past'   ? html`<span class="badge past">Past</span>` : ''}
        </div>
        <div class="body layout-${this._layout()}">
          ${combines.length === 0 ? html`
            <div class="empty">No sources configured.</div>
          ` : allMissing ? html`
            <div class="empty">No data for this date.</div>
          ` : resolved.map(r => this._renderRow(r))}
        </div>
      </div>
    `;
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
    .shell { display: block; }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--text-muted, var(--text-secondary));
    }
    .header .emoji { font-size: 14px; }
    .header .title { flex: 1; min-width: 0; }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      font-weight: 600;
      text-transform: none;
      letter-spacing: 0;
    }
    .badge.future {
      background: var(--accent-bg, rgba(255,170,0,0.15));
      color: var(--accent-amber, #ffaa00);
    }
    .badge.past {
      background: var(--bg-hover, rgba(255,255,255,0.05));
      color: var(--text-muted, var(--text-secondary));
    }

    .body { padding: 6px 16px 16px; }
    .body.layout-stack { display: flex; flex-direction: column; gap: 6px; }

    .row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .row-label {
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-value {
      color: var(--text-primary);
      font-weight: 600;
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      flex-shrink: 0;
    }
    .row-unit {
      font-size: 11px;
      font-weight: 400;
      color: var(--text-muted, var(--text-secondary));
    }
    .row-placeholder {
      font-size: 11px;
      font-style: italic;
      color: var(--text-muted, var(--text-secondary));
      flex-shrink: 0;
    }

    .row.role-primary .row-value { font-size: 28px; font-weight: 700; }
    .row.role-primary .row-label { font-size: 14px; color: var(--text-primary); }
    .row.role-secondary .row-value { font-size: 18px; }
    .row.role-annotation { opacity: 0.75; }
    .row.role-annotation .row-value { font-size: 13px; font-weight: 500; }

    .loading, .empty {
      padding: 10px 0;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      text-align: center;
    }
  `;
}

customElements.define('eh-combination-card', EhCombinationCard);
registerRenderer('combination-card', 'eh-combination-card');
