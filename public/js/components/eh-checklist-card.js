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
import { adherenceSeries } from '../lib/adherence-series.esm.js';
import './eh-sparkline.js';

export class EhChecklistCard extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .list { list-style: none; padding: 0; margin: 0; }
      .cl-spark { margin: 0 0 10px; line-height: 0; }

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
    const idx = doses.findIndex(dd => dd.scheduledDate === this.date);
    if (idx >= 0) {
      if (doses[idx].takenAt) doses[idx] = { ...doses[idx], takenAt: null };
      else doses[idx] = { ...doses[idx], takenAt: now };
    } else {
      doses.push({ scheduledDate: this.date, takenAt: now });
    }
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
    // Prefer doses[] if present (peptides)
    if (Array.isArray(item.doses)) {
      const match = item.doses.find(d => d.scheduledDate === date);
      return !!(match && match.takenAt);
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
          `;
        })}
      </ul>
    `;
  }
}
customElements.define('eh-checklist-card', EhChecklistCard);
registerRenderer('checklist-card', 'eh-checklist-card');
