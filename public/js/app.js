import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './components/today-view.js';
import './components/calendar-view.js';
import './components/trends-view.js';
import './components/day-detail.js';
import './components/widget-view.js';
import './components/reports-view.js';
import './components/health-chat.js';
import './components/mood-checkin.js';
// v2 manifest-driven DateView (opt-in via ?v2=1 or localStorage flag)
import './components/eh-date-view.js';
import './components/eh-settings-view.js';
import './components/eh-setup-wizard.js';

class HealthApp extends LitElement {
  static properties = {
    route: { type: String },
    routeParam: { type: String },
    showNav: { type: Boolean },
    dayDate: { type: String },
    theme: { type: String },
    v2: { type: Boolean },
  };

  constructor() {
    super();
    this.route = 'today';
    this.routeParam = '';
    this.showNav = true;
    this.dayDate = '';
    this.theme = localStorage.getItem('eddzhealth-theme') || 'light';
    // v2 opt-in: ?v2=1 in URL, or persisted flag in localStorage.
    // Enables manifest-driven DateView for /, /day/:date. Everything
    // else (calendar, trends, reports) keeps the legacy components
    // until their M3b+ replacements land.
    const urlV2 = new URLSearchParams(window.location.search).get('v2');
    if (urlV2 === '1') localStorage.setItem('eddzhealth-v2', '1');
    if (urlV2 === '0') localStorage.removeItem('eddzhealth-v2');
    this.v2 = localStorage.getItem('eddzhealth-v2') === '1';
    document.documentElement.setAttribute('data-theme', this.theme);
    this._handleRoute();
    window.addEventListener('popstate', () => this._handleRoute());
    window.addEventListener('navigate', (e) => {
      history.pushState(null, '', e.detail.path);
      this._handleRoute();
    });
    window.addEventListener('day-date-changed', (e) => {
      this.dayDate = e.detail.date;
    });
  }

  _toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', this.theme);
    localStorage.setItem('eddzhealth-theme', this.theme);
  }

  _handleRoute() {
    const path = window.location.pathname;
    if (path === '/' || path === '') {
      this.route = 'today';
      this.showNav = true;
    } else if (path === '/calendar') {
      this.route = 'calendar';
      this.showNav = true;
    } else if (path === '/trends') {
      this.route = 'trends';
      this.showNav = true;
    } else if (path === '/reports') {
      this.route = 'reports';
      this.showNav = true;
    } else if (path.startsWith('/day/')) {
      this.route = 'day';
      this.routeParam = path.slice(5);
      this.dayDate = this.routeParam;
      this.showNav = true;
    } else if (path === '/widget') {
      this.route = 'widget';
      this.showNav = false;
    } else if (path === '/settings') {
      this.route = 'settings';
      this.showNav = true;
    } else if (path === '/setup') {
      this.route = 'setup';
      this.showNav = false;
    } else {
      this.route = 'today';
      this.showNav = true;
    }
  }

  _navigate(path) {
    history.pushState(null, '', path);
    this._handleRoute();
  }

  _formatNavDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  static styles = css`
    :host { display: block; }
    nav {
      display: flex;
      flex-direction: column;
      padding: 0;
      border-bottom: 1px solid var(--border);
      background: var(--bg-nav);
      box-shadow: var(--shadow-nav);
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .nav-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
    }
    .nav-date {
      text-align: center;
      padding: 6px 20px 10px;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
      border-top: 1px solid var(--border-subtle);
    }
    .logo {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-links {
      display: flex;
      gap: 4px;
    }
    .nav-link {
      color: var(--text-secondary);
      text-decoration: none;
      padding: 6px 14px;
      border-radius: 8px;
      transition: all 0.2s;
      font-size: 0.875rem;
      cursor: pointer;
      border: none;
      background: none;
      font-family: inherit;
    }
    .nav-link:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }
    .nav-link.active {
      color: var(--accent);
      background: var(--accent-bg);
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    @media (max-width: 480px) {
      .nav-main {
        padding: 8px 12px;
      }
      .nav-date {
        padding: 4px 12px 8px;
        font-size: 0.9rem;
      }
      .logo {
        font-size: 0.95rem;
      }
      .nav-links {
        gap: 2px;
      }
      .nav-link {
        font-size: 0.75rem;
        padding: 5px 8px;
      }
      main {
        padding: 12px;
      }
    }
  `;

  render() {
    return html`
      ${this.showNav ? html`
        <nav>
          <div class="nav-main">
            <div class="logo" @click=${this._toggleTheme} style="cursor:pointer" title="Toggle theme">
              <span>${this.theme === 'light' ? '🚀' : '🌙'}</span> EddzHealth
            </div>
            <div class="nav-links">
              <button class="nav-link ${this.route === 'today' ? 'active' : ''}" @click=${() => this._navigate('/')}>Today</button>
              <button class="nav-link ${this.route === 'calendar' || this.route === 'day' ? 'active' : ''}" @click=${() => this._navigate('/calendar')}>Calendar</button>
              <button class="nav-link ${this.route === 'trends' ? 'active' : ''}" @click=${() => this._navigate('/trends')}>Trends</button>
              <button class="nav-link ${this.route === 'reports' ? 'active' : ''}" @click=${() => this._navigate('/reports')}>Reports</button>
            </div>
          </div>
          ${this.route === 'day' && this.dayDate ? html`
            <div class="nav-date">${this._formatNavDate(this.dayDate)}</div>
          ` : ''}
        </nav>
      ` : ''}
      <main>
        ${this.route === 'today' ? (this.v2
          ? html`<eh-date-view></eh-date-view>`
          : html`<today-view></today-view>`) : ''}
        ${this.route === 'calendar' ? html`<calendar-view></calendar-view>` : ''}
        ${this.route === 'trends' ? html`<trends-view></trends-view>` : ''}
        ${this.route === 'reports' ? html`<reports-view></reports-view>` : ''}
        ${this.route === 'day' ? (this.v2
          ? html`<eh-date-view .date=${this.routeParam}></eh-date-view>`
          : html`<day-detail .date=${this.routeParam}></day-detail>`) : ''}
        ${this.route === 'widget' ? html`<widget-view></widget-view>` : ''}
        ${this.route === 'settings' ? html`<eh-settings-view></eh-settings-view>` : ''}
        ${this.route === 'setup' ? html`<eh-setup-wizard></eh-setup-wizard>` : ''}
      </main>
      <health-chat></health-chat>
      <mood-checkin></mood-checkin>
    `;
  }
}

customElements.define('health-app', HealthApp);
