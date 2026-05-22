// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-schedule-timeline.js — dot-grid per-cycle adherence visualisation.
//
// For each cycle (active + scheduled future + completed), renders a
// horizontal row of dots, one per cycle day. Dot state:
//   - solid accent-coloured: scheduled + taken
//   - solid red: scheduled + missed (past date, no takenAt)
//   - hollow grey: rest day, no dose
//   - solid amber: rest day with an off-schedule dose logged
//   - accent ring: today's date marker
//   - hollow grey, extra dim: future scheduled date not yet due
//
// Rows group by cycle (not item). For an item with 3 cycles, user sees
// three rows.
//
// Hover (desktop) / tap (mobile) a dot → tooltip showing date + state.
//
// Component name: 'schedule-timeline'

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { isScheduledOnDate, enumerateDates } from '../lib/schedule.js';
import { registerRenderer } from '../renderer-registry.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function fmtDateFull(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const DEFAULT_VOCAB = {
  done: 'Taken',
  missed: 'Missed',
  offSchedule: 'Off-schedule dose',
  upcoming: 'Scheduled',
  rest: 'Rest day',
};

function resolveVocab(viewConfig) {
  const v = viewConfig?.vocab || {};
  return { ...DEFAULT_VOCAB, ...v };
}

// Build the dot array for one cycle.
// Returns [{ date, state, label }] where state ∈ {
//   'taken' | 'missed' | 'rest' | 'off-schedule' | 'today' | 'future-scheduled' | 'future-rest'
// }
function buildDotArray(item, cycle, vocab = DEFAULT_VOCAB) {
  const today = todayStr();
  const { start_date, end_date } = cycle;
  if (!start_date || !end_date) return [];

  let dates = [];
  try { dates = enumerateDates(start_date, end_date); } catch { return []; }

  const doses = Array.isArray(item.doses) ? item.doses : [];
  const doseByDate = new Map();
  for (const dx of doses) {
    if (!dx.scheduledDate) continue;
    if (dx.scheduledDate < start_date || dx.scheduledDate > end_date) continue;
    doseByDate.set(dx.scheduledDate, dx);
  }

  return dates.map(date => {
    const isScheduled = isScheduledOnDate(item, date) === 'scheduled';
    const dose = doseByDate.get(date);
    const taken = !!(dose && dose.takenAt);
    const isToday = date === today;
    const isFuture = date > today;
    const isOff = !!(dose?.offSchedule) || (taken && !isScheduled);

    let state;
    let label;
    if (taken && isOff) {
      state = 'off-schedule';
      label = vocab.offSchedule;
    } else if (taken) {
      state = 'taken';
      label = vocab.done;
    } else if (isScheduled && isFuture) {
      state = 'future-scheduled';
      label = vocab.upcoming;
    } else if (isScheduled) {
      state = 'missed';
      label = vocab.missed;
    } else if (isFuture) {
      state = 'future-rest';
      label = vocab.rest;
    } else {
      state = 'rest';
      label = vocab.rest;
    }

    return { date, state, label, isToday };
  });
}

function cycleSummary(dots) {
  const taken = dots.filter(d => d.state === 'taken').length;
  const missed = dots.filter(d => d.state === 'missed').length;
  const off = dots.filter(d => d.state === 'off-schedule').length;
  const future = dots.filter(d => d.state === 'future-scheduled').length;
  return { taken, missed, off, future };
}

function sortCyclesAcrossItems(items) {
  const rows = [];
  for (const item of items || []) {
    for (const cycle of item.cycles || []) {
      rows.push({ item, cycle });
    }
  }
  rows.sort((a, b) => {
    const aa = a.cycle.status === 'active' ? 0 : 1;
    const bb = b.cycle.status === 'active' ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return (a.cycle.start_date || '').localeCompare(b.cycle.start_date || '');
  });
  return rows;
}

export class EhScheduleTimeline extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _tooltip: { state: true },
  };

  constructor() {
    super();
    this._tooltip = null;
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .timeline-root { padding: 0 2px; }

      .cycle-block {
        padding: 10px 4px 14px;
        border-bottom: 1px dashed var(--border);
      }
      .cycle-block:last-child { border-bottom: none; }

      .cycle-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .cycle-name {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-primary);
      }
      .cycle-badge {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        padding: 1px 6px;
        border-radius: 8px;
        letter-spacing: 0.04em;
      }
      .cycle-badge.active    { background: #44b070; color: #fff; }
      .cycle-badge.completed { background: var(--border); color: var(--text-secondary); }
      .cycle-badge.scheduled { background: var(--bg-muted, rgba(0,0,0,0.04)); color: var(--text-secondary); border: 1px dashed var(--border); }
      .cycle-dates {
        font-size: 10px;
        color: var(--text-secondary);
        margin-left: auto;
      }

      .dot-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 6px;
      }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 1.5px solid transparent;
        cursor: pointer;
        transition: transform 0.1s;
      }
      .dot:hover { transform: scale(1.3); }
      .dot.today { outline: 2px solid var(--accent); outline-offset: 1px; }

      .dot.taken            { background: var(--accent); }
      .dot.missed           { background: transparent; border-color: #d0323e; }
      .dot.rest             { background: transparent; border-color: var(--border); }
      .dot.off-schedule     { background: #d0a030; }
      .dot.future-scheduled { background: transparent; border-color: var(--accent); border-style: dashed; opacity: 0.5; }
      .dot.future-rest      { background: transparent; border-color: var(--border); opacity: 0.3; }

      .cycle-summary {
        display: flex;
        gap: 12px;
        font-size: 10px;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .cycle-summary strong { color: var(--text-primary); }
      .cycle-summary .taken  { color: #44b070; }
      .cycle-summary .missed { color: #d0323e; }
      .cycle-summary .off    { color: #d0a030; }

      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        padding: 8px 4px;
        border-top: 1px solid var(--border);
        margin-top: 6px;
        font-size: 10px;
        color: var(--text-secondary);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .tooltip {
        position: fixed;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 11px;
        color: var(--text-primary);
        pointer-events: none;
        z-index: 100;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      }
      .tooltip-state { font-weight: 600; }
      .tooltip-state.taken        { color: #44b070; }
      .tooltip-state.missed       { color: #d0323e; }
      .tooltip-state.off-schedule { color: #d0a030; }

      .empty {
        padding: 24px 16px;
        text-align: center;
        color: var(--text-muted, var(--text-secondary));
        font-size: 13px;
      }

      @media (prefers-reduced-motion: reduce) {
        .dot { transition: none; }
      }
    `,
  ];

  _onDotEnter(e, dot) {
    const rect = e.target.getBoundingClientRect();
    this._tooltip = {
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
      date: dot.date,
      label: dot.label,
      state: dot.state,
    };
  }
  _onDotLeave() {
    this._tooltip = null;
  }

  renderCard() {
    const d = this.data;
    const items = Array.isArray(d?.items) ? d.items : (Array.isArray(d) ? d : []);
    if (items.length === 0) {
      return html`<div class="empty">No cycles yet.</div>`;
    }
    const rows = sortCyclesAcrossItems(items);
    const vocab = resolveVocab(this._config);

    return html`
      <div class="timeline-root">
        ${rows.map(({ item, cycle }) => this._renderCycleBlock(item, cycle, vocab))}
        <div class="legend">
          <span class="legend-item"><span class="dot taken"></span> ${vocab.done}</span>
          <span class="legend-item"><span class="dot missed"></span> ${vocab.missed}</span>
          <span class="legend-item"><span class="dot off-schedule"></span> ${vocab.offSchedule}</span>
          <span class="legend-item"><span class="dot future-scheduled"></span> ${vocab.upcoming}</span>
          <span class="legend-item"><span class="dot rest"></span> ${vocab.rest}</span>
        </div>
      </div>

      ${this._tooltip ? html`
        <div
          class="tooltip"
          style="left: ${this._tooltip.x}px; top: ${this._tooltip.y}px; transform: translate(-50%, -100%);"
        >
          <div>${fmtDateFull(this._tooltip.date)}</div>
          <div class="tooltip-state ${this._tooltip.state}">${this._tooltip.label}</div>
        </div>
      ` : ''}
    `;
  }

  _renderCycleBlock(item, cycle, vocab = DEFAULT_VOCAB) {
    const dots = buildDotArray(item, cycle, vocab);
    const summary = cycleSummary(dots);
    return html`
      <div class="cycle-block">
        <div class="cycle-head">
          <span class="cycle-name">${item.short_name || item.name}${cycle.cycle_number ? ' · C' + cycle.cycle_number : ''}</span>
          <span class="cycle-badge ${cycle.status}">${cycle.status}</span>
          <span class="cycle-dates">${fmtDate(cycle.start_date)} → ${fmtDate(cycle.end_date)}</span>
        </div>
        <div class="dot-row">
          ${dots.map(dot => html`
            <span
              class="dot ${dot.state} ${dot.isToday ? 'today' : ''}"
              @mouseenter=${(e) => this._onDotEnter(e, dot)}
              @mouseleave=${this._onDotLeave}
              @click=${(e) => this._onDotEnter(e, dot)}
              title="${fmtDateFull(dot.date)} · ${dot.label}"
            ></span>
          `)}
        </div>
        <div class="cycle-summary">
          <span class="taken"><strong>${summary.taken}</strong> ${vocab.done.toLowerCase()}</span>
          ${summary.missed > 0 ? html`<span class="missed"><strong>${summary.missed}</strong> ${vocab.missed.toLowerCase()}</span>` : ''}
          ${summary.off > 0 ? html`<span class="off"><strong>${summary.off}</strong> ${vocab.offSchedule.toLowerCase()}</span>` : ''}
          ${summary.future > 0 ? html`<span>${summary.future} ${vocab.upcoming.toLowerCase()}</span>` : ''}
        </div>
      </div>
    `;
  }
}
customElements.define('eh-schedule-timeline', EhScheduleTimeline);
registerRenderer('schedule-timeline', 'eh-schedule-timeline');
