import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today, daysAgo } from '../api.js';

class ActivityCard extends LitElement {
  static properties = {
    date: { type: String },
    _data: { state: true },
    _weekData: { state: true },
    _expanded: { state: true },
    loading: { state: true },
  };

  static styles = css`
    :host { display: block; min-width: 0; }

    .card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 16px 20px;
      cursor: pointer;
    }

    .card:hover { border-color: #3a3a5a; }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #8888aa;
      margin: 0 0 12px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .chevron {
      font-size: 12px;
      transition: transform 0.2s;
    }
    .chevron.open { transform: rotate(180deg); }

    .stats {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    .stat { flex: 1; text-align: center; }

    .stat-label {
      font-size: 11px;
      color: #8888aa;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .stat-value { font-size: 22px; font-weight: 700; }
    .stat-unit { font-size: 13px; font-weight: 400; opacity: 0.7; }

    .steps { color: #00d4aa; }
    .distance { color: #ffaa00; }
    .energy { color: #6366f1; }

    .loading-text { color: #8888aa; font-size: 14px; }

    /* Expanded */
    .expanded {
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid #2a2a4a;
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

    .bar-fill-steps {
      width: 100%;
      border-radius: 4px 4px 0 0;
      background: #00d4aa;
      min-height: 2px;
      transition: height 0.3s;
    }

    .bar-fill-steps.empty { background: #2a2a4a; }

    .bar-label { font-size: 10px; color: #666688; }
    .bar-count { font-size: 9px; color: #aaaacc; }

    .week-stats {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .week-stat { text-align: center; flex: 1; }

    .week-stat-label {
      font-size: 10px;
      color: #666688;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .week-stat-value {
      font-size: 16px;
      font-weight: 700;
      color: #ccc;
    }

    .best-day {
      margin-top: 10px;
      font-size: 12px;
      color: #8888aa;
      text-align: center;
    }

    .best-day strong { color: #00d4aa; }

    @media (max-width: 480px) {
      .stat-value { font-size: 18px; }
      .stat-label { font-size: 10px; }
    }
  `;

  constructor() {
    super();
    this.date = today();
    this._data = null;
    this._weekData = null;
    this._expanded = false;
    this.loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  updated(changed) {
    if (changed.has('date') && !changed.has('loading')) this._fetchData();
  }

  async _fetchData() {
    this.loading = true;
    try { this._data = await api.activity(this.date); } catch { this._data = null; }
    this.loading = false;
  }

  async _loadWeekData() {
    if (this._weekData) return;
    try { this._weekData = await api.activityRange(daysAgo(6), today()) || {}; } catch { this._weekData = {}; }
  }

  _formatNumber(n) { return n != null ? n.toLocaleString() : '0'; }

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
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' }).slice(0, 2);
  }

  _getSteps(dateStr) {
    const entry = this._weekData?.[dateStr];
    return Math.round(entry?.step_count?.total || 0);
  }

  _renderExpanded() {
    if (!this._weekData) return html`<div class="expanded"><div class="loading-text">Loading...</div></div>`;

    const days = this._getWeekDays();
    const stepsList = days.map(d => this._getSteps(d));
    const maxSteps = Math.max(...stepsList, 1);
    const nonZero = stepsList.filter(s => s > 0);
    const avgSteps = nonZero.length > 0 ? Math.round(nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
    const totalSteps = stepsList.reduce((a, b) => a + b, 0);

    const bestIdx = stepsList.indexOf(Math.max(...stepsList));
    const bestDay = days[bestIdx];
    const bestLabel = new Date(bestDay + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long' });

    return html`
      <div class="expanded">
        <div class="week-chart">
          ${days.map((d, i) => {
            const steps = stepsList[i];
            const pct = Math.min((steps / maxSteps) * 100, 100);
            return html`
              <div class="day-bar">
                ${steps > 0 ? html`<span class="bar-count">${(steps / 1000).toFixed(1)}k</span>` : ''}
                <div class="bar-fill-steps ${steps === 0 ? 'empty' : ''}" style="height:${Math.max(pct, 3)}%"></div>
                <span class="bar-label">${this._getDayLabel(d)}</span>
              </div>
            `;
          })}
        </div>
        <div class="week-stats">
          <div class="week-stat">
            <div class="week-stat-label">Daily Avg</div>
            <div class="week-stat-value">${this._formatNumber(avgSteps)}</div>
          </div>
          <div class="week-stat">
            <div class="week-stat-label">Week Total</div>
            <div class="week-stat-value">${this._formatNumber(totalSteps)}</div>
          </div>
        </div>
        ${stepsList[bestIdx] > 0 ? html`
          <div class="best-day"><strong>${bestLabel}</strong> was your most active day: ${this._formatNumber(stepsList[bestIdx])} steps</div>
        ` : ''}
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="card"><div class="title">Activity</div><div class="loading-text">Loading...</div></div>`;
    }

    if (!this._data) {
      return html`<div class="card" @click=${this._toggle}><div class="title">Activity <span class="chevron ${this._expanded ? 'open' : ''}">▼</span></div><div class="loading-text">No data</div>${this._expanded ? this._renderExpanded() : ''}</div>`;
    }

    const steps = Math.round(this._data.step_count?.total || 0);
    const distKm = this._data.walking_running_distance?.total || 0;
    const energyKj = this._data.active_energy?.total || 0;
    const energyKcal = Math.round(energyKj / 4.184);

    return html`
      <div class="card" @click=${this._toggle}>
        <div class="title">Activity <span class="chevron ${this._expanded ? 'open' : ''}">▼</span></div>
        <div class="stats">
          <div class="stat">
            <div class="stat-label">Steps</div>
            <div class="stat-value steps">${this._formatNumber(steps)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Distance</div>
            <div class="stat-value distance">${distKm.toFixed(1)}<span class="stat-unit"> km</span></div>
          </div>
          <div class="stat">
            <div class="stat-label">Energy</div>
            <div class="stat-value energy">${this._formatNumber(energyKcal)}<span class="stat-unit"> kcal</span></div>
          </div>
        </div>
        ${this._expanded ? this._renderExpanded() : ''}
      </div>
    `;
  }
}

customElements.define('activity-card', ActivityCard);
