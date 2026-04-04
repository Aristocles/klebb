import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today } from '../api.js';
import './sleep-card.js';
import './weekly-rings.js';
import './activity-card.js';
import './workout-card.js';
import './supplements-card.js';

class TodayView extends LitElement {
  static properties = {
    config: { state: true },
    appointments: { state: true },
    calendarEvents: { state: true },
  };

  static styles = css`
    :host { display: block; }

    .date-header {
      font-size: 1.4rem;
      font-weight: 600;
      color: #e0e0e0;
      margin: 0 0 20px 0;
    }

    .date-header .date {
      color: #00d4aa;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }

    .grid > * {
      min-width: 0;
    }

    @media (min-width: 769px) {
      .grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    @media (min-width: 1025px) {
      .grid {
        grid-template-columns: 1fr 1fr 1fr;
      }
    }

    .upcoming-card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 16px 20px;
    }

    .upcoming-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #8888aa;
      margin: 0 0 12px 0;
    }

    .upcoming-items {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .upcoming-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .upcoming-label {
      font-size: 12px;
      color: #8888aa;
    }

    .upcoming-value {
      font-size: 14px;
      color: #e0e0e0;
      font-weight: 500;
    }

    .upcoming-date {
      font-size: 12px;
      color: #00d4aa;
    }

    .nothing-scheduled {
      font-size: 13px;
      color: #666688;
    }
  `;

  constructor() {
    super();
    this.config = null;
    this.appointments = null;
    this.calendarEvents = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  async _fetchData() {
    const [config, appointments, calendarEvents] = await Promise.all([
      api.config(),
      api.appointments(),
      api.calendarHealth(),
    ]);

    this.config = config;
    this.appointments = appointments;
    this.calendarEvents = calendarEvents;
  }

  _formatHeaderDate() {
    const todayStr = today();
    const d = new Date(todayStr + 'T00:00:00');
    const weekday = d.toLocaleDateString('en-AU', { weekday: 'short' });
    const day = d.getDate();
    const month = d.toLocaleDateString('en-AU', { month: 'short' });
    return `${weekday} ${day} ${month}`;
  }

  _getNextAppointment() {
    if (!Array.isArray(this.appointments)) return null;
    const todayStr = today();
    const upcoming = this.appointments
      .filter(a => a.status !== 'completed' && a.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    return upcoming.length > 0 ? upcoming[0] : null;
  }

  _getNextBloodTest() {
    if (!Array.isArray(this.appointments)) return null;
    const todayStr = today();
    const bloodTests = this.appointments
      .filter(a => a.status !== 'completed' && a.date >= todayStr && a.type === 'blood_test')
      .sort((a, b) => a.date.localeCompare(b.date));
    return bloodTests.length > 0 ? bloodTests[0] : null;
  }

  _formatNiceDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  _daysUntil(dateStr) {
    const todayStr = today();
    const todayDate = new Date(todayStr + 'T00:00:00');
    const targetDate = new Date(dateStr + 'T00:00:00');
    return Math.round((targetDate - todayDate) / (1000 * 60 * 60 * 24));
  }

  _renderUpcomingCard() {
    const nextAppt = this._getNextAppointment();
    const nextBlood = this._getNextBloodTest();
    const calEvents = Array.isArray(this.calendarEvents) ? this.calendarEvents : [];
    const hasItems = nextAppt || nextBlood || calEvents.length > 0;

    return html`
      <div class="upcoming-card">
        <div class="upcoming-title">Upcoming</div>
        ${hasItems ? html`
          <div class="upcoming-items">
            ${nextAppt ? html`
              <div class="upcoming-item">
                <span class="upcoming-label">Next appointment</span>
                <span class="upcoming-value">${nextAppt.title || nextAppt.name || 'Appointment'}</span>
                <span class="upcoming-date">${this._formatNiceDate(nextAppt.date)}</span>
              </div>
            ` : ''}
            ${nextBlood && (!nextAppt || nextBlood.date !== nextAppt.date || nextBlood.title !== nextAppt.title) ? html`
              <div class="upcoming-item">
                <span class="upcoming-label">Blood test follow-up</span>
                <span class="upcoming-value">${nextBlood.title || nextBlood.name || 'Blood test'}</span>
                <span class="upcoming-date">${this._formatNiceDate(nextBlood.date)}</span>
              </div>
            ` : ''}
            ${calEvents.map(ev => {
              const startDate = ev.start?.split('T')[0] || ev.start;
              const daysUntil = this._daysUntil(startDate);
              const countdown = daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil} days`;
              return html`
                <div class="upcoming-item">
                  <span class="upcoming-label">${countdown}</span>
                  <span class="upcoming-value">${ev.summary}</span>
                  <span class="upcoming-date">
                    ${this._formatNiceDate(startDate)}
                    ${ev.location ? html` — ${ev.location}` : ''}
                  </span>
                </div>
              `;
            })}
          </div>
        ` : html`
          <div class="nothing-scheduled">Nothing scheduled</div>
        `}
      </div>
    `;
  }

  render() {
    return html`
      <div class="date-header">
        Today — <span class="date">${this._formatHeaderDate()}</span>
      </div>
      <div class="grid">
        <sleep-card date="${today()}"></sleep-card>
        <weekly-rings .config=${this.config}></weekly-rings>
        <activity-card date="${today()}"></activity-card>
        <workout-card date="${today()}" .config=${this.config}></workout-card>
        <supplements-card></supplements-card>
        ${this._renderUpcomingCard()}
      </div>
    `;
  }
}

customElements.define('today-view', TodayView);
