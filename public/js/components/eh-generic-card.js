// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-generic-card.js
// Zero-code card renderer driven entirely by meta.view.display + meta.writeable.
//
// Opt a manifest into this renderer by setting:
//   meta.view.component = "generic-card"
//
// Meta fields consumed:
//   meta.label                            — card title
//   meta.emoji                            — optional title emoji
//   meta.view.fallbackToLatest = boolean  — when true, on Today with no
//                                          row for today, display falls
//                                          back to the most recent prior
//                                          row. Default false. See #228.
//   meta.view.dateContext (DEPRECATED)    — legacy string-enum field;
//                                          dateContext:"latest" is read
//                                          as fallbackToLatest:true for
//                                          one release cycle. Run
//                                          scripts/migrate-dateContext-
//                                          to-fallbackToLatest.js to
//                                          migrate live manifests.
//   meta.view.display.template            — template string for the headline
//   meta.view.display.secondary           — optional template for the sub-line
//   meta.view.display.unit                — small unit suffix after the headline
//   meta.view.display.emojiMap            — { key: { value: emoji } } for {key:emoji}
//   meta.view.display.emptyHeadline       — shown when no entry for the day
//   meta.view.display.thresholds          — array of { ifField, min?, max?, eq?,
//                                                      colour?, label? } rules;
//                                          first match wins, paints a side-bar
//                                          + shows the label pill
//   meta.view.display.trendArrow          — { field: "kg" } enables ↑/↓/→ arrow
//                                          next to the value, compared to the
//                                          most recent prior entry, with the
//                                          signed delta printed alongside.
//                                          Optional goodDirection: 'up'|'down'
//                                          |'neutral' decides arrow colour
//                                          (default down=good, the weight
//                                          convention). See #423.
//   meta.writeable.fromWebapp             — enables the ✏️/➕ input button
//   meta.writeable.inputs                 — array of input specs for eh-input-form
//   meta.writeable.maxReadingsPerDay      — default 1 (upsert behaviour)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { renderTemplate, evaluateThresholds, computeTrend, trendColour, resolveGoodDirection, formatTrendDelta, numericSeries } from '../lib/display-template.esm.js';
import { registerRenderer } from '../renderer-registry.js';
import { EhBaseCard, invalidateManifestCache } from './eh-base-card.js';
import { errorFromResponse } from '../lib/save-error.js';
import { daysBetweenISO } from '../lib/date-util.js';
import './eh-input-form.js';
import './eh-sparkline.js';
import './eh-line-chart.js';

export class EhGenericCard extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _editing: { state: true },
    _editingIndex: { state: true },
    _saving: { state: true },
    _formError: { state: true },
  };

  constructor() {
    super();
    this._editing = false;
    // Absolute index in the data array of the row being edited, or null
    // when the form is in "add new" mode. Only meaningful when
    // maxReadingsPerDay > 1; ignored in the single-entry path.
    this._editingIndex = null;
    this._saving = false;
    this._formError = null;
  }

  _maxReadingsPerDay() {
    return this._m()?.writeable?.maxReadingsPerDay ?? 1;
  }

  // For multi-entry mode: every row whose date === this.date, paired
  // with its absolute index in the underlying data array (so edit + delete
  // mutate the right row even after time-sorting for display).
  _rowsForExactDate() {
    const rows = this._entries();
    const sameDay = [];
    rows.forEach((row, idx) => {
      if (row && row.date === this.date) sameDay.push({ row, idx });
    });
    sameDay.sort((a, b) => {
      const at = a.row.time || '';
      const bt = b.row.time || '';
      return String(at).localeCompare(String(bt));
    });
    return sameDay;
  }

  // Local aliases — don't shadow EhBaseCard's _meta getter
  _m() { return this.card?.meta || {}; }
  _vc() { return this.card?.viewConfig || {}; }
  _display() {
    const d = this._vc().display ?? this._m().view?.display;
    if (typeof d === 'string') return { template: d };
    return d || {};
  }
  // Returns true when the card should fall back to the latest row on
  // Today if there is no row for today. Reads the canonical
  // meta.view.fallbackToLatest (boolean) first, then the legacy
  // dateContext:"latest" string for backwards-compat during the
  // deprecation window.  See #228.
  _fallbackToLatest() {
    const vc = this._vc();
    const view = this._m().view;
    if (typeof vc.fallbackToLatest === 'boolean') return vc.fallbackToLatest;
    if (typeof view?.fallbackToLatest === 'boolean') return view.fallbackToLatest;
    return vc.dateContext === 'latest' || view?.dateContext === 'latest';
  }

  _entries() {
    const d = this.data;
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.data)) return d.data; // defensive
    return [];
  }

  // Resolve which numeric field the sparkline plots. Order: the field the
  // author already nominated for the trend arrow; else the first {token} in
  // the display template (stripped at the first of : | ?); else a numeric-key
  // heuristic over the newest row. Returns null when nothing numeric fits.
  _sparklineField(display) {
    if (display && display.trendArrow && display.trendArrow.field) return display.trendArrow.field;
    const tpl = display && typeof display.template === 'string' ? display.template : '';
    const m = tpl.match(/\{([^}]+)\}/);
    if (m) return m[1].split(/[:|?]/)[0].trim();
    const rows = this._entries();
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row) {
      for (const c of ['value', 'kg', 'ml', 'count', 'minutes', 'systolic']) {
        if (c in row) return c;
      }
      for (const k of Object.keys(row)) {
        if (k === 'date' || k === 'time' || k === 'notes') continue;
        if (typeof row[k] === 'number') return k;
      }
    }
    return null;
  }

  // A card is expandable when it shows a sparkline (tap the header to open the
  // full trend), OR when it opts into expand the generic way (viewConfig.expanded).
  get _canExpand() {
    if (super._canExpand) return true;
    const isToday = this.dateMode === 'today' || !this.dateMode;
    if (!this._config.showSparkline || !isToday) return false;
    const field = this._sparklineField(this._meta.view?.display || {});
    if (!field) return false;
    return numericSeries(this._entries(), field, { endDate: this.date, limit: 30 }).length >= 2;
  }

  // Expanded region: the full ECharts line trend, loaded lazily (the heavy
  // chart payload only loads on first expand). Renders eh-line-chart headerless
  // with a synthesised trends config pointing at the resolved sparkline field;
  // the chart reuses this card's already-fetched data (same id -> cache hit).
  renderExpanded() {
    const display = this._meta.view?.display || {};
    const field = this._sparklineField(display);
    if (!field) return html`<div class="card-expanded">No trend available.</div>`;
    const chartCard = {
      id: this.card.id,
      meta: this._meta,
      viewConfig: {
        component: 'line-chart',
        series: [{ field, label: this._meta.label || field }],
        yAxisLabel: display.unit || '',
      },
    };
    return html`<eh-line-chart headerless .card=${chartCard} .date=${this.date} .dateMode=${this.dateMode}></eh-line-chart>`;
  }

  _currentEntry() {
    const entries = this._entries();
    if (entries.length === 0) return null;
    // fallbackToLatest is a Today-mode display fallback — on any
    // past/future date the card resolves by exact date match so
    // navigation actually means what it says. See #182.
    const isToday = this.dateMode === 'today' || !this.dateMode;
    if (isToday && this._fallbackToLatest()) {
      return [...entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    }
    return entries.find(e => e.date === this.date) || null;
  }

  _openEdit(index = null) {
    this._editing = true;
    this._editingIndex = (typeof index === 'number') ? index : null;
    this._formError = null;
  }
  _closeEdit() {
    this._editing = false;
    this._editingIndex = null;
    this._formError = null;
  }

  async _onDeleteRow(index) {
    const existing = this._entries();
    if (index < 0 || index >= existing.length) return;
    this._saving = true;
    this._formError = null;
    try {
      const updated = existing.filter((_, i) => i !== index);
      const r = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: updated }),
      });
      if (!r.ok) throw await errorFromResponse(r);
      invalidateManifestCache(this.card.id);
      this.data = updated;
    } catch (err) {
      this._formError = err.message;
    } finally {
      this._saving = false;
    }
  }

  async _onSubmit(e) {
    const payload = e.detail;
    const meta = this._m();
    this._saving = true;
    this._formError = null;
    try {
      const entry = { ...payload };
      if (!entry.date) entry.date = this.date;
      const existing = this._entries();
      const max = meta?.writeable?.maxReadingsPerDay ?? 1;
      const editIdx = this._editingIndex;

      let updated;
      if (max > 1 && typeof editIdx === 'number'
          && editIdx >= 0 && editIdx < existing.length) {
        // Replace the targeted row in place (multi-entry edit).
        updated = existing.map((row, i) => (i === editIdx ? entry : row));
      } else {
        const sameDay = existing.filter(d => d.date === entry.date);
        const others = existing.filter(d => d.date !== entry.date);
        if (max === 1) {
          updated = [...others, entry];
        } else {
          const combined = [...sameDay, entry];
          const capped = combined.slice(-max);
          updated = [...others, ...capped];
        }
      }
      updated.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      const r = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: updated }),
      });
      if (!r.ok) throw await errorFromResponse(r);

      invalidateManifestCache(this.card.id);
      this.data = updated;
      this._editing = false;
      this._editingIndex = null;
    } catch (err) {
      this._formError = err.message;
    } finally {
      this._saving = false;
    }
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .gen-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .gen-headline {
        font-size: 1.8rem;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.2;
      }
      /* Carry-over: today has no row but the card opted into
         fallbackToLatest, so the headline is yesterday's value (or
         older). Dim the value + dotted-underline it so the user knows
         the number isn't fresh. Paired with the .gen-carry-chip below.
         See #231. */
      .gen-headline.carry-over {
        opacity: 0.7;
        text-decoration: underline dotted;
        text-underline-offset: 4px;
        text-decoration-color: var(--text-muted, var(--text-secondary));
      }
      .gen-carry-chip {
        display: inline-block;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        background: var(--bg-hover, rgba(255, 255, 255, 0.06));
        color: var(--text-muted, var(--text-secondary));
        white-space: nowrap;
      }
      .gen-carry-line {
        margin-top: 6px;
      }
      .gen-unit {
        font-size: 0.9rem;
        color: var(--text-secondary);
        font-weight: 500;
      }
      /* Colour is set inline per-card because the "good" direction is
         manifest-driven (trendArrow.goodDirection); see #423. The glyph
         and the signed delta carry the meaning so colour is reinforcement,
         not the sole signal. */
      .gen-trend {
        display: inline-flex;
        align-items: baseline;
        gap: 3px;
        font-size: 1.1rem;
        line-height: 1;
        font-weight: 600;
      }
      .gen-trend-delta {
        font-size: 0.85rem;
        font-weight: 600;
      }
      .gen-threshold-pill {
        display: inline-block;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        margin-left: 4px;
        vertical-align: middle;
        color: var(--text-inverse, #fff);
      }
      .gen-spark {
        margin-top: 8px;
        line-height: 0;
      }
      .gen-secondary {
        margin-top: 6px;
        font-size: 0.95rem;
        color: var(--text-secondary);
      }
      .gen-empty {
        color: var(--text-muted, var(--text-secondary));
        font-style: italic;
        font-size: 1rem;
      }
      .gen-sidebar {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        width: 4px;
        border-radius: 2px 0 0 2px;
      }
      .edit-btn {
        position: absolute;
        /* Sit in the card-header row, right-aligned. -32px lifts the
           button above the card-inner container into the header space. */
        top: -32px;
        right: 4px;
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        z-index: 3;
      }
      .edit-btn:hover {
        border-color: var(--accent);
        color: var(--accent);
      }
      .edit-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .card-inner { position: relative; padding-right: 4px; padding-left: 10px; }
      .err { color: #ff4466; font-size: 12px; margin-top: 6px; }

      .gen-rows {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .gen-list-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 0;
        border-top: 1px solid var(--border);
        min-height: 36px;
      }
      .gen-list-row:first-child { border-top: none; }
      .gen-list-text {
        flex: 1;
        min-width: 0;
        font-size: 14px;
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .gen-list-secondary {
        margin-top: 2px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .gen-list-actions {
        display: inline-flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .gen-row-btn {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        font-size: 13px;
        cursor: pointer;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        padding: 0;
      }
      .gen-row-btn:hover, .gen-row-btn:focus-visible {
        border-color: var(--accent);
        color: var(--accent);
        outline: none;
      }
      .gen-row-btn.danger:hover, .gen-row-btn.danger:focus-visible {
        border-color: #d0323e;
        color: #d0323e;
      }
      .gen-add-row {
        padding: 10px 0 0 0;
        border-top: 1px dashed var(--border);
        margin-top: 4px;
      }
      .gen-add-btn {
        background: transparent;
        border: 1px dashed var(--border);
        color: var(--accent);
        padding: 8px 14px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        font-family: inherit;
        font-weight: 600;
        width: 100%;
      }
      .gen-add-btn:hover {
        border-color: var(--accent);
        background: var(--accent-bg, rgba(0,212,170,0.05));
      }
      .gen-add-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      @media (prefers-reduced-motion: reduce) {
        .edit-btn { transition: none; }
      }
    `,
  ];

  // Resolve the most recent prior entry — the last row dated strictly
  // before `this.date`. Returns null if none exists. Used by the
  // prefillFromLatest feature (#217).
  _latestPriorEntry() {
    const rows = this._entries();
    if (rows.length === 0) return null;
    const target = this.date;
    const candidates = rows.filter(r => r && r.date && (!target || r.date < target));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return candidates[0];
  }

  // Exact-date entry lookup regardless of fallbackToLatest. Used by
  // the edit flow: a card on Today with fallbackToLatest:true can
  // show yesterday's row as a display fallback, but the EDIT button
  // must always target today, not the fallback day. Otherwise saving
  // rewrites the wrong row. See the 2026-05-14 klebbtest report.
  _entryForExactDate() {
    const rows = this._entries();
    if (rows.length === 0) return null;
    return rows.find(e => e && e.date === this.date) || null;
  }

  renderCard() {
    const meta = this._m();
    const display = this._display();
    // When the manifest opts into multiple readings per day, render a
    // per-day list with per-row edit/delete + an Add action. The single-
    // entry path below is left untouched. fallbackToLatest is suppressed
    // here: showing yesterday's *list* on Today is more confusing than
    // helpful.
    if (this._maxReadingsPerDay() > 1) {
      return this._renderMultiEntry();
    }
    // Two different resolutions:
    //   - displayEntry:  what the card headline shows. Honours
    //     fallbackToLatest on Today, so a card with no row today
    //     can still show yesterday's value.
    //   - editEntry:     what the edit form targets. ALWAYS exact-
    //     date, so saving writes to the viewed date. When there's
    //     no exact-date row, we fall through to the add-form path
    //     (optionally seeded by prefillFromLatest, #217).
    const displayEntry = this._currentEntry();
    const editEntry = this._entryForExactDate();
    const hasEntry = displayEntry !== null;
    const hasEditEntry = editEntry !== null;
    // prefillFromLatest: when opening the add form on a date with no
    // existing row, seed the inputs from the most recent prior row so
    // slowly-changing measurements (weight, BP) land close to the
    // previous value. Date field is dropped so the form still stamps
    // the current viewed date. See #217.
    let prefillValues = null;
    if (!hasEditEntry && meta?.writeable?.prefillFromLatest === true) {
      const prior = this._latestPriorEntry();
      if (prior) {
        const { date: _dateIgnored, ...rest } = prior;
        prefillValues = rest;
      }
    }
    // Back-compat for the variables used further down the render —
    // `entry` remains the display fallback (drives the headline,
    // thresholds, trend arrow); the form consumes editEntry.
    const entry = displayEntry;

    // Carry-over: on Today with no exact-date row, but the
    // fallbackToLatest path resolved a prior row. Surface this so the
    // user can tell stale-from-prior-day apart from fresh-today. See
    // #231. The display fallback only triggers on Today, so this
    // condition is a sufficient detector — past-date navigation never
    // hits the fallback path in _currentEntry().
    const isToday = this.dateMode === 'today' || !this.dateMode;
    const isCarryOver = isToday
      && hasEntry
      && !hasEditEntry
      && entry?.date
      && entry.date !== this.date;
    const carryOverDays = isCarryOver
      ? daysBetweenISO(entry.date, this.date)
      : null;
    const carryOverLabel = (carryOverDays != null && carryOverDays > 0)
      ? `${carryOverDays}d ago`
      : null;

    const canWrite = this._canWrite
      && Array.isArray(meta?.writeable?.inputs)
      && meta.writeable.inputs.length > 0;
    // Icon + label reflect whether the VIEWED date has an entry,
    // not the display fallback. Clicking should be "add" on a day
    // with no row, even when the headline happens to show a
    // fallback value from a different day.
    const editIcon = hasEditEntry ? '✏️' : '➕';

    const headline = hasEntry
      ? renderTemplate(display.template || '', entry, display)
      : (display.emptyHeadline || 'No entry yet');

    const secondary = hasEntry && display.secondary
      ? renderTemplate(display.secondary, entry, display)
      : '';

    // Threshold: evaluate against current entry (if any)
    const threshold = hasEntry && Array.isArray(display.thresholds)
      ? evaluateThresholds(entry, display.thresholds)
      : null;

    // Trend arrow: compare to previous entry on the same field. Colour
    // is metric-aware via trendArrow.goodDirection (default down=good);
    // the signed delta is printed so meaning survives without colour. #423.
    let trend = null;
    let trendColourValue = null;
    let trendDelta = '';
    if (hasEntry && display.trendArrow && display.trendArrow.field) {
      trend = computeTrend(entry, display.trendArrow.field, this._entries());
      if (trend) {
        trendColourValue = trendColour(trend.dir, resolveGoodDirection(display.trendArrow));
        trendDelta = formatTrendDelta(trend.delta);
      }
    }

    // Opt-in inline sparkline (meta.view.showSparkline). Today-only; needs a
    // resolvable numeric field and >= 2 dated points, else renders nothing.
    // When shown, it replaces the trend arrow so direction reads once (the
    // sparkline + its own latest value), not as two redundant glyphs.
    let sparkValues = null;
    if (this._config.showSparkline && isToday) {
      const field = this._sparklineField(display);
      if (field) {
        const s = numericSeries(this._entries(), field, { endDate: this.date, limit: 30 });
        if (s.length >= 2) sparkValues = s;
      }
    }
    const showTrendArrow = trend && !sparkValues;

    return html`
      <div class="card-inner">
        ${threshold && threshold.colour ? html`
          <span class="gen-sidebar" style="background: ${threshold.colour};"></span>` : ''}

        ${canWrite ? html`
          <button class="edit-btn"
            @click=${this._openEdit}
            aria-label="${hasEditEntry ? 'Edit' : 'Add'} entry"
            title="${hasEditEntry ? 'Edit' : 'Add'} entry">${editIcon}</button>
        ` : ''}

        ${this._editing ? html`
          <eh-input-form
            .inputs=${meta.writeable.inputs}
            .values=${editEntry || prefillValues || {}}
            .date=${this.date}
            .display=${display}
            .requireAny=${meta.writeable.requireAny || null}
            submit-label=${hasEditEntry ? 'Update' : 'Add'}
            ?busy=${this._saving}
            @eh-submit=${this._onSubmit}
            @eh-cancel=${this._closeEdit}
          ></eh-input-form>
        ` : hasEntry ? html`
          <div class="gen-row">
            <span class="gen-headline ${isCarryOver ? 'carry-over' : ''}">${headline}</span>
            ${display.unit ? html`<span class="gen-unit">${display.unit}</span>` : ''}
            ${showTrendArrow ? html`
              <span class="gen-trend" style="color: ${trendColourValue};" title="vs ${trend.prev.date}">
                <span class="gen-trend-arrow">${trend.dir === 'up' ? '↑' : trend.dir === 'down' ? '↓' : '→'}</span>
                ${trendDelta ? html`<span class="gen-trend-delta">${trendDelta}</span>` : ''}
              </span>` : ''}
            ${threshold && threshold.label ? html`
              <span class="gen-threshold-pill" style="background: ${threshold.colour || 'var(--accent)'};">
                ${threshold.label}
              </span>` : ''}
          </div>
          ${sparkValues ? html`<div class="gen-spark"><eh-sparkline .values=${sparkValues}></eh-sparkline></div>` : ''}
          ${secondary ? html`<div class="gen-secondary">${secondary}</div>` : ''}
          ${carryOverLabel ? html`
            <div class="gen-carry-line">
              <span class="gen-carry-chip" title="Last logged ${entry.date}">${carryOverLabel}</span>
            </div>` : ''}
        ` : html`
          <div class="gen-empty">${headline}</div>
        `}

        ${this._formError ? html`<div class="err">${this._formError}</div>` : ''}
      </div>
    `;
  }

  // Multi-entry path: render every row dated this.date as its own line,
  // with per-row edit + delete and a separate ➕ Add control. Triggered
  // by meta.writeable.maxReadingsPerDay > 1.
  _renderMultiEntry() {
    const meta = this._m();
    const display = this._display();
    const entries = this._entries();
    const sameDay = this._rowsForExactDate();
    const canWrite = this._canWrite
      && Array.isArray(meta?.writeable?.inputs)
      && meta.writeable.inputs.length > 0;

    // When the form is open, resolve the row being edited (if any) by
    // its absolute index in the data array. _editingIndex === null means
    // the form is in "add new" mode.
    const editIdx = this._editingIndex;
    const editEntry = (typeof editIdx === 'number' && editIdx >= 0 && editIdx < entries.length)
      ? entries[editIdx]
      : null;

    return html`
      <div class="card-inner">
        ${this._editing ? html`
          <eh-input-form
            .inputs=${meta.writeable.inputs}
            .values=${editEntry || {}}
            .date=${this.date}
            .display=${display}
            .requireAny=${meta.writeable.requireAny || null}
            submit-label=${editEntry ? 'Update' : 'Add'}
            ?busy=${this._saving}
            @eh-submit=${this._onSubmit}
            @eh-cancel=${this._closeEdit}
          ></eh-input-form>
        ` : html`
          ${sameDay.length === 0 ? html`
            <div class="gen-empty">${display.emptyHeadline || 'No entries yet'}</div>
          ` : html`
            <ul class="gen-rows">
              ${sameDay.map(({ row, idx }) => {
                const text = display.template
                  ? renderTemplate(display.template, row, display)
                  : (row[Object.keys(row).find(k => k !== 'date' && k !== 'added')] ?? '');
                const sub = display.secondary
                  ? renderTemplate(display.secondary, row, display)
                  : '';
                return html`
                  <li class="gen-list-row">
                    <div class="gen-list-text">
                      ${text}
                      ${sub ? html`<div class="gen-list-secondary">${sub}</div>` : ''}
                    </div>
                    ${canWrite ? html`
                      <span class="gen-list-actions">
                        <button class="gen-row-btn"
                          @click=${() => this._openEdit(idx)}
                          aria-label="Edit entry"
                          title="Edit">✏️</button>
                        <button class="gen-row-btn danger"
                          @click=${() => this._onDeleteRow(idx)}
                          ?disabled=${this._saving}
                          aria-label="Delete entry"
                          title="Delete">➖</button>
                      </span>
                    ` : ''}
                  </li>
                `;
              })}
            </ul>
          `}
          ${canWrite ? html`
            <div class="gen-add-row">
              <button class="gen-add-btn"
                @click=${() => this._openEdit(null)}
                aria-label="Add entry">➕ Add</button>
            </div>
          ` : ''}
        `}

        ${this._formError ? html`<div class="err">${this._formError}</div>` : ''}
      </div>
    `;
  }
}
customElements.define('eh-generic-card', EhGenericCard);
registerRenderer('generic-card', 'eh-generic-card');
