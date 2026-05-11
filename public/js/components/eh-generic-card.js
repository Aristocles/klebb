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
//   meta.view.dateContext = "latest" | "viewedDate"   (default "viewedDate")
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
//                                          most recent prior entry
//   meta.writeable.fromWebapp             — enables the ✏️/➕ input button
//   meta.writeable.inputs                 — array of input specs for eh-input-form
//   meta.writeable.maxReadingsPerDay      — default 1 (upsert behaviour)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { renderTemplate, evaluateThresholds, computeTrend } from '../lib/display-template.esm.js';
import { registerRenderer } from '../renderer-registry.js';
import { EhBaseCard, invalidateManifestCache } from './eh-base-card.js';
import { errorFromResponse } from '../lib/save-error.js';
import './eh-input-form.js';

export class EhGenericCard extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _editing: { state: true },
    _saving: { state: true },
    _formError: { state: true },
  };

  constructor() {
    super();
    this._editing = false;
    this._saving = false;
    this._formError = null;
  }

  // Local aliases — don't shadow EhBaseCard's _meta getter
  _m() { return this.card?.meta || {}; }
  _vc() { return this.card?.viewConfig || {}; }
  _display() {
    const d = this._vc().display ?? this._m().view?.display;
    if (typeof d === 'string') return { template: d };
    return d || {};
  }
  _dateContext() { return this._vc().dateContext || this._m().view?.dateContext || 'viewedDate'; }

  _entries() {
    const d = this.data;
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.data)) return d.data; // defensive
    return [];
  }

  _currentEntry() {
    const entries = this._entries();
    if (entries.length === 0) return null;
    // dateContext:"latest" is a Today-mode fallback — on any past/future
    // date the card resolves by exact date match so navigation actually
    // means what it says. See issue #182.
    const isToday = this.dateMode === 'today' || !this.dateMode;
    if (isToday && this._dateContext() === 'latest') {
      return [...entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    }
    return entries.find(e => e.date === this.date) || null;
  }

  _openEdit() {
    this._editing = true;
    this._formError = null;
  }
  _closeEdit() {
    this._editing = false;
    this._formError = null;
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

      const sameDay = existing.filter(d => d.date === entry.date);
      const others = existing.filter(d => d.date !== entry.date);

      let updated;
      if (max === 1) {
        updated = [...others, entry];
      } else {
        const combined = [...sameDay, entry];
        const capped = combined.slice(-max);
        updated = [...others, ...capped];
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
      .gen-unit {
        font-size: 0.9rem;
        color: var(--text-secondary);
        font-weight: 500;
      }
      .gen-trend {
        font-size: 1.1rem;
        line-height: 1;
        font-weight: 600;
      }
      .gen-trend.up   { color: #ff7755; }
      .gen-trend.down { color: #55cc77; }
      .gen-trend.flat { color: var(--text-muted, var(--text-secondary)); }
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

      @media (prefers-reduced-motion: reduce) {
        .edit-btn { transition: none; }
      }
    `,
  ];

  renderCard() {
    const meta = this._m();
    const display = this._display();
    const entry = this._currentEntry();
    const hasEntry = entry !== null;

    const canWrite = this._canWrite
      && Array.isArray(meta?.writeable?.inputs)
      && meta.writeable.inputs.length > 0;
    const editIcon = hasEntry ? '✏️' : '➕';

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

    // Trend arrow: compare to previous entry on the same field
    let trend = null;
    if (hasEntry && display.trendArrow && display.trendArrow.field) {
      trend = computeTrend(entry, display.trendArrow.field, this._entries());
    }

    return html`
      <div class="card-inner">
        ${threshold && threshold.colour ? html`
          <span class="gen-sidebar" style="background: ${threshold.colour};"></span>` : ''}

        ${canWrite ? html`
          <button class="edit-btn"
            @click=${this._openEdit}
            aria-label="${hasEntry ? 'Edit' : 'Add'} entry"
            title="${hasEntry ? 'Edit' : 'Add'} entry">${editIcon}</button>
        ` : ''}

        ${this._editing ? html`
          <eh-input-form
            .inputs=${meta.writeable.inputs}
            .values=${entry || {}}
            .date=${this.date}
            submit-label=${hasEntry ? 'Update' : 'Add'}
            ?busy=${this._saving}
            @eh-submit=${this._onSubmit}
            @eh-cancel=${this._closeEdit}
          ></eh-input-form>
        ` : hasEntry ? html`
          <div class="gen-row">
            <span class="gen-headline">${headline}</span>
            ${display.unit ? html`<span class="gen-unit">${display.unit}</span>` : ''}
            ${trend ? html`
              <span class="gen-trend ${trend.dir}" title="vs ${trend.prev.date}">
                ${trend.dir === 'up' ? '↑' : trend.dir === 'down' ? '↓' : '→'}
              </span>` : ''}
            ${threshold && threshold.label ? html`
              <span class="gen-threshold-pill" style="background: ${threshold.colour || 'var(--accent)'};">
                ${threshold.label}
              </span>` : ''}
          </div>
          ${secondary ? html`<div class="gen-secondary">${secondary}</div>` : ''}
        ` : html`
          <div class="gen-empty">${headline}</div>
        `}

        ${this._formError ? html`<div class="err">${this._formError}</div>` : ''}
      </div>
    `;
  }
}
customElements.define('eh-generic-card', EhGenericCard);
registerRenderer('generic-card', 'eh-generic-card');
