import { LitElement, html, css, svg } from 'https://esm.sh/lit@3';
import { api, today, daysAgo, getMonday, getSunday, classifyWorkout } from '../api.js';

class WeeklyRings extends LitElement {
  static properties = {
    config: { type: Object },
    mini: { type: Boolean },
    _cardio: { state: true },
    _strength: { state: true },
    _streak: { state: true },
    _weekDetail: { state: true },
    _expanded: { state: true },
    _loading: { state: true },
  };

  static styles = css`
    :host { display: block; }

    .card {
      background: var(--bg-nav);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
    }

    .card.mini {
      padding: 8px;
      display: inline-block;
    }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin: 0 0 12px 0;
    }

    .rings-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .ring-svg {
      display: block;
    }

    .ring-bg {
      fill: none;
      stroke: var(--border);
    }

    .ring-cardio {
      fill: none;
      stroke: var(--accent);
      stroke-linecap: round;
      transition: stroke-dashoffset 0.6s ease;
    }

    .ring-strength {
      fill: none;
      stroke: var(--warning);
      stroke-linecap: round;
      transition: stroke-dashoffset 0.6s ease;
    }

    .ring-glow-cardio {
      filter: drop-shadow(0 0 6px #ffd700);
    }

    .ring-glow-strength {
      filter: drop-shadow(0 0 6px #ffd700);
    }

    .center-label {
      font-weight: 600;
      text-anchor: middle;
    }

    .label-cardio {
      fill: var(--accent);
      font-size: 11px;
    }

    .label-strength {
      fill: var(--warning);
      font-size: 11px;
    }

    .trophy {
      font-size: 9px;
    }

    .streak {
      text-align: center;
      font-size: 13px;
      color: #ccc;
      margin-top: 4px;
    }

    .loading-text {
      color: var(--text-secondary);
      font-size: 14px;
    }

    /* Expandable */
    .card { cursor: pointer; }
    .card:hover { border-color: var(--border-hover); }

    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .chevron { font-size: 12px; color: var(--text-secondary); transition: transform 0.2s; }
    .chevron.open { transform: rotate(180deg); }

    .expanded {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }

    .split-row {
      display: flex;
      justify-content: space-around;
      gap: 12px;
      margin-bottom: 10px;
    }

    .split-item { text-align: center; }
    .split-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .split-value { font-size: 18px; font-weight: 700; }
    .split-cardio { color: var(--accent); }
    .split-strength { color: var(--warning); }

    .goal-text {
      font-size: 12px;
      color: var(--text-secondary);
      text-align: center;
      margin-top: 8px;
    }
    .goal-text strong { color: #ccc; }
  `;

  constructor() {
    super();
    this.config = null;
    this.mini = false;
    this._cardio = 0;
    this._strength = 0;
    this._streak = 0;
    this._weekDetail = null;
    this._expanded = false;
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  updated(changed) {
    if (changed.has('config') && this.config) {
      this._fetchData();
    }
  }

  async _fetchData() {
    if (!this.config) return;
    this._loading = true;

    try {
      const todayStr = today();
      const monday = getMonday(todayStr);
      const sunday = getSunday(monday);

      const data = await api.workoutsRange(monday, sunday);
      let cardio = 0;
      let strength = 0;

      if (data) {
        for (const dateKey of Object.keys(data)) {
          const workouts = data[dateKey];
          if (!Array.isArray(workouts)) continue;
          for (const w of workouts) {
            const type = classifyWorkout(w.name, this.config);
            if (type === 'cardio') cardio++;
            else if (type === 'strength') strength++;
          }
        }
      }

      this._cardio = cardio;
      this._strength = strength;

      // Calculate streak: consecutive days backwards from today with at least one workout
      await this._calculateStreak();
    } catch {
      this._cardio = 0;
      this._strength = 0;
      this._streak = 0;
    }

    this._loading = false;
  }

  async _calculateStreak() {
    const todayStr = today();
    const startStr = daysAgo(30);

    try {
      const data = await api.workoutsRange(startStr, todayStr);
      if (!data) {
        this._streak = 0;
        return;
      }

      const datesWithWorkouts = new Set();
      for (const [dateKey, workouts] of Object.entries(data)) {
        if (Array.isArray(workouts) && workouts.length > 0) {
          datesWithWorkouts.add(dateKey);
        }
      }

      let streak = 0;
      const d = new Date(todayStr + 'T00:00:00');
      for (let i = 0; i < 30; i++) {
        const dateStr = d.toLocaleDateString('en-CA');
        if (datesWithWorkouts.has(dateStr)) {
          streak++;
        } else {
          break;
        }
        d.setDate(d.getDate() - 1);
      }

      this._streak = streak;
    } catch {
      this._streak = 0;
    }
  }

  _ringPath(radius, done, goal) {
    const circumference = 2 * Math.PI * radius;
    const ratio = Math.min(done / goal, 1);
    const dashOffset = circumference * (1 - ratio);
    return { circumference, dashOffset };
  }

  _renderRings() {
    const goals = this.config?.goals || { cardio_per_week: 2, strength_per_week: 3 };
    const cardioGoal = goals.cardio_per_week;
    const strengthGoal = goals.strength_per_week;

    const outerR = 50;
    const innerR = 38;
    const outerStroke = 8;
    const innerStroke = 8;

    const outer = this._ringPath(outerR, this._cardio, cardioGoal);
    const inner = this._ringPath(innerR, this._strength, strengthGoal);

    const cardioExceeded = this._cardio >= cardioGoal && cardioGoal > 0;
    const strengthExceeded = this._strength >= strengthGoal && strengthGoal > 0;

    const size = this.mini ? 48 : 140;

    const cardioLabel = cardioExceeded
      ? `${this._cardio}/${cardioGoal} \u{1F3C6}`
      : `${this._cardio}/${cardioGoal}`;
    const strengthLabel = strengthExceeded
      ? `${this._strength}/${strengthGoal} \u{1F3C6}`
      : `${this._strength}/${strengthGoal}`;

    return html`
      <svg
        class="ring-svg"
        width="${size}"
        height="${size}"
        viewBox="0 0 120 120"
      >
        <!-- Outer background -->
        ${svg`<circle class="ring-bg" cx="60" cy="60" r="${outerR}" stroke-width="${outerStroke}" />`}
        <!-- Inner background -->
        ${svg`<circle class="ring-bg" cx="60" cy="60" r="${innerR}" stroke-width="${innerStroke}" />`}

        <!-- Outer ring: cardio -->
        ${svg`<circle
          class="ring-cardio ${cardioExceeded ? 'ring-glow-cardio' : ''}"
          cx="60" cy="60" r="${outerR}"
          stroke-width="${outerStroke}"
          stroke-dasharray="${outer.circumference}"
          stroke-dashoffset="${outer.dashOffset}"
          transform="rotate(-90 60 60)"
        />`}

        <!-- Inner ring: strength -->
        ${svg`<circle
          class="ring-strength ${strengthExceeded ? 'ring-glow-strength' : ''}"
          cx="60" cy="60" r="${innerR}"
          stroke-width="${innerStroke}"
          stroke-dasharray="${inner.circumference}"
          stroke-dashoffset="${inner.dashOffset}"
          transform="rotate(-90 60 60)"
        />`}

        ${!this.mini ? svg`
          <text class="center-label label-cardio" x="60" y="56">${cardioLabel}</text>
          <text class="center-label label-strength" x="60" y="72">${strengthLabel}</text>
        ` : ''}
      </svg>
    `;
  }

  _toggle() {
    if (this.mini) return;
    this._expanded = !this._expanded;
  }

  _renderExpanded() {
    const goals = this.config?.goals || {};
    const cardioGoal = goals.cardio_per_week || 2;
    const strengthGoal = goals.strength_per_week || 3;
    const totalGoal = cardioGoal + strengthGoal;
    const total = this._cardio + this._strength;

    return html`
      <div class="expanded">
        <div class="split-row">
          <div class="split-item">
            <div class="split-label">Cardio</div>
            <div class="split-value split-cardio">${this._cardio} / ${cardioGoal}</div>
          </div>
          <div class="split-item">
            <div class="split-label">Strength</div>
            <div class="split-value split-strength">${this._strength} / ${strengthGoal}</div>
          </div>
          <div class="split-item">
            <div class="split-label">Total</div>
            <div class="split-value" style="color:#ccc">${total} / ${totalGoal}</div>
          </div>
        </div>
        ${this._streak > 0 ? html`
          <div class="goal-text">\u{1F525} <strong>${this._streak} day</strong> workout streak</div>
        ` : ''}
        ${total >= totalGoal ? html`
          <div class="goal-text">\u{1F3C6} Weekly target hit!</div>
        ` : html`
          <div class="goal-text">${totalGoal - total} more workout${totalGoal - total !== 1 ? 's' : ''} to hit your weekly target</div>
        `}
      </div>
    `;
  }

  render() {
    if (this._loading) {
      if (this.mini) return html`<div class="card mini"><div class="loading-text">...</div></div>`;
      return html`
        <div class="card">
          <div class="title">Weekly Progress</div>
          <div class="loading-text">Loading...</div>
        </div>
      `;
    }

    if (this.mini) {
      return html`
        <div class="card mini">
          ${this._renderRings()}
        </div>
      `;
    }

    return html`
      <div class="card" @click=${this._toggle}>
        <div class="title-row">
          <div class="title">Weekly Progress</div>
          <span class="chevron ${this._expanded ? 'open' : ''}">\u25BC</span>
        </div>
        <div class="rings-container">
          ${this._renderRings()}
          ${this._streak > 0 && !this._expanded ? html`<div class="streak">\u{1F525}${this._streak} day streak</div>` : ''}
        </div>
        ${this._expanded ? this._renderExpanded() : ''}
      </div>
    `;
  }
}

customElements.define('weekly-rings', WeeklyRings);
