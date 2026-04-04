import { LitElement, html, css } from 'https://esm.sh/lit@3';

class CalendarCell extends LitElement {
  static properties = {
    date: { type: String },
    sleepData: { type: Object },
    workouts: { type: Array },
    hasInfo: { type: Boolean },
    hasPeptides: { type: Boolean },
    peptideNames: { type: Array },
    peptidesTaken: { type: Boolean },
    mounjaroTaken: { type: Boolean },
    moodEmoji: { type: String },
    wakeUps: { type: Number },
    isToday: { type: Boolean },
    isCurrentMonth: { type: Boolean },
    config: { type: Object },
  };

  static styles = css`
    :host { display: block; }

    .cal-cell {
      min-height: 80px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 6px 8px;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
      box-sizing: border-box;
    }

    .cal-cell:hover {
      border-color: #94a3b8;
      background: rgba(255, 255, 255, 0.03);
    }

    .cal-cell.today {
      border-color: #0ea5e9;
    }

    .cal-cell.other-month {
      opacity: 0.4;
    }

    .cal-cell.quality-good { background: rgba(68, 255, 136, 0.1); }
    .cal-cell.quality-ok { background: rgba(255, 170, 0, 0.1); }
    .cal-cell.quality-bad { background: rgba(255, 68, 68, 0.1); }

    .date-number {
      font-size: 13px;
      color: #64748b;
      margin-bottom: 4px;
    }

    .date-number.bold {
      font-weight: 700;
      color: #1e293b;
    }

    .icons {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      font-size: 14px;
    }

    @media (max-width: 600px) {
      .cal-cell {
        min-height: 50px;
        padding: 4px 5px;
      }

      .date-number {
        font-size: 11px;
      }

      .icons {
        font-size: 11px;
      }
    }
  `;

  constructor() {
    super();
    this.date = '';
    this.sleepData = null;
    this.workouts = [];
    this.hasInfo = false;
    this.hasPeptides = false;
    this.peptideNames = [];
    this.peptidesTaken = false;
    this.mounjaroTaken = false;
    this.moodEmoji = '';
    this.wakeUps = null;
    this.isToday = false;
    this.isCurrentMonth = true;
    this.config = null;
  }

  _getSleepQualityClass() {
    if (!this.sleepData) return '';
    const total = this.sleepData.totalSleep || 0;
    const thresholds = this.config?.sleep?.quality_thresholds;
    const good = thresholds?.good ?? 7.5;
    const okay = thresholds?.okay ?? 6;
    if (total >= good) return 'quality-good';
    if (total >= okay) return 'quality-ok';
    return 'quality-bad';
  }

  _getWorkoutIcon() {
    if (!this.workouts || this.workouts.length === 0 || !this.config) return null;
    const totalMinutes = this.workouts.reduce((s, w) => s + (w.durationMin || 0), 0);
    const maxHR = Math.max(...this.workouts.map(w => w.avgHeartRate || 0));
    const beastMinutes = this.config.workout_intensity?.beast_above_minutes ?? 30;
    const moderateMinutes = this.config.workout_intensity?.moderate_max_minutes ?? 30;
    if (totalMinutes >= beastMinutes || maxHR > 140) return '\u{1F30B}';
    if (totalMinutes >= moderateMinutes || maxHR > 110) return '\u{1F525}';
    if (totalMinutes > 0) return '\u{1F9CA}';
    return null;
  }

  _isMounjaroDay() {
    if (!this.date || !this.config?.mounjaro?.day) return false;
    const d = new Date(this.date + 'T00:00:00');
    const dayOfWeek = d.getDay();
    const configDay = this.config.mounjaro.day;
    if (typeof configDay === 'number') return dayOfWeek === configDay;
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return dayNames[dayOfWeek] === configDay.toLowerCase();
  }

  _getDayNumber() {
    if (!this.date) return '';
    const d = new Date(this.date + 'T00:00:00');
    return d.getDate();
  }

  _handleClick() {
    this.dispatchEvent(new CustomEvent('day-click', {
      detail: { date: this.date },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    const qualityClass = this._getSleepQualityClass();
    const workoutIcon = this._getWorkoutIcon();

    const classes = [
      'cal-cell',
      qualityClass,
      this.isToday ? 'today' : '',
      !this.isCurrentMonth ? 'other-month' : '',
    ].filter(Boolean).join(' ');

    return html`
      <div class="${classes}" @click=${this._handleClick}>
        <div class="date-number ${this.isToday ? 'bold' : ''}">
          ${this._getDayNumber()}
        </div>
        <div class="icons">
          ${workoutIcon ? html`<span>${workoutIcon}</span>` : ''}
          ${this.hasInfo ? html`<span>\u{2139}\u{FE0F}</span>` : ''}
          ${this.peptidesTaken ? html`<span title="${this.peptideNames.join(', ')}">\u{1F9EA}</span>` : ''}
          ${this.mounjaroTaken ? html`<span>\u{1F489}</span>` : ''}
          ${this.moodEmoji ? html`<span>${this.moodEmoji}</span>` : ''}
          ${this.wakeUps !== null && this.wakeUps !== undefined ? html`<span style="font-weight:700;color:${this.wakeUps <= 1 ? '#22c55e' : this.wakeUps <= 3 ? '#f59e0b' : '#ef4444'}">Z</span>` : ''}
        </div>
      </div>
    `;
  }
}

customElements.define('calendar-cell', CalendarCell);
