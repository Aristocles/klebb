// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-checklist-card.js — items with check-off state per date.
// Generic over schedule + doses. Data shape:
//   { items: [{ name, schedule, cycles, doses: [{scheduledDate, takenAt}] }, ...] }
// or simpler: { items: [{ name, taken: boolean }] } for ad-hoc lists.
//
// Uses the schedule rules module (shared with schedule-timeline) to decide
// which items are due on this.date.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';
import { isScheduledOnDate } from '../../../lib/schedule.mjs';
import { chipsFor as todChipsFor } from '../lib/time-of-day.esm.js';
import { adherenceSeries, hasAdherenceSignal, adherenceItems } from '../lib/adherence-series.esm.js';
import { adherenceSparklineDescriptor } from '../lib/card-settings.js';
import './eh-sparkline.js';

// A stacked entry's display time (#705). When the log instant's local
// calendar date differs from the entry's scheduledDate (backfill: logged
// today against a past day), a bare time would read as that past day's
// time, so the label carries the log date too.
function _entryTimeLabel(e) {
  if (!e.takenAt) return '';
  const dt = new Date(e.takenAt);
  const t = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const localDate = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  if (e.scheduledDate && localDate !== e.scheduledDate) {
    return `logged ${dt.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
  }
  return t;
}

export class EhChecklistCard extends EhBaseCard {
  static supportsSettingsGear = true;
  static displayName = 'Checklist';

  static properties = {
    ...EhBaseCard.properties,
    _entriesExpandedKey: { state: true },
  };

  constructor() {
    super();
    this._entriesExpandedKey = null;
  }

  static get settingsSchema() {
    return [adherenceSparklineDescriptor(hasAdherenceSignal, adherenceItems)];
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .list { list-style: none; padding: 0; margin: 0; }
      .cl-spark { margin: 0 0 10px; line-height: 0; }
      .multi-count {
        border: 1px solid var(--border, #333);
        background: none;
        color: var(--text-secondary);
        border-radius: 10px;
        font-size: 11px;
        line-height: 1.4;
        padding: 1px 7px;
        cursor: pointer;
        margin-right: 8px;
      }
      .multi-count.open {
        color: var(--accent, #00d4aa);
        border-color: var(--accent, #00d4aa);
      }
      .day-entries {
        padding: 0 0 8px 4px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .day-entry {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .entry-time { font-variant-numeric: tabular-nums; }
      .entry-remove {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 4px;
      }
      .entry-remove:hover { color: var(--danger, #e05661); }

      .item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 0;
        border-top: 1px solid var(--border);
      }
      .item:first-child { border-top: none; }

      .item-body {
        flex: 1;
        min-width: 0;
      }
      .item-right {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }
      .item-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tod-chip {
        display: inline-block;
        margin-left: 6px;
        font-size: 14px;
        line-height: 1;
        vertical-align: middle;
        user-select: none;
      }
      .tod-chip + .tod-chip { margin-left: 2px; }
      .item.done .item-name {
        color: var(--text-muted, var(--text-secondary));
        text-decoration: line-through;
      }
      .item-sub {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 2px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Round check button — matches schedule-card for consistency */
      .checkbox {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: 2px solid var(--border);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        flex-shrink: 0;
      }
      .checkbox:hover { border-color: var(--accent); }
      .checkbox.checked {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .checkbox::before {
        content: '';
        font-size: 14px;
        font-weight: 700;
        line-height: 1;
      }
      .checkbox.checked::before { content: '✓'; }
      .checkbox.disabled { opacity: 0.4; cursor: not-allowed; }
      .checkbox:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .empty {
        font-size: 12px;
        color: var(--text-muted, var(--text-secondary));
        padding: 8px 2px;
      }

      @media (prefers-reduced-motion: reduce) {
        .checkbox { transition: none; }
      }
    `,
  ];

  get _items() {
    const d = this.data;
    if (!d) return [];
    if (Array.isArray(d)) return d; // simple list
    if (Array.isArray(d.items)) return d.items;
    // Supplements-style shape: { current: [...], past: [...] }.
    // Treat 'current' as the active list.
    if (Array.isArray(d.current)) return d.current;
    return [];
  }

  _isDue(item, date = this.date) {
    // If item explicitly has a schedule or cycle envelope, use schedule rules.
    if (item.schedule || item.cycles) return !!isScheduledOnDate(item, date);
    // Legacy / supplement-style: 'frequency' string as a coarse hint.
    const freq = (item.frequency || '').toLowerCase();
    if (!freq) return true;             // no schedule info → always show
    if (freq === 'daily') return true;
    if (freq === 'as needed') return false;
    if (freq === 'weekly') {
      // Weekly on a specific day if declared; else Monday default
      const cfgDay = (item.day || 'Mon').toString().slice(0, 3).toLowerCase();
      const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
      const todayName = dayNames[new Date(date + 'T00:00:00').getDay()];
      return todayName === cfgDay;
    }
    if (/^every\s+(\d+)/.test(freq)) {
      const n = parseInt(freq.match(/^every\s+(\d+)/)[1], 10);
      if (item.startDate) {
        const start = new Date(item.startDate + 'T00:00:00');
        const d = new Date(date + 'T00:00:00');
        const diff = Math.round((d - start) / 86400000);
        return diff >= 0 && diff % n === 0;
      }
      return true;
    }
    return true;
  }

  async _toggle(item) {
    if (!this._canWrite) return;
    const d = this.data;

    // Identify which container to update (items[] / current[] / top-level array)
    let listPath = null;
    if (Array.isArray(d)) listPath = null;               // flat array
    else if (Array.isArray(d?.items)) listPath = 'items';
    else if (Array.isArray(d?.current)) listPath = 'current';

    // For simple non-dose shapes (no doses[], just a taken flag), toggle directly.
    const hasDoses = Array.isArray(item.doses);
    if (!hasDoses && (typeof item.taken === 'boolean' || !item.schedule)) {
      // For supplements and other always-shown items without a doses[] array,
      // store checkoff on the item via a `takenDates: [YYYY-MM-DD, ...]` array.
      const taken = Array.isArray(item.takenDates) ? [...item.takenDates] : [];
      const has = taken.includes(this.date);
      const newTaken = has ? taken.filter(x => x !== this.date) : [...taken, this.date];
      const updatedItem = { ...item, takenDates: newTaken };
      this._updateItem(item, updatedItem, listPath);
      await this._persist();
      return;
    }

    // doses[] shape (peptides-style)
    const now = new Date().toISOString();
    const doses = hasDoses ? [...item.doses] : [];
    const maxPerDay = this._maxReadingsPerDay();
    if (maxPerDay > 1) {
      // Multi mode (#705): each tap stacks a fresh entry up to the cap;
      // the checkbox never unticks. Entries are removed individually via
      // the day's entry list. At the cap a tap is a no-op rather than
      // silently dropping the oldest record.
      if (this._takenEntriesOn(item).length >= maxPerDay) return;
      doses.push({ scheduledDate: this.date, takenAt: now });
      this._updateItem(item, { ...item, doses }, listPath);
      await this._persist();
      return;
    }
    const alreadyTaken = doses.some(dd => dd.scheduledDate === this.date && dd.takenAt);
    if (alreadyTaken) {
      // Untick clears EVERY same-date taken entry: the reader uses .some,
      // so a lingering taken duplicate (chat- or import-written) would
      // otherwise leave the checkbox stuck checked.
      for (let i = 0; i < doses.length; i++) {
        const dd = doses[i];
        if (dd.scheduledDate === this.date && dd.takenAt) doses[i] = { ...dd, takenAt: null };
      }
    } else {
      const idx = doses.findIndex(dd => dd.scheduledDate === this.date);
      if (idx >= 0) doses[idx] = { ...doses[idx], takenAt: now };
      else doses.push({ scheduledDate: this.date, takenAt: now });
    }
    this._updateItem(item, { ...item, doses }, listPath);
    await this._persist();
  }

  // meta.writeable.maxReadingsPerDay (#705): 1 or anything invalid keeps
  // the one-entry-per-date toggle byte-identical. Only doses[] shapes
  // support multi mode; takenDates is date-set membership and cannot
  // carry timestamps.
  _maxReadingsPerDay() {
    const v = this._meta?.writeable?.maxReadingsPerDay;
    return Number.isInteger(v) && v > 1 ? v : 1;
  }

  _takenEntriesOn(item, date = this.date) {
    if (!Array.isArray(item.doses)) return [];
    return item.doses.filter(d => d && d.scheduledDate === date && d.takenAt);
  }

  async _removeDoseEntry(item, entry) {
    if (!this._canWrite) return;
    let listPath = null;
    const d = this.data;
    if (Array.isArray(d?.items)) listPath = 'items';
    else if (Array.isArray(d?.current)) listPath = 'current';
    const doses = (item.doses || []).filter(x => x !== entry);
    this._updateItem(item, { ...item, doses }, listPath);
    await this._persist();
  }

  _updateItem(oldItem, newItem, listPath) {
    const d = this.data;
    if (Array.isArray(d)) {
      this.data = d.map(it => it === oldItem ? newItem : it);
    } else if (listPath) {
      this.data = {
        ...d,
        [listPath]: d[listPath].map(it => it === oldItem ? newItem : it),
      };
    }
  }

  _isDone(item, date = this.date) {
    // Prefer doses[] if present (peptides). .some, not find-first: an
    // unticked entry followed by a taken one must still read as done,
    // and multi mode (#705) can hold several same-day entries.
    if (Array.isArray(item.doses)) {
      return item.doses.some(d => d && d.scheduledDate === date && d.takenAt);
    }
    // Fallback: takenDates array (supplements / simple daily checklist)
    if (Array.isArray(item.takenDates)) return item.takenDates.includes(date);
    return item.taken === true;
  }

  async _persist() {
    try {
      await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: this.data }),
      });
    } catch (e) {
      console.warn('[checklist] save failed', e);
    }
  }

  // Opt-in card-level adherence strip (meta.view.showSparkline): a per-day
  // done/due ratio over the last 30 days ending at this.date. null on no-due
  // days so rest days read as gaps, not misses. Renders nothing unless the
  // flag is set, it is Today, and there are at least 2 days of signal.
  _renderAdherence() {
    if (!this._config.showSparkline) return '';
    const isToday = this.dateMode === 'today' || !this.dateMode;
    if (!isToday) return '';
    const items = this._items;
    if (!items.length) return '';
    const series = adherenceSeries(items, {
      endDate: this.date,
      limit: 30,
      isDueOn: (item, day) => this._isDue(item, day),
      isTakenOn: (item, day) => this._isDone(item, day),
    });
    if (series.filter(v => v !== null).length < 2) return '';
    return html`<div class="cl-spark"><eh-sparkline mode="adherence" .values=${series}></eh-sparkline></div>`;
  }

  renderCard() {
    const items = this._items.filter(i => this._isDue(i));
    if (items.length === 0) {
      return html`<div class="empty">Nothing scheduled.</div>`;
    }
    return html`
      ${this._renderAdherence()}
      <ul class="list">
        ${items.map(item => {
          const done = this._isDone(item);
          const writeable = this._canWrite;
          const maxPerDay = this._maxReadingsPerDay();
          const takenToday = maxPerDay > 1 ? this._takenEntriesOn(item) : [];
          const entryKey = item.name || '';
          const entriesExpanded = this._entriesExpandedKey === entryKey && takenToday.length > 0;
          // Build a sub-line: dose + optional timing separator
          const subParts = [];
          if (item.dose) subParts.push(item.dose);
          if (item.timing) subParts.push(item.timing);
          const sub = subParts.join(' · ');
          return html`
            <li class="item ${done ? 'done' : ''}">
              <div class="item-body">
                <div class="item-name">${item.name}${todChipsFor(item.schedule?.time_of_day).map(c => html`<span class="tod-chip" aria-label=${c.label} title=${c.label}>${c.emoji}</span>`)}</div>
                ${sub ? html`<div class="item-sub">${sub}</div>` : ''}
              </div>
              <div class="item-right">
                ${maxPerDay > 1 && takenToday.length > 0 ? html`
                  <button
                    class="multi-count ${entriesExpanded ? 'open' : ''}"
                    @click=${() => { this._entriesExpandedKey = entriesExpanded ? null : entryKey; }}
                    aria-expanded=${entriesExpanded ? 'true' : 'false'}
                    aria-label="${entriesExpanded ? 'hide' : 'show'} ${takenToday.length} logged ${takenToday.length === 1 ? 'entry' : 'entries'} for ${item.name}"
                    title="Entries logged this day"
                  >×${takenToday.length}</button>` : ''}
                <span
                  class="checkbox ${done ? 'checked' : ''} ${writeable ? '' : 'disabled'}"
                  @click=${() => this._toggle(item)}
                  role="button"
                  tabindex="${writeable ? '0' : '-1'}"
                  aria-label="toggle ${item.name}"
                  @keydown=${writeable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._toggle(item); } } : null}
                ></span>
              </div>
            </li>
            ${entriesExpanded ? html`
              <li class="day-entries">
                ${takenToday.map(e => html`
                  <div class="day-entry">
                    <span class="entry-time">${_entryTimeLabel(e)}</span>
                    ${writeable ? html`
                      <button
                        class="entry-remove"
                        @click=${() => this._removeDoseEntry(item, e)}
                        aria-label="remove this entry for ${item.name}"
                        title="Remove this entry"
                      >✕</button>` : ''}
                  </div>`)}
              </li>` : ''}
          `;
        })}
      </ul>
    `;
  }
}
customElements.define('eh-checklist-card', EhChecklistCard);
registerRenderer('checklist-card', 'eh-checklist-card');
