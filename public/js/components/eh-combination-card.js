// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-combination-card.js
// Read-only composite renderer. Consumes meta.view.combines[] and
// surfaces one row per combined source for the viewed date.
//
// Opt a manifest into this renderer by setting:
//   meta.view.component = "combination-card"
//   meta.view.layout    = "stack" | "rings"   ("chart" reserved)
//   meta.view.combines  = [ { sourceId, role, label?, accessor?, unit?, emojiMap? } ]
//
// Ring-segment entries (role: "ring-segment") carry goalDaily + optional
// colour. See MANIFEST-SCHEMA.md "Combination cards" for the full contract.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { registerRenderer } from '../renderer-registry.js';
import { resolveCombines, canEditDonor } from '../lib/combines-resolver.esm.js';
import { loadECharts, chartTheme } from './eh-chart-base.js';
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
    if (this._chart) { try { this._chart.dispose(); } catch {} this._chart = null; }
    if (this._themeObserver) { this._themeObserver.disconnect(); this._themeObserver = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
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
    // Known layouts pass through; unknown fall back to stack.
    if (l === 'stack' || l === 'rings') return l;
    return 'stack';
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

  // `updated()` is defined further down in the rings lifecycle section
  // so it can also drive the ECharts refresh; it handles `card` change
  // identically to what used to live here.

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
    const donorDisplay = src.meta?.view?.display || null;
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
          .display=${donorDisplay}
          .requireAny=${src.meta?.writeable?.requireAny || null}
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
    const layout = this._layout();

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
    const firstByDonor = this._firstRowIndexPerDonor(resolved);

    return html`
      <div class="shell">
        <div class="header">
          ${m.emoji ? html`<span class="emoji">${m.emoji}</span>` : ''}
          <span class="title">${m.label || m.id || ''}</span>
          ${this.dateMode === 'future' ? html`<span class="badge future">🔮 Planned</span>` : ''}
          ${this.dateMode === 'past'   ? html`<span class="badge past">Past</span>` : ''}
        </div>
        <div class="body layout-${layout}">
          ${combines.length === 0 ? html`
            <div class="empty">No sources configured.</div>
          ` : layout === 'rings'
            ? this._renderRings(resolved, firstByDonor)
            : this._renderStack(resolved, firstByDonor)}
          ${this._editingDonor ? this._renderEditForm(this._editingDonor) : ''}
        </div>
      </div>
    `;
  }

  _renderStack(resolved, firstByDonor) {
    const allMissing = resolved.length > 0 && resolved.every(r => r.state !== 'ok');
    if (allMissing) return html`<div class="empty">No data for this date.</div>`;
    return resolved.map((r, i) => {
      const isFirstForDonor = firstByDonor[r.sourceId] === i;
      const showPencil = isFirstForDonor
                       && r.sourceId !== this._editingDonor
                       && this._canEditDonor(r.sourceId);
      return this._renderRow(r, showPencil);
    });
  }

  _renderRings(resolved, firstByDonor) {
    // Partition: ring-segment entries drive the gauge, everything else
    // renders below as normal stack rows. Non-ring-segment roles behave
    // exactly as in `stack` layout.
    const ringEntries = resolved.filter(r => r.role === 'ring-segment');
    const otherEntries = resolved.filter(r => r.role !== 'ring-segment');

    if (ringEntries.length === 0) {
      return html`<div class="empty">No ring segments configured. Add role: "ring-segment" entries with goalDaily or goalWeekly.</div>`;
    }

    return html`
      <div class="rings-figure">
        <div class="rings-chart"></div>
      </div>
      <div class="rings-legend">
        ${ringEntries.map((r, i) => this._renderRingLegend(r, i))}
      </div>
      ${otherEntries.length > 0 ? html`
        <div class="rings-extras">
          ${otherEntries.map((r) => {
            // Still honour per-donor pencil rules for non-ring rows.
            const donorIdx = resolved.indexOf(r);
            const isFirstForDonor = firstByDonor[r.sourceId] === donorIdx;
            const showPencil = isFirstForDonor
                             && r.sourceId !== this._editingDonor
                             && this._canEditDonor(r.sourceId);
            return this._renderRow(r, showPencil);
          })}
        </div>
      ` : ''}
    `;
  }

  _renderRingLegend(resolved, index) {
    const label = resolved.label || resolved.sourceId;
    const theme = this._cachedTheme || chartTheme();
    const colour = resolved.colour || theme.color[index % theme.color.length];

    if (resolved.state !== 'ok') {
      const hint = resolved.state === 'no-goal' ? 'needs goalDaily'
                 : resolved.state === 'no-source' ? 'source not loaded'
                 : resolved.state === 'no-entry' ? 'no entry for this date'
                 : 'no value';
      return html`
        <div class="ring-legend-row placeholder">
          <span class="ring-swatch" style="background:${colour};opacity:.3;"></span>
          <span class="ring-label">${label}</span>
          <span class="ring-placeholder">${hint}</span>
        </div>
      `;
    }

    const pct = Math.round(resolved.ratio * 100);
    const valueStr = resolved.displayValue;
    const isWeekly = resolved.period === 'week';
    const goalStr = String(isWeekly ? resolved.goalWeekly : resolved.goalDaily);
    const periodSuffix = isWeekly ? ' /wk' : '';
    return html`
      <div class="ring-legend-row ${resolved.complete ? 'complete' : ''}">
        <span class="ring-swatch" style="background:${colour};"></span>
        <span class="ring-label">${label}</span>
        <span class="ring-values">
          <span class="ring-value">${valueStr}</span>
          <span class="ring-sep">/</span>
          <span class="ring-goal">${goalStr}${resolved.unit ? ` ${resolved.unit}` : ''}${periodSuffix}</span>
          <span class="ring-pct">${pct}%${resolved.complete ? ' ✨' : ''}</span>
        </span>
      </div>
    `;
  }

  // --- ECharts lifecycle for rings layout ---

  firstUpdated() { this._maybeUpdateChart(); }

  async _maybeUpdateChart() {
    if (this._layout() !== 'rings') {
      // If we swapped away from rings, tear down the chart.
      if (this._chart) { try { this._chart.dispose(); } catch {} this._chart = null; }
      return;
    }
    const el = this.renderRoot.querySelector('.rings-chart');
    if (!el) return;
    const echarts = await loadECharts();
    if (!this._chart) {
      this._chart = echarts.init(el);
      this._themeObserver = new MutationObserver(() => {
        this._cachedTheme = null;
        this._applyChart();
        this.requestUpdate();  // re-render legend so swatches match new theme
      });
      this._themeObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-theme'],
      });
      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(() => {
          try { this._chart.resize(); } catch {}
        });
        this._resizeObserver.observe(el);
      }
    }
    this._applyChart();
  }

  _applyChart() {
    if (!this._chart) return;
    const theme = chartTheme();
    this._cachedTheme = theme;
    const resolved = resolveCombines(this._combines(), this._sources, this.date);
    const ringEntries = resolved.filter(r => r.role === 'ring-segment');

    // Concentric gauges. ECharts gauge supports radius as a percentage of
    // the container; we space rings by 18% radius per layer.
    const BASE_RADIUS = 88;
    const GAP = 18;
    const series = ringEntries.map((r, i) => {
      const colour = r.colour || theme.color[i % theme.color.length];
      const radius = Math.max(BASE_RADIUS - i * GAP, 30);
      const value = r.state === 'ok' ? Math.min(r.ratio, 1) : 0;
      return {
        type: 'gauge',
        radius: `${radius}%`,
        startAngle: 90,
        endAngle: -270,
        min: 0,
        max: 1,
        progress: {
          show: true,
          width: 12,
          roundCap: true,
          itemStyle: { color: colour },
        },
        axisLine: {
          lineStyle: {
            width: 12,
            color: [[1, theme.yAxis?.splitLine?.lineStyle?.color || 'rgba(128,128,128,0.15)']],
          },
        },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        title: { show: false },
        detail: { show: false },
        data: [{ value }],
        animation: true,
        animationDuration: 600,
      };
    });

    this._chart.setOption({
      ...theme,
      backgroundColor: 'transparent',
      series,
    }, true);
  }

  updated(changed) {
    // Trigger _fetchAll when `card` changes (existing behaviour) AND refresh
    // the chart when inputs that affect it change.
    if (changed.has('card')) {
      this._fetchAll();
    }
    if (!this._loading) {
      this._maybeUpdateChart();
    }
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

    /* --- Rings layout --- */
    .body.layout-rings { display: flex; flex-direction: column; gap: 10px; }

    .rings-figure {
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .rings-chart {
      width: 100%;
      max-width: 260px;
      height: 180px;
    }

    .rings-legend {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ring-legend-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-size: 13px;
      min-width: 0;
    }
    .ring-legend-row.placeholder { opacity: 0.7; }
    .ring-legend-row.complete .ring-pct {
      color: var(--accent-green, #44ff88);
      font-weight: 700;
    }
    .ring-swatch {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .ring-label {
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      flex-shrink: 0;
    }
    .ring-values {
      margin-left: auto;
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      color: var(--text-primary);
    }
    .ring-value { font-weight: 600; }
    .ring-sep { opacity: 0.4; }
    .ring-goal {
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
    }
    .ring-pct {
      margin-left: 6px;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
    }
    .ring-placeholder {
      margin-left: auto;
      font-size: 11px;
      font-style: italic;
      color: var(--text-muted, var(--text-secondary));
    }

    .rings-extras {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }
  `;
}

customElements.define('eh-combination-card', EhCombinationCard);
registerRenderer('combination-card', 'eh-combination-card');
