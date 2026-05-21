// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-schedule-card.js — rich per-item card for scheduled protocols.
// Replaces the bare checklist-card for the peptides/medication data file.
// Shows:
//   - Cycle ring (SVG 48px, progress = cycleDay / cycleTotalDays)
//   - Name + short_name
//   - Dose label + units
//   - "Cycle N — Day X of Y" subtitle
//   - M T W T F S S week dots (filled on scheduled days, ring on the
//     day currently being viewed)
//   - Injection checkbox (appends to item.doses[])
//   - Status chip (Inject / Rest Day / Off Cycle / Loading / Maint)
//
// Reads from a v2 manifest whose data block is { items: [...], groups?: [...] }
// Each item has: name, short_name?, dose_mg, dose_units, route, schedule,
// cycles[], doses[].

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { isScheduledOnDate, effectiveCycles } from '../lib/schedule.js';
import { registerRenderer } from '../renderer-registry.js';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Hash a string to a stable hex colour (used when itemColours isn't in meta).
function autoColour(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

// Mon-first week for a given date.
function weekDatesFor(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const wd = new Date(monday);
    wd.setDate(monday.getDate() + i);
    out.push(iso(wd));
  }
  return out;
}

// Find the active cycle that contains the given date.
function activeCycle(item, dateStr) {
  const cycles = effectiveCycles(item);
  if (!cycles) return null;
  for (const c of cycles) {
    const start = c.start || c.start_date;
    const end = c.end || c.end_date;
    if (!start) continue;
    if (end ? (dateStr >= start && dateStr <= end) : (dateStr >= start)) return c;
  }
  return null;
}

// Day number of the cycle (1-based), total days in cycle (if end date known).
function cycleProgress(item, dateStr) {
  const c = activeCycle(item, dateStr);
  if (!c) return { day: 0, total: 0, type: null, cycle: null };
  const start = c.start || c.start_date;
  const end = c.end || c.end_date;
  const d = new Date(dateStr + 'T00:00:00');
  const s = new Date(start + 'T00:00:00');
  const day = Math.round((d - s) / 86400000) + 1;
  if (!end) return { day, total: 0, type: c.type || 'on', cycle: c };
  const e = new Date(end + 'T00:00:00');
  const total = Math.round((e - s) / 86400000) + 1;
  return { day, total, type: c.type || 'on', cycle: c };
}

export class EhScheduleCard extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .items {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .item {
        display: grid;
        grid-template-columns: 54px minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        min-width: 0;
      }
      /* Cycle ring */
      .ring {
        position: relative;
        width: 48px;
        height: 48px;
      }
      .ring svg {
        width: 48px;
        height: 48px;
        transform: rotate(-90deg);
      }
      .ring-bg { fill: none; stroke: var(--border); stroke-width: 4; }
      .ring-fg { fill: none; stroke-width: 4; stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; }
      .ring-label {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 700;
        color: var(--text-muted, var(--text-secondary));
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .info { min-width: 0; }
      .name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .dose {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 1px;
      }
      .cycle-text {
        font-size: 11px;
        color: var(--text-muted, var(--text-secondary));
        margin-top: 1px;
      }

      /* Week dots */
      .week {
        display: flex;
        gap: 4px;
        margin-top: 6px;
        /* On very narrow phones the info column may be thinner than
           7 × dot width + gaps; allow a gentle horizontal scroll
           rather than breaking the grid + forcing the page wider. */
        overflow-x: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .week::-webkit-scrollbar { display: none; }
      .dot {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        font-weight: 700;
        transition: all 0.15s;
        box-sizing: border-box;
        flex-shrink: 0;
      }
      .dot.inactive {
        background: var(--bg-card);
        color: var(--text-muted, var(--text-secondary));
        border: 1px solid var(--border);
      }
      .dot.active {
        border: 2px solid var(--dot-colour, var(--accent));
        color: var(--dot-colour, var(--accent));
        background: transparent;
      }
      .dot.selected-ring {
        box-shadow: 0 0 0 2px var(--bg-card), 0 0 0 3px var(--accent);
      }
      .dot.active.selected-ring {
        background: var(--dot-colour, var(--accent));
        color: white;
      }

      /* Status chip + checkbox */
      .right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
      }
      .chip {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        white-space: nowrap;
      }
      .chip.inject {
        background: var(--accent-bg, rgba(0,212,170,0.15));
        color: var(--accent);
      }
      .chip.rest {
        background: rgba(136,136,170,0.15);
        color: var(--text-secondary);
      }
      .chip.off {
        background: rgba(136,136,170,0.15);
        color: var(--text-muted, var(--text-secondary));
      }
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
      }
      .checkbox.checked::before { content: '✓'; }
      .checkbox.disabled { opacity: 0.4; cursor: not-allowed; }

      /* Off-schedule variant: dimmer, dashed border, amber when checked.
         Appears on rest-days to let the user log an extra dose. */
      .checkbox.off-schedule {
        opacity: 0.55;
        border-style: dashed;
        border-color: var(--text-muted, var(--text-secondary));
      }
      .checkbox.off-schedule:hover {
        opacity: 1;
        border-color: #d0a030;
        border-style: solid;
      }
      .checkbox.off-schedule.checked {
        opacity: 1;
        background: #d0a030;
        border-color: #d0a030;
        border-style: solid;
        color: white;
      }
      .checkbox.off-schedule.checked::before { content: '✓'; }

      .empty {
        color: var(--text-muted, var(--text-secondary));
        font-size: 12px;
        padding: 8px 0;
      }

      @media (max-width: 480px) {
        .item { grid-template-columns: 44px minmax(0, 1fr) auto; gap: 8px; }
        .ring, .ring svg { width: 40px; height: 40px; }
        .dot { width: 20px; height: 20px; }
      }
    `,
  ];

  get _items() {
    const d = this.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.items)) return d.items;
    return [];
  }

  _colourFor(item) {
    // Try meta-declared colours first (meta.view.colorMap { name: colour })
    const map = this._config?.colorMap || this._meta?.colorMap;
    if (map && typeof map === 'object' && map[item.name]) return map[item.name];
    return autoColour(item.name || 'item');
  }

  _isTakenOn(item, dateStr) {
    if (!Array.isArray(item.doses)) return false;
    const hit = item.doses.find(d => d.scheduledDate === dateStr);
    return !!(hit && hit.takenAt);
  }

  _statusChip(item) {
    const status = isScheduledOnDate(item, this.date);
    if (status === 'scheduled') return { cls: 'inject', text: item.route === 'intranasal' ? 'Spray' : 'Inject' };
    if (status === 'rest') return { cls: 'rest', text: 'Rest day' };
    if (status === 'off') return { cls: 'off', text: 'Off cycle' };
    return null; // outside all cycles — don't show
  }

  _doseLabel(item) {
    if (item.dose_label) return item.dose_label;
    if (item.dose_mg != null) return `${item.dose_mg}mg`;
    if (item.dose) return item.dose;
    return '';
  }

  async _toggleDose(item, opts = {}) {
    if (!this._canWrite) return;
    const doses = Array.isArray(item.doses) ? [...item.doses] : [];
    const idx = doses.findIndex(d => d.scheduledDate === this.date);
    if (idx >= 0) {
      if (doses[idx].takenAt) doses[idx] = { ...doses[idx], takenAt: null };
      else {
        const updated = { ...doses[idx], takenAt: new Date().toISOString() };
        if (opts.offSchedule) updated.offSchedule = true;
        doses[idx] = updated;
      }
    } else {
      const entry = { scheduledDate: this.date, takenAt: new Date().toISOString() };
      if (opts.offSchedule) entry.offSchedule = true;
      doses.push(entry);
    }
    // Update the item in this.data.items
    const d = this.data;
    const updatedItems = d.items.map(it => it === item ? { ...it, doses } : it);
    this.data = { ...d, items: updatedItems };
    this.requestUpdate();
    try {
      await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: this.data }),
      });
    } catch (e) {
      console.warn('[schedule] save failed', e);
    }
  }

  _renderRing(cp, colour) {
    const r = 18;
    const circ = 2 * Math.PI * r;
    const pct = cp.total > 0 ? Math.min(1, cp.day / cp.total) : 0;
    const offset = circ * (1 - pct);
    const label = cp.total > 0 ? `${cp.day}/${cp.total}` : `d${cp.day}`;
    return html`
      <div class="ring">
        <svg viewBox="0 0 48 48">
          <circle class="ring-bg" cx="24" cy="24" r="${r}"></circle>
          <circle class="ring-fg" cx="24" cy="24" r="${r}"
                  stroke="${colour}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${offset}"></circle>
        </svg>
        <span class="ring-label">${label}</span>
      </div>
    `;
  }

  _renderWeekDots(item, colour) {
    const week = weekDatesFor(this.date);
    return html`
      <div class="week">
        ${week.map((wd, i) => {
          const status = isScheduledOnDate(item, wd);
          const active = status === 'scheduled';
          const isSelected = wd === this.date;
          const classes = ['dot'];
          classes.push(active ? 'active' : 'inactive');
          if (isSelected) classes.push('selected-ring');
          return html`<span class="${classes.join(' ')}" style="--dot-colour: ${colour}">${DAY_LETTERS[i]}</span>`;
        })}
      </div>
    `;
  }

  renderCard() {
    const items = this._items;
    if (items.length === 0) return html`<div class="empty">Nothing scheduled.</div>`;
    // Filter: only render items that have some form of activity (scheduled today OR rest OR in cycle)
    const visible = items.filter(it => activeCycle(it, this.date));
    return html`
      <div class="items">
        ${visible.map(item => {
          const colour = this._colourFor(item);
          const cp = cycleProgress(item, this.date);
          const chip = this._statusChip(item);
          const taken = this._isTakenOn(item, this.date);
          const scheduledStatus = isScheduledOnDate(item, this.date);
          const isScheduledToday = scheduledStatus === 'scheduled';
          const isRestToday = scheduledStatus === 'rest';
          // Off-schedule dose taken when the date's status is 'rest' but
          // we have a takenAt — or the dose entry itself has offSchedule.
          const doseEntry = Array.isArray(item.doses)
            ? item.doses.find(d => d.scheduledDate === this.date) : null;
          const isOffScheduleTaken = !!(taken && (isRestToday || doseEntry?.offSchedule));
          return html`
            <div class="item">
              ${this._renderRing(cp, colour)}
              <div class="info">
                <div class="name">${item.short_name || item.name}</div>
                ${isScheduledToday ? html`<div class="dose">${this._doseLabel(item)}${item.dose_units ? ' · ' + item.dose_units + 'u' : ''}</div>` : ''}
                <div class="cycle-text">
                  ${cp.type === 'off' ? 'Off cycle' : 'Cycle'} · Day ${cp.day}${cp.total ? ' of ' + cp.total : ''}
                </div>
                ${this._renderWeekDots(item, colour)}
              </div>
              <div class="right">
                ${chip ? html`<span class="chip ${chip.cls}">${chip.text}</span>` : ''}
                ${isScheduledToday ? html`
                  <div
                    class="checkbox ${taken ? 'checked' : ''} ${this._canWrite ? '' : 'disabled'}"
                    @click=${() => this._toggleDose(item)}
                    role="button"
                    aria-label="mark ${item.name} taken"
                  ></div>
                ` : isRestToday ? html`
                  <div
                    class="checkbox off-schedule ${isOffScheduleTaken ? 'checked' : ''} ${this._canWrite ? '' : 'disabled'}"
                    @click=${() => this._toggleDose(item, { offSchedule: true })}
                    role="button"
                    aria-label="log extra ${item.name} dose (off-schedule)"
                    title="Log an off-schedule dose"
                  ></div>
                ` : ''}
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }
}
customElements.define('eh-schedule-card', EhScheduleCard);
registerRenderer('schedule-card', 'eh-schedule-card');
