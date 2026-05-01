// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-calendar-view.js
// v2 Calendar view. Month grid. Each day cell shows icons from cards
// whose meta.calendar.enabled is true AND which have data on that date.
//
// Data fetching strategy: on mount, fetch every card from /api/manifests
// whose meta.calendar.enabled===true. Extract that card's dated rows
// (heuristic per data shape), then resolve each day's marker per the
// card's meta.calendar.marker config (string, field-emoji, or
// trend-arrow). Build a map: date -> [{id, marker, tooltip}].
//
// Navigation: < [Month Year] > with prev/next arrows and a "This month" shortcut.
// Click a day -> navigate to /day/YYYY-MM-DD.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { extractDatedRows, resolveMarker } from '../lib/calendar-marker.esm.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function pad(n) { return String(n).padStart(2, '0'); }
function iso(date) { return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`; }
function todayStr() { return iso(new Date()); }

export class EhCalendarView extends LitElement {
  static properties = {
    _year: { state: true },
    _month: { state: true },           // 0-based
    _markers: { state: true },          // date -> [{id, marker, tooltip}]
    _loading: { state: true },
  };

  constructor() {
    super();
    const d = new Date();
    this._year = d.getFullYear();
    this._month = d.getMonth();
    this._markers = new Map();
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadMarkers();
  }

  async _loadMarkers() {
    this._loading = true;
    try {
      const r = await fetch('/api/manifests');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { entries } = await r.json();
      const calendarEntries = (entries || []).filter(e => e.meta?.calendar?.enabled);
      // Fetch data for each in parallel
      const fetched = await Promise.all(calendarEntries.map(async e => {
        try {
          const dr = await fetch(`/api/manifests/${encodeURIComponent(e.id)}/data`);
          if (!dr.ok) return null;
          const { data } = await dr.json();
          return { ...e, data };
        } catch { return null; }
      }));
      // Build the markers map
      const markers = new Map();
      for (const entry of fetched) {
        if (!entry) continue;
        const cal = entry.meta.calendar;
        const spec = cal.marker ?? entry.meta.emoji ?? '•';
        const fallback = entry.meta.emoji || '•';
        const dated = extractDatedRows(entry.data);
        // Sorted ascending — trend-arrow needs this to find the previous row.
        const sortedRows = Array.from(dated.values())
          .filter(r => r && r.date)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        for (const [date, row] of dated) {
          const marker = resolveMarker(spec, { date, row, sortedRows, fallback });
          if (!markers.has(date)) markers.set(date, []);
          markers.get(date).push({
            id: entry.id,
            marker,
            tooltip: `${entry.meta.label || entry.id}`,
          });
        }
      }
      this._markers = markers;
    } catch (e) {
      console.warn('[calendar] load failed', e);
    } finally {
      this._loading = false;
    }
  }

  _shiftMonth(delta) {
    let m = this._month + delta;
    let y = this._year;
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    this._month = m;
    this._year = y;
  }

  _goToToday() {
    const d = new Date();
    this._year = d.getFullYear();
    this._month = d.getMonth();
  }

  _navigateToDay(dateStr) {
    window.dispatchEvent(new CustomEvent('navigate', { detail: { path: `/day/${dateStr}` } }));
  }

  _buildGrid() {
    // Mon-first grid. First-of-month column = (weekday + 6) % 7 (so Mon=0, Sun=6).
    const firstDay = new Date(this._year, this._month, 1);
    const lastDay = new Date(this._year, this._month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const leadingEmpty = (firstDay.getDay() + 6) % 7;

    const cells = [];
    for (let i = 0; i < leadingEmpty; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(new Date(this._year, this._month, d));
    }
    // Trailing to round to a week
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }

  static styles = css`
    :host { display: block; }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .month-label {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-primary);
    }
    .nav-btns {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    button {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-primary);
      border-radius: 8px;
      cursor: pointer;
      padding: 6px 10px;
      font-size: 12px;
      font-family: inherit;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      min-height: 34px;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    .today-btn {
      background: var(--accent-bg, rgba(0,212,170,0.15));
      color: var(--accent);
      border-color: var(--accent);
    }
    .weekday-row {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
      margin-bottom: 4px;
    }
    .weekday {
      text-align: center;
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted, var(--text-secondary));
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 6px 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
    }
    .cell {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      min-height: 70px;
      padding: 6px 6px 4px;
      display: flex;
      flex-direction: column;
      cursor: pointer;
      transition: border-color 0.15s;
      position: relative;
    }
    .cell:hover { border-color: var(--accent); }
    .cell.empty { background: transparent; border-color: transparent; cursor: default; }
    .cell.empty:hover { border-color: transparent; }
    .cell.today {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .day-num {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .cell.today .day-num {
      color: var(--accent);
    }
    .markers {
      margin-top: 4px;
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      font-size: 12px;
      line-height: 1;
    }
    .more {
      font-size: 9px;
      color: var(--text-muted, var(--text-secondary));
      margin-top: auto;
    }
    .loading { padding: 40px; text-align: center; color: var(--text-muted, var(--text-secondary)); }

    @media (max-width: 480px) {
      .cell { min-height: 56px; padding: 4px; }
      .day-num { font-size: 11px; }
      .markers { font-size: 10px; }
    }
  `;

  render() {
    const today = todayStr();
    const cells = this._buildGrid();
    return html`
      <div class="header">
        <div class="nav-btns">
          <button @click=${() => this._shiftMonth(-1)} aria-label="previous month">‹</button>
          <button class="today-btn" @click=${this._goToToday}>Today</button>
          <button @click=${() => this._shiftMonth(1)} aria-label="next month">›</button>
        </div>
        <div class="month-label">${MONTH_NAMES[this._month]} ${this._year}</div>
        <div style="width:120px"></div>
      </div>
      <div class="weekday-row">
        ${DAY_NAMES.map(d => html`<div class="weekday">${d}</div>`)}
      </div>
      ${this._loading ? html`<div class="loading">Loading…</div>` : html`
        <div class="grid">
          ${cells.map(c => {
            if (!c) return html`<div class="cell empty"></div>`;
            const dateStr = iso(c);
            const markers = this._markers.get(dateStr) || [];
            const isToday = dateStr === today;
            // Cap at 3 icons + '+N' overflow
            const shown = markers.slice(0, 3);
            const overflow = markers.length - shown.length;
            return html`
              <div class="cell ${isToday ? 'today' : ''}" @click=${() => this._navigateToDay(dateStr)}>
                <div class="day-num">${c.getDate()}</div>
                <div class="markers">
                  ${shown.map(m => html`<span title="${m.tooltip}">${m.marker}</span>`)}
                  ${overflow > 0 ? html`<span class="more">+${overflow}</span>` : ''}
                </div>
              </div>
            `;
          })}
        </div>
      `}
    `;
  }
}
customElements.define('eh-calendar-view', EhCalendarView);
