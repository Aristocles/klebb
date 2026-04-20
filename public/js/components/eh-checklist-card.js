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
import { isScheduledOnDate } from '../lib/schedule.js';

export class EhChecklistCard extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .list { list-style: none; padding: 0; margin: 0; }
      .item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
        font-size: 13px;
        color: var(--text-primary);
      }
      .item .name { flex: 1; }
      .item.done .name { color: var(--text-muted, var(--text-secondary)); text-decoration: line-through; }
      .tickbox {
        width: 18px; height: 18px;
        border: 2px solid var(--border);
        border-radius: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s;
      }
      .tickbox.done {
        background: var(--accent, #00d4aa);
        border-color: var(--accent, #00d4aa);
        color: var(--bg-card);
      }
      .tickbox.disabled { cursor: not-allowed; opacity: 0.5; }
      .tickbox::before {
        content: '';
        font-size: 14px;
        font-weight: 700;
      }
      .tickbox.done::before { content: '✓'; }
      .item-meta {
        font-size: 11px;
        color: var(--text-muted, var(--text-secondary));
      }
      .empty {
        font-size: 12px;
        color: var(--text-muted, var(--text-secondary));
        padding: 4px 0;
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

  _isDue(item) {
    // If item explicitly has a schedule or cycle envelope, use schedule rules.
    if (item.schedule || item.cycles) return !!isScheduledOnDate(item, this.date);
    // Legacy / supplement-style: 'frequency' string as a coarse hint.
    const freq = (item.frequency || '').toLowerCase();
    if (!freq) return true;             // no schedule info → always show
    if (freq === 'daily') return true;
    if (freq === 'as needed') return false;
    if (freq === 'weekly') {
      // Weekly on a specific day if declared; else Monday default
      const cfgDay = (item.day || 'Mon').toString().slice(0, 3).toLowerCase();
      const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
      const todayName = dayNames[new Date(this.date + 'T00:00:00').getDay()];
      return todayName === cfgDay;
    }
    if (/^every\s+(\d+)/.test(freq)) {
      const n = parseInt(freq.match(/^every\s+(\d+)/)[1], 10);
      if (item.startDate) {
        const start = new Date(item.startDate + 'T00:00:00');
        const d = new Date(this.date + 'T00:00:00');
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

  _isDone(item) {
    // Prefer doses[] if present (peptides)
    if (Array.isArray(item.doses)) {
      const match = item.doses.find(d => d.scheduledDate === this.date);
      return !!(match && match.takenAt);
    }
    // Fallback: takenDates array (supplements / simple daily checklist)
    if (Array.isArray(item.takenDates)) return item.takenDates.includes(this.date);
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

  renderCard() {
    const items = this._items.filter(i => this._isDue(i));
    if (items.length === 0) {
      return html`<div class="empty">Nothing scheduled.</div>`;
    }
    return html`
      <ul class="list">
        ${items.map(item => {
          const done = this._isDone(item);
          const writeable = this._canWrite;
          return html`
            <li class="item ${done ? 'done' : ''}">
              <span
                class="tickbox ${done ? 'done' : ''} ${writeable ? '' : 'disabled'}"
                @click=${() => this._toggle(item)}
                role="button"
                aria-label="toggle ${item.name}"
              ></span>
              <span class="name">${item.name}</span>
              ${item.dose ? html`<span class="item-meta">${item.dose}</span>` : ''}
              ${item.timing && !item.dose ? html`<span class="item-meta">${item.timing}</span>` : ''}
            </li>
          `;
        })}
      </ul>
    `;
  }
}
customElements.define('eh-checklist-card', EhChecklistCard);
registerRenderer('checklist-card', 'eh-checklist-card');
