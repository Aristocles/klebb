import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today, daysAgo, getMonday, getSunday, calculateIntensity } from '../api.js';

class WorkoutCard extends LitElement {
  static properties = {
    date: { type: String },
    config: { type: Object },
    _workouts: { state: true },
    _weekWorkouts: { state: true },
    _lastWeekCount: { state: true },
    _expanded: { state: true },
    loading: { state: true },
  };

  static styles = css`
    :host { display: block; min-width: 0; }

    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px 20px;
      cursor: pointer;
    }

    .card:hover { border-color: #cbd5e1; }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #64748b;
      margin: 0 0 8px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .chevron { font-size: 12px; transition: transform 0.2s; }
    .chevron.open { transform: rotate(180deg); }

    .rest-day { font-size: 18px; color: #94a3b8; display: flex; align-items: center; gap: 8px; }
    .rest-emoji { font-size: 28px; }

    .intensity-banner { text-align: center; font-size: 36px; margin-bottom: 12px; }

    .workout-list { display: flex; flex-direction: column; gap: 10px; }

    .workout-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid #e2e8f0;
    }

    .workout-row:last-child { border-bottom: none; padding-bottom: 0; }
    .workout-icon { font-size: 20px; flex-shrink: 0; }

    .workout-name {
      flex: 1;
      font-size: 14px;
      font-weight: 500;
      color: #1e293b;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .workout-duration { font-size: 13px; font-weight: 600; color: #0ea5e9; flex-shrink: 0; }
    .workout-hr { font-size: 12px; color: #ff6b6b; flex-shrink: 0; }

    .loading-text { color: #64748b; font-size: 14px; }

    .summary {
      font-size: 12px;
      color: #64748b;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #e2e8f0;
    }

    /* Expanded */
    .expanded {
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid #e2e8f0;
    }

    .week-dots {
      display: flex;
      gap: 6px;
      justify-content: center;
      margin-bottom: 14px;
    }

    .week-dot {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
    }

    .week-dot.active { background: rgba(14, 165, 233, 0.15); color: #0ea5e9; border: 1px solid #0ea5e9; }
    .week-dot.rest { background: #ffffff; color: #444466; border: 1px solid #e2e8f0; }
    .week-dot.today-ring { box-shadow: 0 0 0 2px #f5f7fa, 0 0 0 3px #0ea5e9; }

    .week-workout-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .week-workout-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .ww-date { color: #94a3b8; font-size: 11px; width: 32px; flex-shrink: 0; }
    .ww-name { color: #ccc; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ww-dur { color: #0ea5e9; font-weight: 600; flex-shrink: 0; }
    .ww-hr { color: #ff6b6b; font-size: 11px; flex-shrink: 0; }

    .comparison {
      margin-top: 12px;
      font-size: 12px;
      color: #64748b;
      text-align: center;
    }
    .comparison strong { color: #ccc; }
    .comparison .up { color: #22c55e; }
    .comparison .down { color: #ff6b6b; }
    .comparison .same { color: #f59e0b; }
  `;

  constructor() {
    super();
    this.date = today();
    this.config = null;
    this._workouts = null;
    this._weekWorkouts = null;
    this._lastWeekCount = null;
    this._expanded = false;
    this.loading = true;
  }

  connectedCallback() { super.connectedCallback(); this._fetchData(); }

  updated(changed) {
    if (changed.has('date') && !changed.has('loading')) this._fetchData();
  }

  async _fetchData() {
    this.loading = true;
    try { this._workouts = await api.workouts(this.date); if (!Array.isArray(this._workouts)) this._workouts = []; }
    catch { this._workouts = []; }
    this.loading = false;
  }

  async _loadWeekData() {
    if (this._weekWorkouts) return;
    const monday = getMonday(today());
    const sunday = getSunday(monday);
    try {
      this._weekWorkouts = await api.workoutsRange(monday, sunday) || {};
      // Last week
      const lastMon = new Date(monday + 'T00:00:00');
      lastMon.setDate(lastMon.getDate() - 7);
      const lastMonStr = lastMon.toLocaleDateString('en-CA');
      const lastSun = new Date(lastMon);
      lastSun.setDate(lastMon.getDate() + 6);
      const lastSunStr = lastSun.toLocaleDateString('en-CA');
      const lastWeek = await api.workoutsRange(lastMonStr, lastSunStr) || {};
      this._lastWeekCount = Object.values(lastWeek).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
    } catch {
      this._weekWorkouts = {};
      this._lastWeekCount = 0;
    }
  }

  _getIntensity() {
    if (!this.config || !this._workouts || this._workouts.length === 0) return null;
    return calculateIntensity(this._workouts, this.config);
  }

  _totalMinutes() { return (this._workouts || []).reduce((s, w) => s + (w.durationMin || 0), 0); }

  async _toggle() {
    this._expanded = !this._expanded;
    if (this._expanded) await this._loadWeekData();
  }

  _workoutTypeIcon(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('running') || n.includes('run')) return '🏃';
    if (n.includes('cycling') || n.includes('bike')) return '🚴';
    if (n.includes('swimming') || n.includes('swim')) return '🏊';
    if (n.includes('walking') || n.includes('walk')) return '🚶';
    if (n.includes('yoga')) return '🧘';
    if (n.includes('hiit') || n.includes('interval')) return '⚡';
    return '🏋️';
  }

  _renderExpanded() {
    if (!this._weekWorkouts) return html`<div class="expanded"><div class="loading-text">Loading...</div></div>`;

    const monday = getMonday(today());
    const todayStr = today();
    const dayLabels = ['M','T','W','T','F','S','S'];
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday + 'T00:00:00');
      d.setDate(d.getDate() + i);
      weekDays.push(d.toLocaleDateString('en-CA'));
    }

    const thisWeekCount = Object.values(this._weekWorkouts).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);

    // Flatten all workouts for the list
    const allWorkouts = [];
    for (const [date, ws] of Object.entries(this._weekWorkouts)) {
      if (!Array.isArray(ws)) continue;
      for (const w of ws) allWorkouts.push({ ...w, date });
    }
    allWorkouts.sort((a, b) => a.date.localeCompare(b.date));

    let compClass = 'same', compText = 'Same as last week';
    if (this._lastWeekCount != null) {
      const diff = thisWeekCount - this._lastWeekCount;
      if (diff > 0) { compClass = 'up'; compText = `${diff} more than last week`; }
      else if (diff < 0) { compClass = 'down'; compText = `${Math.abs(diff)} fewer than last week`; }
    }

    return html`
      <div class="expanded">
        <div class="week-dots">
          ${weekDays.map((d, i) => {
            const hasWorkout = Array.isArray(this._weekWorkouts[d]) && this._weekWorkouts[d].length > 0;
            const isToday = d === todayStr;
            return html`<span class="week-dot ${hasWorkout ? 'active' : 'rest'} ${isToday ? 'today-ring' : ''}">${dayLabels[i]}</span>`;
          })}
        </div>
        ${allWorkouts.length > 0 ? html`
          <div class="week-workout-list">
            ${allWorkouts.map(w => {
              const dayLabel = new Date(w.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' }).slice(0, 3);
              return html`
                <div class="week-workout-item">
                  <span class="ww-date">${dayLabel}</span>
                  <span class="ww-name">${w.name}</span>
                  <span class="ww-dur">${w.durationMin}m</span>
                  ${w.avgHeartRate ? html`<span class="ww-hr">${Math.round(w.avgHeartRate)}bpm</span>` : ''}
                </div>
              `;
            })}
          </div>
        ` : ''}
        <div class="comparison">
          <strong>${thisWeekCount}</strong> workouts this week — <span class="${compClass}">${compText}</span>
        </div>
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="card"><div class="title">Workouts</div><div class="loading-text">Loading...</div></div>`;
    }

    if (!this._workouts || this._workouts.length === 0) {
      return html`
        <div class="card" @click=${this._toggle}>
          <div class="title">Workouts <span class="chevron ${this._expanded ? 'open' : ''}">▼</span></div>
          <div class="rest-day"><span class="rest-emoji">🧘</span><span>Rest day</span></div>
          ${this._expanded ? this._renderExpanded() : ''}
        </div>
      `;
    }

    const intensity = this._getIntensity();
    const totalMin = this._totalMinutes();

    return html`
      <div class="card" @click=${this._toggle}>
        <div class="title">Workouts <span class="chevron ${this._expanded ? 'open' : ''}">▼</span></div>
        ${this._workouts.length > 1 && intensity ? html`<div class="intensity-banner">${intensity}</div>` : ''}
        <div class="workout-list">
          ${this._workouts.map(w => html`
            <div class="workout-row">
              <span class="workout-icon">${this._workouts.length === 1 && intensity ? intensity : this._workoutTypeIcon(w.name)}</span>
              <span class="workout-name">${w.name}</span>
              <span class="workout-duration">${w.durationMin}m</span>
              ${w.avgHeartRate ? html`<span class="workout-hr">${Math.round(w.avgHeartRate)} bpm</span>` : ''}
            </div>
          `)}
        </div>
        ${this._workouts.length > 1 ? html`<div class="summary">Total: ${totalMin}m across ${this._workouts.length} workouts</div>` : ''}
        ${this._expanded ? this._renderExpanded() : ''}
      </div>
    `;
  }
}

customElements.define('workout-card', WorkoutCard);
