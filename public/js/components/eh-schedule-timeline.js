// eh-schedule-timeline.js — placeholder v2 renderer for schedule + doses.
// Full dot-grid visualisation lands in a future iteration.
// For now, shows a tidy summary: per-item last dose + adherence count.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { isScheduledOnDate } from '../lib/schedule.js';
import { registerRenderer } from '../renderer-registry.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export class EhScheduleTimeline extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .summary {
        font-size: 12px;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
      .item-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
        border-bottom: 1px solid var(--border);
        font-size: 12px;
      }
      .item-row:last-child { border-bottom: none; }
      .name {
        flex: 1;
        color: var(--text-primary);
        font-weight: 600;
      }
      .last-dose {
        color: var(--text-muted, var(--text-secondary));
        font-size: 11px;
      }
      .count {
        color: var(--accent);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        min-width: 40px;
        text-align: right;
      }
      .scheduled-badge {
        background: var(--accent-bg, rgba(0,212,170,0.15));
        color: var(--accent);
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 6px;
        font-weight: 600;
      }
    `,
  ];

  renderCard() {
    const d = this.data;
    const items = (d && Array.isArray(d.items)) ? d.items : [];
    if (items.length === 0) {
      return html`<div class="summary">No scheduled items.</div>`;
    }
    const today = todayStr();
    return html`
      <div class="summary">
        ${items.length} items tracked. Recent adherence per item:
      </div>
      ${items.map(item => {
        const doses = Array.isArray(item.doses) ? item.doses : [];
        const taken = doses.filter(dd => dd.takenAt).length;
        const lastDose = doses.filter(dd => dd.takenAt).sort((a,b) => (b.scheduledDate||'').localeCompare(a.scheduledDate||''))[0];
        const dueToday = isScheduledOnDate(item, today);
        return html`
          <div class="item-row">
            <span class="name">${item.name}</span>
            ${dueToday === 'scheduled' ? html`<span class="scheduled-badge">today</span>` : ''}
            ${lastDose ? html`<span class="last-dose">last: ${lastDose.scheduledDate}</span>` : ''}
            <span class="count">${taken}</span>
          </div>
        `;
      })}
    `;
  }
}
customElements.define('eh-schedule-timeline', EhScheduleTimeline);
registerRenderer('schedule-timeline', 'eh-schedule-timeline');
