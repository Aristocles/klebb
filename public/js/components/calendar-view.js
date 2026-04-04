import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today, getMonday, calculateIntensity } from '../api.js';
import './calendar-cell.js';
import './info-panel.js';

class CalendarView extends LitElement {
  static properties = {
    _currentMonth: { state: true },
    _config: { state: true },
    _sleepData: { state: true },
    _workoutData: { state: true },
    _infoDates: { state: true },
    _peptidesData: { state: true },
    _injectionLogData: { state: true },
    _moodData: { state: true },
    _loading: { state: true },
  };

  static styles = css`
    :host { display: block; }

    .header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      margin-bottom: 16px;
    }

    .month-label {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      min-width: 200px;
      text-align: center;
    }

    .nav-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 18px;
      padding: 6px 12px;
      cursor: pointer;
      transition: color 0.2s, border-color 0.2s;
    }

    .nav-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    .today-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 13px;
      padding: 6px 14px;
      cursor: pointer;
      transition: color 0.2s, border-color 0.2s;
    }

    .today-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    .dow-header {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
      margin-bottom: 4px;
    }

    .dow-label {
      text-align: center;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      padding: 4px 0;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
    }

    .loading-text {
      color: var(--text-secondary);
      font-size: 14px;
      text-align: center;
      padding: 40px 0;
    }

    @media (max-width: 600px) {
      .month-label {
        font-size: 16px;
        min-width: 140px;
      }

      .header {
        gap: 8px;
      }

      .nav-btn {
        padding: 4px 8px;
        font-size: 16px;
      }
    }
  `;

  constructor() {
    super();
    const todayStr = today();
    const d = new Date(todayStr + 'T00:00:00');
    this._currentMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    this._config = null;
    this._sleepData = {};
    this._workoutData = {};
    this._infoDates = new Set();
    this._peptidesData = null;
    this._injectionLogData = {};
    this._moodData = {};
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._init();
    this._swipeStartX = 0;
    this._swipeStartY = 0;
    this._boundTouchStart = (e) => { this._swipeStartX = e.changedTouches[0].screenX; this._swipeStartY = e.changedTouches[0].screenY; };
    this._boundTouchEnd = (e) => {
      const dx = e.changedTouches[0].screenX - this._swipeStartX;
      const dy = e.changedTouches[0].screenY - this._swipeStartY;
      if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx > 0) this._prevMonth();
        else this._nextMonth();
      }
    };
    this.addEventListener('touchstart', this._boundTouchStart, { passive: true });
    this.addEventListener('touchend', this._boundTouchEnd, { passive: true });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('touchstart', this._boundTouchStart);
    this.removeEventListener('touchend', this._boundTouchEnd);
  }

  async _init() {
    const [config, infoDates, peptidesData] = await Promise.all([
      api.config(),
      api.infoDates(),
      api.peptides(),
    ]);
    this._config = config;
    this._infoDates = new Set(Array.isArray(infoDates) ? infoDates : []);
    this._peptidesData = peptidesData;
    await this._fetchMonthData();
  }

  async _fetchMonthData() {
    this._loading = true;
    const { start, end } = this._getVisibleRange();

    const [sleepData, workoutData, injectionLogData, moodData] = await Promise.all([
      api.sleepRange(start, end),
      api.workoutsRange(start, end),
      api.injectionLogRange(start, end),
      api.moodRange(start, end),
    ]);

    this._sleepData = sleepData || {};
    this._workoutData = workoutData || {};
    this._injectionLogData = injectionLogData || {};
    this._moodData = moodData || {};
    this._loading = false;
  }

  _getVisibleRange() {
    const year = this._currentMonth.getFullYear();
    const month = this._currentMonth.getMonth();

    // First day of month
    const firstOfMonth = new Date(year, month, 1);
    // Day of week (0=Sun), we want Mon=0
    let dow = firstOfMonth.getDay();
    dow = dow === 0 ? 6 : dow - 1; // convert to Mon-based index
    // Start of visible grid
    const gridStart = new Date(year, month, 1 - dow);

    // Last day of month
    const lastOfMonth = new Date(year, month + 1, 0);
    let dowLast = lastOfMonth.getDay();
    dowLast = dowLast === 0 ? 6 : dowLast - 1;
    // End of visible grid (fill to Sunday)
    const gridEnd = new Date(year, month + 1, 0 + (6 - dowLast));

    const start = gridStart.toLocaleDateString('en-CA');
    const end = gridEnd.toLocaleDateString('en-CA');
    return { start, end, gridStart, gridEnd };
  }

  _getGridDates() {
    const { gridStart, gridEnd } = this._getVisibleRange();
    const dates = [];
    const d = new Date(gridStart);
    while (d <= gridEnd) {
      dates.push(d.toLocaleDateString('en-CA'));
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }

  _prevMonth() {
    const y = this._currentMonth.getFullYear();
    const m = this._currentMonth.getMonth();
    this._currentMonth = new Date(y, m - 1, 1);
    this._fetchMonthData();
  }

  _nextMonth() {
    const y = this._currentMonth.getFullYear();
    const m = this._currentMonth.getMonth();
    this._currentMonth = new Date(y, m + 1, 1);
    this._fetchMonthData();
  }

  _goToday() {
    const todayStr = today();
    const d = new Date(todayStr + 'T00:00:00');
    this._currentMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    this._fetchMonthData();
  }

  _getMonthLabel() {
    return this._currentMonth.toLocaleDateString('en-AU', {
      month: 'long',
      year: 'numeric',
    });
  }

  _handleDayClick(e) {
    const { date } = e.detail;
    window.dispatchEvent(new CustomEvent('navigate', {
      detail: { path: `/day/${date}` },
    }));
  }

  _getSleepForDate(dateStr) {
    const entries = this._sleepData[dateStr];
    if (Array.isArray(entries) && entries.length > 0) return entries[0];
    return null;
  }

  _getWorkoutsForDate(dateStr) {
    const entries = this._workoutData[dateStr];
    if (Array.isArray(entries)) return entries;
    return [];
  }

  _getPeptidesForDate(dateStr) {
    const result = { active: false, names: [] };
    if (!this._peptidesData?.peptides) return result;

    const d = new Date(dateStr + 'T00:00:00');
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = dayNames[d.getDay()];

    for (const pep of this._peptidesData.peptides) {
      if (!pep.cycles || pep.cycles.length === 0) continue;

      for (const cycle of pep.cycles) {
        if (!cycle.start_date || !cycle.end_date) continue;
        if (dateStr < cycle.start_date || dateStr > cycle.end_date) continue;

        const sched = pep.schedule;
        if (!sched) continue;

        let isActive = false;
        if (sched.type === 'daily_straight') {
          isActive = true;
        } else if (sched.type === 'on_off') {
          isActive = sched.on_days.includes(dayName);
        } else if (sched.type === 'phased') {
          const loadEnd = cycle.phases?.loading_end;
          if (loadEnd && dateStr <= loadEnd) {
            isActive = sched.loading.days.includes(dayName);
          } else {
            isActive = sched.maintenance.days.includes(dayName);
          }
        }

        if (isActive) {
          result.active = true;
          result.names.push(pep.short_name || pep.name);
        }
      }
    }
    return result;
  }

  _getInjectionStatus(dateStr) {
    const log = this._injectionLogData[dateStr] || {};
    const peptidesTaken = Object.keys(log).some(k => k !== 'Mounjaro');
    const mounjaroTaken = !!log['Mounjaro'];
    return { peptidesTaken, mounjaroTaken };
  }

  _getMoodEmoji(dateStr) {
    const entry = this._moodData[dateStr];
    if (!entry || !entry.mood) return '';
    const emojis = { 1: '\u{1F629}', 2: '\u{1F634}', 3: '\u{1F610}', 4: '\u{1F642}', 5: '\u{1F604}' };
    return emojis[entry.mood] || '';
  }

  _getWakeUps(dateStr) {
    const entry = this._moodData[dateStr];
    if (!entry || entry.wakeUps === null || entry.wakeUps === undefined) return null;
    return entry.wakeUps;
  }

  render() {
    const todayStr = today();
    const currentMonth = this._currentMonth.getMonth();
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    return html`
      <div class="header">
        <button class="nav-btn" @click=${this._prevMonth}>\u{25C0}</button>
        <button class="today-btn" @click=${this._goToday}>Today</button>
        <span class="month-label">${this._getMonthLabel()}</span>
        <button class="nav-btn" @click=${this._nextMonth}>\u{25B6}</button>
      </div>

      <div class="dow-header">
        ${dayNames.map(d => html`<div class="dow-label">${d}</div>`)}
      </div>

      ${this._loading
        ? html`<div class="loading-text">Loading...</div>`
        : html`
          <div class="grid" @day-click=${this._handleDayClick}>
            ${this._getGridDates().map(dateStr => {
              const cellDate = new Date(dateStr + 'T00:00:00');
              const isCurrentMonth = cellDate.getMonth() === currentMonth;
              const isToday = dateStr === todayStr;
              const sleepData = this._getSleepForDate(dateStr);
              const workouts = this._getWorkoutsForDate(dateStr);
              const hasInfo = this._infoDates.has(dateStr);
              const pepInfo = this._getPeptidesForDate(dateStr);
              const injStatus = this._getInjectionStatus(dateStr);
              const moodEmoji = this._getMoodEmoji(dateStr);
              const wakeUps = this._getWakeUps(dateStr);

              return html`
                <calendar-cell
                  .date=${dateStr}
                  .sleepData=${sleepData}
                  .workouts=${workouts}
                  .hasInfo=${hasInfo}
                  .hasPeptides=${pepInfo.active}
                  .peptideNames=${pepInfo.names}
                  .peptidesTaken=${injStatus.peptidesTaken}
                  .mounjaroTaken=${injStatus.mounjaroTaken}
                  .moodEmoji=${moodEmoji}
                  .wakeUps=${wakeUps}
                  .isToday=${isToday}
                  .isCurrentMonth=${isCurrentMonth}
                  .config=${this._config}
                ></calendar-cell>
              `;
            })}
          </div>
        `
      }
    `;
  }
}

customElements.define('calendar-view', CalendarView);
