import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today } from '../api.js';

class SupplementsCard extends LitElement {
  static properties = {
    _supplements: { state: true },
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
      min-width: 0;
      overflow: hidden;
      cursor: pointer;
    }

    .card:hover { border-color: var(--border-hover); }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .count-badge {
      font-size: 11px;
      background: rgba(0, 212, 170, 0.15);
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 10px;
    }

    .chevron { font-size: 12px; color: var(--text-secondary); transition: transform 0.2s; }
    .chevron.open { transform: rotate(180deg); }

    .list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .icon {
      font-size: 16px;
      width: 24px;
      text-align: center;
      flex-shrink: 0;
    }

    .name {
      font-size: 14px;
      color: var(--text-primary);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dose {
      font-size: 12px;
      color: var(--text-muted);
      margin-left: auto;
      white-space: nowrap;
    }

    .mounjaro-badge {
      font-size: 11px;
      background: rgba(255, 200, 0, 0.15);
      color: #ffcc44;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 6px;
    }

    .loading-text {
      color: var(--text-secondary);
      font-size: 14px;
    }

    .empty-text {
      color: var(--text-muted);
      font-size: 13px;
    }
  `;

  constructor() {
    super();
    this._supplements = null;
    this._expanded = false;
    this.loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  async _fetchData() {
    this.loading = true;
    try {
      const data = await api.supplements();
      this._supplements = data?.current ?? null;
    } catch {
      this._supplements = null;
    }
    this.loading = false;
  }

  _matchesDay(dayOfWeek, configDay) {
    if (typeof configDay === 'number') return dayOfWeek === configDay;
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return dayNames[dayOfWeek] === String(configDay).toLowerCase();
  }

  _getDueToday(supplements) {
    if (!supplements) return [];
    const now = new Date();
    const sydneyDate = new Date(
      now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' })
    );
    const todayDayOfWeek = sydneyDate.getDay();
    const todayStr = today();

    return supplements.filter(s => {
      const freq = (s.frequency || '').toLowerCase();

      // Exclude "as needed"
      if (freq === 'as needed') return false;

      // Daily -> always show
      if (freq === 'daily') return true;

      // Weekly -> only show on the supplement's configured day
      if (freq === 'weekly') {
        if (s.day != null) return this._matchesDay(todayDayOfWeek, s.day);
        return todayDayOfWeek === 1; // default to Monday
      }

      // "every X days" or "every X-Y days" -> calculate from startDate
      if (freq.startsWith('every')) {
        const match = freq.match(/every\s+(\d+)/);
        if (match && s.startDate) {
          const interval = parseInt(match[1]);
          const start = new Date(s.startDate + 'T00:00:00');
          const todayDate = new Date(todayStr + 'T00:00:00');
          const diffDays = Math.round((todayDate - start) / (1000 * 60 * 60 * 24));
          return diffDays >= 0 && diffDays % interval === 0;
        }
        return true; // no startDate, show it
      }

      // Unknown frequency -> show it
      return true;
    });
  }

  render() {
    if (this.loading) {
      return html`
        <div class="card">
          <div class="title">Supplements</div>
          <div class="loading-text">Loading...</div>
        </div>
      `;
    }

    const due = this._getDueToday(this._supplements);

    return html`
      <div class="card" @click=${() => this._expanded = !this._expanded}>
        <div class="title">
          Supplements ${due.length > 0 ? html`<span class="count-badge">${due.length}</span>` : ''}
          <span class="chevron ${this._expanded ? 'open' : ''}">\u25BC</span>
        </div>
        ${this._expanded ? html`
          <div class="list" style="margin-top:12px">
            ${due.length === 0 ? html`<div class="empty-text">Nothing scheduled today</div>` : ''}
            ${due.map(s => {
              const isMounjaro = s.name.toLowerCase().includes('mounjaro');
              const isWeekly = (s.frequency || '').toLowerCase() === 'weekly';
              const icon = isMounjaro && isWeekly ? '\u{1F489}' : s.colour;
              return html`
                <div class="row">
                  <span class="icon">${icon}</span>
                  <span class="name">
                    ${s.name}
                    ${isMounjaro && isWeekly ? html`<span class="mounjaro-badge">injection day</span>` : ''}
                  </span>
                  <span class="dose">${s.dose}</span>
                </div>
              `;
            })}
          </div>
        ` : ''}
      </div>
    `;
  }
}

customElements.define('supplements-card', SupplementsCard);
