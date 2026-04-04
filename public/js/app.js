import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './components/today-view.js';
import './components/calendar-view.js';
import './components/trends-view.js';
import './components/day-detail.js';
import './components/widget-view.js';
import './components/reports-view.js';
import './components/health-chat.js';
import './components/mood-checkin.js';

class HealthApp extends LitElement {
  static properties = {
    route: { type: String },
    routeParam: { type: String },
    showNav: { type: Boolean },
  };

  constructor() {
    super();
    this.route = 'today';
    this.routeParam = '';
    this.showNav = true;
    this._handleRoute();
    window.addEventListener('popstate', () => this._handleRoute());
    window.addEventListener('navigate', (e) => {
      history.pushState(null, '', e.detail.path);
      this._handleRoute();
    });
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
      this.showNav = true;
    } else if (path === '/widget') {
      this.route = 'widget';
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

  static styles = css`
    :host { display: block; }
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-bottom: 1px solid #2a2a4a;
      background: #121220;
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .logo {
      font-size: 1.1rem;
      font-weight: 700;
      color: #00d4aa;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-links {
      display: flex;
      gap: 4px;
    }
    .nav-link {
      color: #8888aa;
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
      color: #e0e0e0;
      background: rgba(255,255,255,0.05);
    }
    .nav-link.active {
      color: #00d4aa;
      background: rgba(0,212,170,0.1);
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    @media (max-width: 480px) {
      nav {
        padding: 8px 12px;
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
          <div class="logo" @click=${() => this._navigate('/')} style="cursor:pointer">
            <span>🚀</span> EddzHealth
          </div>
          <div class="nav-links">
            <button class="nav-link ${this.route === 'today' ? 'active' : ''}" @click=${() => this._navigate('/')}>Today</button>
            <button class="nav-link ${this.route === 'calendar' ? 'active' : ''}" @click=${() => this._navigate('/calendar')}>Calendar</button>
            <button class="nav-link ${this.route === 'trends' ? 'active' : ''}" @click=${() => this._navigate('/trends')}>Trends</button>
            <button class="nav-link ${this.route === 'reports' ? 'active' : ''}" @click=${() => this._navigate('/reports')}>Reports</button>
          </div>
        </nav>
      ` : ''}
      <main>
        ${this.route === 'today' ? html`<today-view></today-view>` : ''}
        ${this.route === 'calendar' ? html`<calendar-view></calendar-view>` : ''}
        ${this.route === 'trends' ? html`<trends-view></trends-view>` : ''}
        ${this.route === 'reports' ? html`<reports-view></reports-view>` : ''}
        ${this.route === 'day' ? html`<day-detail .date=${this.routeParam}></day-detail>` : ''}
        ${this.route === 'widget' ? html`<widget-view></widget-view>` : ''}
      </main>
      <health-chat></health-chat>
      <mood-checkin></mood-checkin>
    `;
  }
}

customElements.define('health-app', HealthApp);
