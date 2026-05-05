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
import { resolveCombines, canEditDonor } from '../lib/combines-resolver.esm.js';
import './eh-input-form.js';

export class EhCombinationCard extends LitElement {
  static properties = {
    card: { type: Object },
    date: { type: String },
    dateMode: { type: String },
    _sources: { state: true },   // { [sourceId]: { loaded, data, meta } }
    _loading: { state: true },
    _error: { state: true },
    _editingDonor: { state: true },   // sourceId currently being edited, or null
    _saving: { state: true },
    _saveError: { state: true },
  };

  constructor() {
    super();
    this.card = null;
    this.date = null;
    this.dateMode = 'today';
    this._sources = {};
    this._loading = true;
    this._error = null;
    this._editingDonor = null;
    this._saving = false;
    this._saveError = null;
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
    // app.js fires this with detail.cardId; the combo-card's own save
    // fires it with detail.id. Accept either so both paths work.
    const changedId = e?.detail?.cardId || e?.detail?.id;
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

  // --- Editable donor support ---

  _canEditDonor(sourceId) {
    const src = this._sources?.[sourceId];
    if (!src || !src.loaded) return false;
    return canEditDonor(src.meta, this.dateMode);
  }

  _openEdit(sourceId) {
    this._editingDonor = sourceId;
    this._saveError = null;
  }

  _closeEdit() {
    this._editingDonor = null;
    this._saveError = null;
  }

  // Compute the first-row index per donor in the resolved list. The
  // pencil attaches only to that row so multi-row donor groups (e.g.
  // Mood's mood + wakeUps + notes) show one affordance, not three.
  _firstRowIndexPerDonor(resolved) {
    const byDonor = {};
    resolved.forEach((r, i) => {
      if (r.sourceId && !(r.sourceId in byDonor)) byDonor[r.sourceId] = i;
    });
    return byDonor;
  }

  // Upsert behaviour mirrors eh-generic-card._onSubmit: by default
  // maxReadingsPerDay=1 means the new row replaces any existing row for
  // the same date; >1 appends and caps to the N most recent.
  async _onDonorSubmit(sourceId, e) {
    const payload = e.detail;
    const src = this._sources?.[sourceId];
    const donorMeta = src?.meta;
    if (!donorMeta) return;

    this._saving = true;
    this._saveError = null;
    try {
      const entry = { ...payload };
      if (!entry.date) entry.date = this.date;

      const existing = Array.isArray(src.data) ? src.data : [];
      const max = donorMeta.writeable?.maxReadingsPerDay ?? 1;
      const sameDay = existing.filter(d => d.date === entry.date);
      const others  = existing.filter(d => d.date !== entry.date);

      let updated;
      if (max === 1) {
        updated = [...others, entry];
      } else {
        const capped = [...sameDay, entry].slice(-max);
        updated = [...others, ...capped];
      }
      updated.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      const r = await fetch(`/api/manifests/${encodeURIComponent(sourceId)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: updated }),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch {}
        throw new Error(msg);
      }

      // Reflect locally + tell other listeners (atomic card renderer
      // instances, etc.) that this donor's data changed.
      this._sources = {
        ...this._sources,
        [sourceId]: { ...src, data: updated },
      };
      window.dispatchEvent(new CustomEvent('manifest-data-changed', {
        detail: { cardId: sourceId, id: sourceId },
      }));

      this._editingDonor = null;
    } catch (err) {
      this._saveError = err.message || 'save failed';
    } finally {
      this._saving = false;
    }
  }

  // --- Render helpers ---

  _renderRow(resolved, showPencil) {
    const label = resolved.label || resolved.sourceId;
    const roleClass = `role-${resolved.role || 'annotation'}`;

    if (resolved.state !== 'ok') {
      const hint = resolved.state === 'no-source' ? 'source not loaded'
                 : resolved.state === 'no-entry' ? 'no entry for this date'
                 : 'no value';
      return html`
        <div class="row ${roleClass} placeholder">
          <span class="row-label">${label}</span>
          <span class="row-trailing">
            <span class="row-placeholder">${hint}</span>
            ${showPencil ? this._renderPencil(resolved.sourceId, true) : ''}
          </span>
        </div>
      `;
    }

    return html`
      <div class="row ${roleClass}">
        <span class="row-label">${label}</span>
        <span class="row-trailing">
          <span class="row-value">
            ${resolved.displayValue}
            ${resolved.unit ? html`<span class="row-unit">${resolved.unit}</span>` : ''}
          </span>
          ${showPencil ? this._renderPencil(resolved.sourceId, false) : ''}
        </span>
      </div>
    `;
  }

  _renderPencil(sourceId, isAdd) {
    return html`
      <button
        class="edit-btn"
        @click=${() => this._openEdit(sourceId)}
        aria-label="${isAdd ? 'Add' : 'Edit'} entry"
        title="${isAdd ? 'Add' : 'Edit'} entry"
      >${isAdd ? '➕' : '✏️'}</button>
    `;
  }

  _renderEditForm(sourceId) {
    const src = this._sources?.[sourceId];
    if (!src?.meta?.writeable?.inputs) return '';
    const inputs = src.meta.writeable.inputs;
    // Prefill with the donor's current row for this date, if any.
    const rows = Array.isArray(src.data) ? src.data : [];
    const current = rows.find(r => r && r.date === this.date) || {};
    const donorLabel = src.meta.label || sourceId;
    const hasEntry = Object.keys(current).length > 0;
    return html`
      <div class="edit-form-wrap">
        <div class="edit-form-header">
          <span class="edit-form-title">${hasEntry ? 'Edit' : 'Add'} ${donorLabel}</span>
        </div>
        <eh-input-form
          .inputs=${inputs}
          .values=${current}
          .date=${this.date}
          submit-label=${hasEntry ? 'Update' : 'Add'}
          ?busy=${this._saving}
          @eh-submit=${(e) => this._onDonorSubmit(sourceId, e)}
          @eh-cancel=${() => this._closeEdit()}
        ></eh-input-form>
        ${this._saveError ? html`<div class="err">${this._saveError}</div>` : ''}
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
    const firstByDonor = this._firstRowIndexPerDonor(resolved);

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
          ` : resolved.map((r, i) => {
            const isFirstForDonor = firstByDonor[r.sourceId] === i;
            const showPencil = isFirstForDonor
                             && r.sourceId !== this._editingDonor
                             && this._canEditDonor(r.sourceId);
            return this._renderRow(r, showPencil);
          })}
          ${this._editingDonor ? this._renderEditForm(this._editingDonor) : ''}
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

    .row-trailing {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      flex-shrink: 0;
    }
    .edit-btn {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 2px 6px;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      color: var(--text-muted, var(--text-secondary));
      font-family: inherit;
      transition: border-color 0.12s, background 0.12s;
    }
    .edit-btn:hover {
      border-color: var(--border);
      background: var(--bg-hover, rgba(255,255,255,0.05));
    }
    .edit-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .edit-form-wrap {
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-input, transparent);
    }
    .edit-form-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .edit-form-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted, var(--text-secondary));
    }
    .err {
      margin-top: 6px;
      color: #ff4466;
      font-size: 12px;
    }

    @media (prefers-reduced-motion: reduce) {
      .edit-btn { transition: none; }
    }
  `;
}

customElements.define('eh-combination-card', EhCombinationCard);
registerRenderer('combination-card', 'eh-combination-card');
