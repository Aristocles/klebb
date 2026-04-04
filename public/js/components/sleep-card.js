import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today, daysAgo, formatHours } from '../api.js';

class SleepCard extends LitElement {
  static properties = {
    date: { type: String },
    _data: { state: true },
    _weekData: { state: true },
    _mood: { state: true },
    _expanded: { state: true },
    loading: { state: true },
  };

  static styles = css`
    :host { display: block; min-width: 0; }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      transition: background 0.3s;
      cursor: pointer;
    }

    .card:hover { border-color: var(--border-hover); }

    .card.quality-good { background: rgba(68, 255, 136, 0.1); }
    .card.quality-ok { background: rgba(255, 170, 0, 0.1); }
    .card.quality-bad { background: rgba(255, 68, 68, 0.1); }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin: 0 0 8px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .chevron {
      font-size: 12px;
      transition: transform 0.2s;
    }

    .chevron.open { transform: rotate(180deg); }

    .total {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0 0 12px 0;
    }

    .bar-container {
      display: flex;
      height: 10px;
      border-radius: 5px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .bar-segment { height: 100%; transition: width 0.4s ease; }

    .times { font-size: 13px; color: var(--text-secondary); margin-bottom: 8px; }
    .stages { font-size: 12px; color: var(--text-secondary); }

    .loading-text { color: var(--text-secondary); font-size: 14px; }

    /* Expanded view */
    .expanded {
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .week-chart {
      display: flex;
      align-items: flex-end;
      gap: 6px;
      height: 80px;
      margin-bottom: 12px;
    }

    .day-bar {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      height: 100%;
      justify-content: flex-end;
    }

    .bar-fill-sleep {
      width: 100%;
      border-radius: 4px 4px 0 0;
      min-height: 2px;
      transition: height 0.3s ease;
    }

    .bar-label {
      font-size: 10px;
      color: var(--text-muted);
    }

    .bar-hours {
      font-size: 9px;
      color: var(--text-secondary);
    }

    .bar-fill-sleep.good { background: var(--success); }
    .bar-fill-sleep.ok { background: var(--warning); }
    .bar-fill-sleep.bad { background: var(--danger); }
    .bar-fill-sleep.none { background: var(--border); }

    .week-stats {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-top: 10px;
    }

    .week-stat {
      text-align: center;
      flex: 1;
    }

    .week-stat-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .week-stat-value {
      font-size: 16px;
      font-weight: 700;
      color: #ccc;
    }

    .week-stat-value.good { color: var(--success); }
    .week-stat-value.ok { color: var(--warning); }
    .week-stat-value.bad { color: var(--danger); }

    @media (max-width: 480px) {
      .total { font-size: 26px; }
    }

    .mood-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(0,0,0,0.04);
    }

    .mood-emoji { font-size: 20px; }

    .mood-label {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .mood-notes {
      font-size: 11px;
      color: var(--text-muted);
      font-style: italic;
      margin-left: auto;
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  constructor() {
    super();
    this.date = today();
    this._data = null;
    this._weekData = null;
    this._mood = null;
    this._expanded = false;
    this.loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
    // Listen for mood updates from the checkin modal
    this._moodHandler = () => this._fetchMood();
    window.addEventListener('mood-updated', this._moodHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('mood-updated', this._moodHandler);
  }

  updated(changed) {
    if (changed.has('date') && !changed.has('loading')) {
      this._fetchData();
    }
  }

  async _fetchData() {
    this.loading = true;
    try {
      this._data = await api.sleep(this.date) || null;
    } catch { this._data = null; }
    await this._fetchMood();
    this.loading = false;
  }

  async _fetchMood() {
    try {
      this._mood = await api.mood(this.date) || null;
    } catch { this._mood = null; }
  }

  async _loadWeekData() {
    if (this._weekData) return;
    const end = today();
    const start = daysAgo(6);
    try {
      this._weekData = await api.sleepRange(start, end) || {};
    } catch { this._weekData = {}; }
  }

  _qualityClass(total) {
    if (total >= 7.5) return 'quality-good';
    if (total >= 6) return 'quality-ok';
    return 'quality-bad';
  }

  _barQuality(total) {
    if (total >= 7.5) return 'good';
    if (total >= 6) return 'ok';
    if (total > 0) return 'bad';
    return 'none';
  }

  _formatTime(dateStr) {
    if (!dateStr) return '--:--';
    let normalized = dateStr
      .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2')
      .replace(/\s*([+-])(\d{2})(\d{2})$/, '$1$2:$3');
    let d = new Date(normalized);
    if (isNaN(d.getTime())) d = new Date(dateStr);
    if (isNaN(d.getTime())) return '--:--';
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }

  _getMoodDisplay(value) {
    const moods = {
      1: { emoji: '\u{1F629}', label: 'Awful' },
      2: { emoji: '\u{1F634}', label: 'Tired' },
      3: { emoji: '\u{1F610}', label: 'Meh' },
      4: { emoji: '\u{1F642}', label: 'Good' },
      5: { emoji: '\u{1F604}', label: 'Great' },
    };
    return moods[value] || null;
  }

  _renderMood() {
    if (!this._mood || !this._mood.mood) return '';
    const display = this._getMoodDisplay(this._mood.mood);
    if (!display) return '';
    const wakeUps = this._mood.wakeUps;
    const hasWakeUps = wakeUps !== null && wakeUps !== undefined;
    const wakeColor = !hasWakeUps ? '' : wakeUps <= 1 ? 'var(--success)' : wakeUps <= 3 ? 'var(--warning)' : 'var(--danger)';
    return html`
      <div class="mood-row">
        <span class="mood-emoji">${display.emoji}</span>
        <span class="mood-label">Feeling ${display.label.toLowerCase()}</span>
        ${this._mood.notes ? html`<span class="mood-notes">${this._mood.notes}</span>` : ''}
      </div>
      ${hasWakeUps ? html`
        <div class="mood-row" style="border-top:none;padding-top:0;margin-top:2px;">
          <span class="mood-emoji" style="color:${wakeColor};font-weight:700;font-size:16px;">Z</span>
          <span class="mood-label">Woke up ${wakeUps} time${wakeUps !== 1 ? 's' : ''}</span>
        </div>
      ` : ''}
    `;
  }

  async _toggle() {
    this._expanded = !this._expanded;
    if (this._expanded) await this._loadWeekData();
  }

  _getWeekDays() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }));
    }
    return days;
  }

  _getDayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { weekday: 'short' }).slice(0, 2);
  }

  _getSleepTotal(dateStr) {
    if (!this._weekData || !this._weekData[dateStr]) return 0;
    const entries = this._weekData[dateStr];
    if (Array.isArray(entries) && entries.length > 0) return entries[0].totalSleep || 0;
    if (entries.totalSleep) return entries.totalSleep;
    return 0;
  }

  _renderExpanded() {
    if (!this._weekData) return html`<div class="expanded"><div class="loading-text">Loading...</div></div>`;

    const days = this._getWeekDays();
    const totals = days.map(d => this._getSleepTotal(d));
    const activeTotals = totals.filter(t => t > 0);
    const avgHours = activeTotals.length > 0 ? activeTotals.reduce((a, b) => a + b, 0) / activeTotals.length : 0;
    const avgClass = avgHours >= 7.5 ? 'good' : avgHours >= 6 ? 'ok' : 'bad';

    // Dynamic range: floor at 4h (or 1h below min), ceiling at max+0.5h
    // This makes differences much more visually pronounced
    const minSleep = activeTotals.length > 0 ? Math.min(...activeTotals) : 0;
    const maxSleep = activeTotals.length > 0 ? Math.max(...activeTotals) : 10;
    const chartFloor = Math.max(0, Math.min(4, minSleep - 1));
    const chartCeil = Math.max(maxSleep + 0.5, chartFloor + 4);

    // Bed/wake consistency
    const bedTimes = [];
    const wakeTimes = [];
    for (const d of days) {
      const entries = this._weekData[d];
      if (!entries) continue;
      const entry = Array.isArray(entries) ? entries[0] : entries;
      if (entry?.sleepStart) {
        const normalized = entry.sleepStart
          .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2')
          .replace(/\s*([+-])(\d{2})(\d{2})$/, '$1$2:$3');
        const dt = new Date(normalized);
        if (!isNaN(dt.getTime())) bedTimes.push(dt.getHours() + dt.getMinutes() / 60);
      }
      if (entry?.sleepEnd) {
        const normalized = entry.sleepEnd
          .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2')
          .replace(/\s*([+-])(\d{2})(\d{2})$/, '$1$2:$3');
        const dt = new Date(normalized);
        if (!isNaN(dt.getTime())) wakeTimes.push(dt.getHours() + dt.getMinutes() / 60);
      }
    }

    const formatAvgTime = (arr) => {
      if (arr.length === 0) return '--:--';
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const h = Math.floor(avg);
      const m = Math.round((avg - h) * 60);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    };

    return html`
      <div class="expanded">
        <div class="week-chart">
          ${days.map((d, i) => {
            const total = totals[i];
            const pct = total > 0 ? Math.min(((total - chartFloor) / (chartCeil - chartFloor)) * 100, 100) : 0;
            const quality = this._barQuality(total);
            return html`
              <div class="day-bar">
                ${total > 0 ? html`<span class="bar-hours">${total.toFixed(1)}</span>` : ''}
                <div class="bar-fill-sleep ${quality}" style="height:${pct}%"></div>
                <span class="bar-label">${this._getDayLabel(d)}</span>
              </div>
            `;
          })}
        </div>
        <div class="week-stats">
          <div class="week-stat">
            <div class="week-stat-label">Avg Sleep</div>
            <div class="week-stat-value ${avgClass}">${formatHours(avgHours)}</div>
          </div>
          <div class="week-stat">
            <div class="week-stat-label">Avg Bed</div>
            <div class="week-stat-value">${formatAvgTime(bedTimes)}</div>
          </div>
          <div class="week-stat">
            <div class="week-stat-label">Avg Wake</div>
            <div class="week-stat-value">${formatAvgTime(wakeTimes)}</div>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="card"><div class="title">Sleep</div><div class="loading-text">Loading...</div></div>`;
    }

    if (!this._data) {
      return html`<div class="card" @click=${this._toggle}><div class="title">Sleep <span class="chevron ${this._expanded ? 'open' : ''}">▼</span></div><div class="loading-text">No data</div>${this._expanded ? this._renderExpanded() : ''}</div>`;
    }

    const d = this._data;
    const total = d.totalSleep || 0;
    const core = d.core || 0, rem = d.rem || 0, deep = d.deep || 0, awake = d.awake || 0;
    const sleepTotal = core + rem + deep + awake;
    const corePct = sleepTotal > 0 ? (core / sleepTotal) * 100 : 0;
    const remPct = sleepTotal > 0 ? (rem / sleepTotal) * 100 : 0;
    const deepPct = sleepTotal > 0 ? (deep / sleepTotal) * 100 : 0;
    const awakePct = sleepTotal > 0 ? (awake / sleepTotal) * 100 : 0;

    return html`
      <div class="card ${this._qualityClass(total)}" @click=${this._toggle}>
        <div class="title">Sleep <span class="chevron ${this._expanded ? 'open' : ''}">▼</span></div>
        <div class="total">${formatHours(total)}</div>
        ${sleepTotal > 0 ? html`
          <div class="bar-container">
            <div class="bar-segment" style="width:${corePct}%;background:#6366f1"></div>
            <div class="bar-segment" style="width:${remPct}%;background:#a855f7"></div>
            <div class="bar-segment" style="width:${deepPct}%;background:#1e3a5f"></div>
            <div class="bar-segment" style="width:${awakePct}%;background:var(--danger)"></div>
          </div>
        ` : ''}
        <div class="times">${this._formatTime(d.sleepStart)} → ${this._formatTime(d.sleepEnd)}</div>
        ${sleepTotal > 0 ? html`
          <div class="stages">Core ${formatHours(core)} · REM ${formatHours(rem)} · Deep ${formatHours(deep)}</div>
        ` : html`
          <div class="stages">Stage breakdown not available</div>
        `}
        ${this._renderMood()}
        ${this._expanded ? this._renderExpanded() : ''}
      </div>
    `;
  }
}

customElements.define('sleep-card', SleepCard);
