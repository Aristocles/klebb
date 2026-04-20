// public/js/components/eh-calendar-view.js
// v2 Calendar view. Month grid. Each day cell shows icons from cards
// whose meta.calendar.enabled is true AND which have data on that date.
//
// Data fetching strategy: on mount, fetch every card from /api/manifests
// whose meta.calendar.enabled===true. Extract the dates that card has
// data for (heuristic per data shape). Build a map: date -> [{id, marker, tooltip}].
//
// Navigation: < [Month Year] > with prev/next arrows and a "This month" shortcut.
// Click a day -> navigate to /day/YYYY-MM-DD.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

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
        const marker = cal.marker || entry.meta.emoji || '•';
        const dates = this._extractDates(entry.data);
        for (const date of dates) {
          if (!markers.has(date)) markers.set(date, []);
          const existing = markers.get(date);
          existing.push({
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

  // Try to find which dates a data block has entries for.
  // Handles: arrays of {date}, objects keyed by date, items with doses[].
  _extractDates(data) {
    const dates = new Set();
    if (!data) return dates;
    if (Array.isArray(data)) {
      for (const e of data) {
        if (e && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) dates.add(e.date);
      }
    } else if (typeof data === 'object') {
      // Object keyed by date (mood, notes)
      for (const k of Object.keys(data)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) dates.add(k);
      }
      // Items with doses[] (peptides)
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          if (Array.isArray(item.doses)) {
            for (const d of item.doses) {
              if (d.takenAt && typeof d.scheduledDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.scheduledDate)) {
                dates.add(d.scheduledDate);
              }
            }
          }
        }
      }
    }
    return dates;
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
