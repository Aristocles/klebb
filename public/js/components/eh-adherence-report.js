// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-adherence-report.js
// Peptide-cycle adherence summary across all items.
//
// Shows for each item, ordered by cycle start date:
//   - Cycle range: start-date → end-date
//   - Status: active / scheduled / completed
//   - Adherence bar: taken / scheduled, coloured by completeness
//   - Missed count, off-schedule extras count
//   - Total across-all summary at the top
//
// Reads the peptides.json data shape: data.items[].cycles[] + doses[].
// A dose is "scheduled" if its scheduledDate is within the cycle + the
// item's schedule evaluates true on that date. A dose is "taken" if
// takenAt is truthy. A dose without a matching scheduled date (but with
// takenAt) counts as off-schedule.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { isScheduledOnDate, enumerateDates } from '../../../lib/schedule.mjs';
import { registerRenderer } from '../renderer-registry.js';
import { chipsFor as todChipsFor } from '../lib/time-of-day.esm.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Aggregate dose-status counts for one cycle.
// Returns { scheduled, taken, missed, offSchedule, upcoming }.
function cycleStats(item, cycle) {
  const today = todayStr();
  const { start_date, end_date, status } = cycle;
  if (!start_date || !end_date) {
    return { scheduled: 0, taken: 0, missed: 0, offSchedule: 0, upcoming: 0, cycleIsFuture: false };
  }

  // Enumerate every date in the cycle window
  let dates = [];
  try { dates = enumerateDates(start_date, end_date); } catch { dates = []; }

  // Dates on which the schedule says a dose IS due
  const scheduledSet = new Set(dates.filter(d => isScheduledOnDate(item, d)));

  // All dose records for this item (item-level, not cycle-scoped)
  const doses = Array.isArray(item.doses) ? item.doses : [];
  // Doses WITHIN this cycle's date range
  const dosesInCycle = doses.filter(x => {
    const d = x.scheduledDate || (x.takenAt ? x.takenAt.slice(0, 10) : null);
    return d && d >= start_date && d <= end_date;
  });

  // Taken = count of dosesInCycle with takenAt
  const taken = dosesInCycle.filter(x => x.takenAt).length;

  // Off-schedule = taken doses where that date isn't in scheduledSet
  const offSchedule = dosesInCycle.filter(x => {
    if (!x.takenAt) return false;
    const d = x.scheduledDate || x.takenAt.slice(0, 10);
    return !scheduledSet.has(d);
  }).length;

  // Missed = scheduled dates before today, no takenAt entry
  const takenScheduledDates = new Set(
    dosesInCycle.filter(x => x.takenAt && x.scheduledDate).map(x => x.scheduledDate)
  );
  const missed = [...scheduledSet].filter(d => d < today && !takenScheduledDates.has(d)).length;

  // Upcoming = scheduled dates today or future
  const upcoming = [...scheduledSet].filter(d => d >= today).length;

  // A cycle can be completely in the future → nothing counts as missed yet
  const cycleIsFuture = status === 'scheduled' && start_date > today;

  return {
    scheduled: scheduledSet.size,
    taken,
    missed: cycleIsFuture ? 0 : missed,
    offSchedule,
    upcoming,
    cycleIsFuture,
  };
}

function adherencePct(stats) {
  const past = stats.scheduled - stats.upcoming;
  if (past <= 0) return null;
  return Math.round((stats.taken - stats.offSchedule) / past * 100);
}

function sortCyclesAcrossItems(items) {
  // Flatten to { item, cycle } and sort by start_date ascending.
  // Active cycles float to the top regardless of start.
  const rows = [];
  for (const item of items || []) {
    for (const cycle of item.cycles || []) {
      rows.push({ item, cycle });
    }
  }
  rows.sort((a, b) => {
    // Active first
    const aa = a.cycle.status === 'active' ? 0 : 1;
    const bb = b.cycle.status === 'active' ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return (a.cycle.start_date || '').localeCompare(b.cycle.start_date || '');
  });
  return rows;
}

export class EhAdherenceReport extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .report-root { padding: 0 2px; }

      .overview {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 16px;
      }
      @media (max-width: 480px) {
        .overview { grid-template-columns: repeat(2, 1fr); }
      }
      .stat-cell {
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-card);
      }
      .stat-num {
        font-size: 1.6rem;
        font-weight: 700;
        line-height: 1;
        font-variant-numeric: tabular-nums;
      }
      .stat-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted, var(--text-secondary));
        margin-top: 4px;
      }
      .stat-num.ok   { color: #44b070; }
      .stat-num.warn { color: #d0a030; }
      .stat-num.err  { color: #d0323e; }
      .stat-num.neutral { color: var(--text-primary); }

      .section-h {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted, var(--text-secondary));
        margin: 18px 0 8px;
      }

      .cycle-row {
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        margin-bottom: 8px;
        background: var(--bg-card);
      }
      .cycle-row.active { border-left: 4px solid var(--accent); }
      .cycle-row.future { opacity: 0.72; }

      .cycle-head {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .cycle-name {
        font-size: 14px;
        font-weight: 700;
        color: var(--text-primary);
        flex: 1;
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
      .cycle-badge {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 10px;
        letter-spacing: 0.04em;
      }
      .cycle-badge.active    { background: #44b070; color: #fff; }
      .cycle-badge.completed { background: var(--border); color: var(--text-secondary); }
      .cycle-badge.scheduled { background: var(--bg-muted, rgba(0,0,0,0.04)); color: var(--text-secondary); border: 1px dashed var(--border); }

      .cycle-dates {
        font-size: 11px;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
      .cycle-dates strong {
        color: var(--text-primary);
        font-weight: 500;
      }
      .dot { opacity: 0.5; padding: 0 4px; }

      .bar-wrap {
        height: 6px;
        background: var(--border);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 6px;
        position: relative;
      }
      .bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #44b070, #77c488);
        border-radius: 3px;
        transition: width 0.3s;
      }
      .bar-fill.warn { background: linear-gradient(90deg, #d0a030, #ddc050); }
      .bar-fill.err { background: linear-gradient(90deg, #d0323e, #e05050); }

      .cycle-stats {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .cycle-stats strong { color: var(--text-primary); }
      .cycle-stats .off { color: #d0a030; }
      .cycle-stats .missed { color: #d0323e; }
      .cycle-stats .pct {
        margin-left: auto;
        font-weight: 700;
        color: var(--text-primary);
      }

      .empty {
        padding: 24px 16px;
        text-align: center;
        color: var(--text-muted, var(--text-secondary));
        font-size: 13px;
      }

      @media (prefers-reduced-motion: reduce) {
        .bar-fill { transition: none; }
      }
    `,
  ];

  renderCard() {
    // Expect a peptides-style payload: { items: [...], groups?: [...] }
    const d = this.data;
    const items = Array.isArray(d?.items) ? d.items : (Array.isArray(d) ? d : []);
    if (items.length === 0) {
      return html`<div class="empty">No cycles to report yet.</div>`;
    }

    const rows = sortCyclesAcrossItems(items);
    const vocab = {
      headline: 'Adherence',
      done: 'Doses taken',
      missed: 'Missed',
      offSchedule: 'Off-schedule',
      noun: 'taken',
      ...(this._config?.vocab || {}),
    };

    // Aggregate totals across every cycle in-window (active + past)
    const today = todayStr();
    let totScheduled = 0, totTaken = 0, totMissed = 0, totOff = 0;
    let activeCycles = 0, upcomingCycles = 0;
    for (const { item, cycle } of rows) {
      if (cycle.status === 'active') activeCycles++;
      if (cycle.status === 'scheduled' && cycle.start_date > today) upcomingCycles++;
      const s = cycleStats(item, cycle);
      totScheduled += s.scheduled;
      totTaken     += s.taken;
      totMissed    += s.missed;
      totOff       += s.offSchedule;
    }
    const overallPct = totScheduled - (rows.reduce((a, { item, cycle }) => a + cycleStats(item, cycle).upcoming, 0))
      ? Math.round(totTaken / (totScheduled - rows.reduce((a, { item, cycle }) => a + cycleStats(item, cycle).upcoming, 0)) * 100)
      : null;

    return html`
      <div class="report-root">
        <div class="overview">
          <div class="stat-cell">
            <div class="stat-num ${overallPct === null ? 'neutral' : overallPct >= 90 ? 'ok' : overallPct >= 70 ? 'warn' : 'err'}">${overallPct === null ? '—' : overallPct + '%'}</div>
            <div class="stat-label">${vocab.headline}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-num neutral">${totTaken}</div>
            <div class="stat-label">${vocab.done}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-num ${totMissed > 0 ? 'err' : 'neutral'}">${totMissed}</div>
            <div class="stat-label">${vocab.missed}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-num ${totOff > 0 ? 'warn' : 'neutral'}">${totOff}</div>
            <div class="stat-label">${vocab.offSchedule}</div>
          </div>
        </div>

        ${activeCycles > 0 ? html`
          <div class="section-h">Active cycles · ${activeCycles}</div>
          ${rows.filter(r => r.cycle.status === 'active').map(r => this._renderCycleRow(r, vocab))}
        ` : ''}

        ${rows.some(r => r.cycle.status === 'scheduled' && r.cycle.start_date > today) ? html`
          <div class="section-h">Upcoming · ${upcomingCycles}</div>
          ${rows.filter(r => r.cycle.status === 'scheduled' && r.cycle.start_date > today).map(r => this._renderCycleRow(r, vocab))}
        ` : ''}

        ${rows.some(r => r.cycle.status === 'completed') ? html`
          <div class="section-h">Completed</div>
          ${rows.filter(r => r.cycle.status === 'completed').map(r => this._renderCycleRow(r, vocab))}
        ` : ''}
      </div>
    `;
  }

  _renderCycleRow({ item, cycle }, vocab = { noun: 'taken', missed: 'missed', offSchedule: 'off-schedule' }) {
    const stats = cycleStats(item, cycle);
    const pct = adherencePct(stats);
    const barClass = pct === null ? '' : pct >= 90 ? '' : pct >= 70 ? 'warn' : 'err';
    const isActive = cycle.status === 'active';
    const isFuture = stats.cycleIsFuture;
    const pastCount = stats.scheduled - stats.upcoming;

    const todChips = todChipsFor(item.schedule?.time_of_day);
    return html`
      <div class="cycle-row ${isActive ? 'active' : ''} ${isFuture ? 'future' : ''}">
        <div class="cycle-head">
          <span class="cycle-name">${item.name}${cycle.cycle_number ? ' · Cycle ' + cycle.cycle_number : ''}${todChips.map(c => html`<span class="tod-chip" aria-label=${c.label} title=${c.label}>${c.emoji}</span>`)}</span>
          <span class="cycle-badge ${cycle.status}">${cycle.status}</span>
        </div>
        <div class="cycle-dates">
          <strong>${fmtDate(cycle.start_date)}</strong>
          <span class="dot">→</span>
          <strong>${fmtDate(cycle.end_date)}</strong>
        </div>
        ${stats.scheduled > 0 && !isFuture ? html`
          <div class="bar-wrap">
            <div
              class="bar-fill ${barClass}"
              style="width: ${pct === null ? 0 : pct}%;"
            ></div>
          </div>
        ` : ''}
        <div class="cycle-stats">
          <span><strong>${stats.taken}</strong> / ${stats.scheduled} ${vocab.noun}</span>
          ${stats.missed > 0 ? html`<span class="missed"><strong>${stats.missed}</strong> ${vocab.missed.toLowerCase()}</span>` : ''}
          ${stats.offSchedule > 0 ? html`<span class="off"><strong>${stats.offSchedule}</strong> ${vocab.offSchedule.toLowerCase()}</span>` : ''}
          ${stats.upcoming > 0 ? html`<span>${stats.upcoming} upcoming</span>` : ''}
          ${pct !== null ? html`<span class="pct">${pct}%</span>` : ''}
        </div>
      </div>
    `;
  }
}
customElements.define('eh-adherence-report', EhAdherenceReport);
registerRenderer('adherence-report', 'eh-adherence-report');
