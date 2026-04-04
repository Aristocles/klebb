import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today, getMonday, getSunday, classifyWorkout, formatHours } from '../api.js';

class WidgetView extends LitElement {
  static properties = {
    _show: { state: true },
    _sleep: { state: true },
    _activity: { state: true },
    _config: { state: true },
    _cardio: { state: true },
    _strength: { state: true },
    _appointments: { state: true },
    _loading: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      max-width: 300px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .widgets {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 8px;
    }

    .widget {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 12px;
    }

    .widget-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #64748b;
      margin: 0 0 6px 0;
    }

    /* Sleep widget */
    .sleep-value {
      font-size: 22px;
      font-weight: 700;
      color: #1e293b;
    }

    .sleep-good {
      background: rgba(68, 255, 136, 0.08);
    }

    .sleep-ok {
      background: rgba(255, 170, 0, 0.08);
    }

    .sleep-bad {
      background: rgba(255, 68, 68, 0.08);
    }

    /* Steps widget */
    .steps-value {
      font-size: 24px;
      font-weight: 700;
      color: #0ea5e9;
    }

    /* Rings widget */
    .rings-wrap {
      display: flex;
      justify-content: center;
    }

    .ring-bg {
      fill: none;
      stroke: #e2e8f0;
    }

    .ring-cardio {
      fill: none;
      stroke: #0ea5e9;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.6s ease;
    }

    .ring-strength {
      fill: none;
      stroke: #f59e0b;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.6s ease;
    }

    /* Appointment widget */
    .appt-text {
      font-size: 13px;
      color: #1e293b;
      font-weight: 500;
    }

    .appt-date {
      font-size: 11px;
      color: #0ea5e9;
      margin-top: 2px;
    }

    .empty-text {
      font-size: 12px;
      color: #94a3b8;
    }

    .loading-text {
      font-size: 12px;
      color: #64748b;
    }
  `;

  constructor() {
    super();
    this._show = null;
    this._sleep = null;
    this._activity = null;
    this._config = null;
    this._cardio = 0;
    this._strength = 0;
    this._appointments = null;
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._parseParams();
    this._fetchData();
  }

  _parseParams() {
    const params = new URLSearchParams(window.location.search);
    const showParam = params.get('show');
    if (showParam) {
      this._show = showParam.split(',').map(s => s.trim().toLowerCase());
    } else {
      this._show = null; // show all
    }
  }

  _shouldShow(widget) {
    if (!this._show) return true;
    return this._show.includes(widget);
  }

  async _fetchData() {
    this._loading = true;
    const todayStr = today();

    try {
      const fetches = [
        api.sleep(todayStr),
        api.activity(todayStr),
        api.config(),
        api.appointments(),
      ];

      const [sleep, activity, config, appointments] = await Promise.all(fetches);

      this._sleep = Array.isArray(sleep) && sleep.length > 0 ? sleep[0] : null;
      this._activity = activity || null;
      this._config = config || null;
      this._appointments = Array.isArray(appointments) ? appointments : [];

      // Fetch weekly workouts for rings
      if (config && this._shouldShow('rings')) {
        const monday = getMonday(todayStr);
        const sunday = getSunday(monday);
        const workoutsData = await api.workoutsRange(monday, sunday);

        let cardio = 0;
        let strength = 0;

        if (workoutsData) {
          for (const dateKey of Object.keys(workoutsData)) {
            const workouts = workoutsData[dateKey];
            if (!Array.isArray(workouts)) continue;
            for (const w of workouts) {
              const type = classifyWorkout(w.name, config);
              if (type === 'cardio') cardio++;
              else if (type === 'strength') strength++;
            }
          }
        }

        this._cardio = cardio;
        this._strength = strength;
      }
    } catch {
      this._sleep = null;
      this._activity = null;
      this._config = null;
      this._appointments = [];
    }

    this._loading = false;
  }

  _sleepQualityClass(total) {
    if (total >= 7.5) return 'sleep-good';
    if (total >= 6) return 'sleep-ok';
    return 'sleep-bad';
  }

  _getNextAppointment() {
    if (!Array.isArray(this._appointments)) return null;
    const todayStr = today();
    const upcoming = this._appointments
      .filter(a => a.status !== 'completed' && a.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    return upcoming.length > 0 ? upcoming[0] : null;
  }

  _formatNiceDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }

  _renderSleepWidget() {
    if (!this._shouldShow('sleep')) return '';

    if (!this._sleep) {
      return html`
        <div class="widget">
          <div class="widget-label">Sleep</div>
          <div class="empty-text">No data</div>
        </div>
      `;
    }

    const total = this._sleep.totalSleep || 0;

    return html`
      <div class="widget ${this._sleepQualityClass(total)}">
        <div class="widget-label">Sleep</div>
        <div class="sleep-value">${formatHours(total)}</div>
      </div>
    `;
  }

  _renderStepsWidget() {
    if (!this._shouldShow('steps')) return '';

    const steps = this._activity?.step_count?.total || 0;

    return html`
      <div class="widget">
        <div class="widget-label">Steps</div>
        <div class="steps-value">${steps.toLocaleString()}</div>
      </div>
    `;
  }

  _renderRingsWidget() {
    if (!this._shouldShow('rings')) return '';
    if (!this._config) return '';

    const goals = this._config.goals || { cardio_per_week: 2, strength_per_week: 3 };
    const cardioGoal = goals.cardio_per_week;
    const strengthGoal = goals.strength_per_week;

    const outerR = 20;
    const innerR = 14;
    const outerStroke = 4;
    const innerStroke = 4;

    const outerCirc = 2 * Math.PI * outerR;
    const innerCirc = 2 * Math.PI * innerR;
    const outerOffset = outerCirc * (1 - Math.min(this._cardio / cardioGoal, 1));
    const innerOffset = innerCirc * (1 - Math.min(this._strength / strengthGoal, 1));

    return html`
      <div class="widget">
        <div class="widget-label">Weekly Rings</div>
        <div class="rings-wrap">
          <svg width="48" height="48" viewBox="0 0 48 48">
            <circle class="ring-bg" cx="24" cy="24" r="${outerR}" stroke-width="${outerStroke}" />
            <circle class="ring-bg" cx="24" cy="24" r="${innerR}" stroke-width="${innerStroke}" />
            <circle
              class="ring-cardio"
              cx="24" cy="24" r="${outerR}"
              stroke-width="${outerStroke}"
              stroke-dasharray="${outerCirc}"
              stroke-dashoffset="${outerOffset}"
              transform="rotate(-90 24 24)"
            />
            <circle
              class="ring-strength"
              cx="24" cy="24" r="${innerR}"
              stroke-width="${innerStroke}"
              stroke-dasharray="${innerCirc}"
              stroke-dashoffset="${innerOffset}"
              transform="rotate(-90 24 24)"
            />
          </svg>
        </div>
      </div>
    `;
  }

  _renderAppointmentWidget() {
    if (!this._shouldShow('appointment')) return '';

    const next = this._getNextAppointment();

    if (!next) {
      return html`
        <div class="widget">
          <div class="widget-label">Next Appointment</div>
          <div class="empty-text">Nothing scheduled</div>
        </div>
      `;
    }

    return html`
      <div class="widget">
        <div class="widget-label">Next Appointment</div>
        <div class="appt-text">${next.title || next.name || 'Appointment'}</div>
        <div class="appt-date">${this._formatNiceDate(next.date)}</div>
      </div>
    `;
  }

  render() {
    if (this._loading) {
      return html`
        <div class="widgets">
          <div class="widget">
            <div class="loading-text">Loading...</div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="widgets">
        ${this._renderSleepWidget()}
        ${this._renderStepsWidget()}
        ${this._renderRingsWidget()}
        ${this._renderAppointmentWidget()}
      </div>
    `;
  }
}

customElements.define('widget-view', WidgetView);
