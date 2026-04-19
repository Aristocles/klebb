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
    return [];
  }

  _isDue(item) {
    // If item has no schedule, assume always-visible
    if (!item.schedule && !item.cycles) return true;
    return !!isScheduledOnDate(item, this.date);
  }

  _isDone(item) {
    if (!Array.isArray(item.doses)) return item.taken === true;
    const match = item.doses.find(d => d.scheduledDate === this.date);
    return !!(match && match.takenAt);
  }

  async _toggle(item) {
    if (!this._canWrite) return;
    if (!Array.isArray(this.data?.items)) {
      // Simple shape: { taken }
      item.taken = !item.taken;
      this.requestUpdate();
      await this._persist();
      return;
    }
    const now = new Date().toISOString();
    const doses = Array.isArray(item.doses) ? [...item.doses] : [];
    const idx = doses.findIndex(d => d.scheduledDate === this.date);
    if (idx >= 0) {
      // toggle
      if (doses[idx].takenAt) doses[idx] = { ...doses[idx], takenAt: null };
      else doses[idx] = { ...doses[idx], takenAt: now };
    } else {
      doses.push({ scheduledDate: this.date, takenAt: now });
    }
    // Update item in place
    const updatedItems = this.data.items.map(it => it === item ? { ...it, doses } : it);
    this.data = { ...this.data, items: updatedItems };
    await this._persist();
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
            </li>
          `;
        })}
      </ul>
    `;
  }
}
customElements.define('eh-checklist-card', EhChecklistCard);
registerRenderer('checklist-card', 'eh-checklist-card');
