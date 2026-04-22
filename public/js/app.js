// public/js/app.js
// Klebb v2 app shell. Manifest-driven throughout. Legacy v1 views
// (today-view, day-detail, calendar-view, trends-view, widget-view) have
// been retired — they were hardcoded for a specific Apple Watch data
// shape and couldn't render arbitrary manifest data.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

// v2 views — all manifest-driven
import './components/eh-date-view.js';        // / and /day/:date
import './components/eh-calendar-view.js';    // /calendar
import './components/eh-trends-view.js';      // /trends
import './components/eh-reports-view.js';     // /reports
import './components/eh-settings-view.js';    // /settings

// Shared widgets
import './components/health-chat.js';

class HealthApp extends LitElement {
  static properties = {
    route: { type: String },
    routeParam: { type: String },
    showNav: { type: Boolean },
    dayDate: { type: String },
    theme: { type: String },
    _instanceName: { state: true },
    _settingsMenuOpen: { state: true },
  };

  constructor() {
    super();
    this.route = 'today';
    this.routeParam = '';
    this.showNav = true;
    this.dayDate = '';
    this.theme = localStorage.getItem('klebb-theme') || 'light';
    this._instanceName = 'Klebb';
    this._settingsMenuOpen = false;
    document.documentElement.setAttribute('data-theme', this.theme);
    this._handleRoute();
    this._loadInstance();
    window.addEventListener('popstate', () => this._handleRoute());
    window.addEventListener('navigate', (e) => {
      history.pushState(null, '', e.detail.path);
      this._handleRoute();
    });
    window.addEventListener('day-date-changed', (e) => {
      this.dayDate = e.detail.date;
    });
    // Close menu on outside click / escape
    this._onGlobalClick = (e) => {
      if (!this._settingsMenuOpen) return;
      const root = this.shadowRoot;
      if (root && root.querySelector('.settings-menu-wrap')?.contains(e.composedPath()[0])) return;
      this._settingsMenuOpen = false;
    };
    this._onGlobalKey = (e) => {
      if (e.key === 'Escape' && this._settingsMenuOpen) {
        this._settingsMenuOpen = false;
      }
    };
    window.addEventListener('click', this._onGlobalClick);
    window.addEventListener('keydown', this._onGlobalKey);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('click', this._onGlobalClick);
    window.removeEventListener('keydown', this._onGlobalKey);
  }

  async _loadInstance() {
    try {
      const r = await fetch('/api/instance');
      if (r.ok) {
        const j = await r.json();
        if (j.name) this._instanceName = j.name;
      }
    } catch {}
  }

  _toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', this.theme);
    localStorage.setItem('klebb-theme', this.theme);
  }

  _handleRoute() {
    const path = window.location.pathname;
    if (path === '/' || path === '') {
      this.route = 'today';
      this.showNav = true;
    } else if (path === '/calendar' || path.startsWith('/calendar/')) {
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
      // Widget route retained for backward compatibility — routes to date-view today
      this.route = 'today';
      this.showNav = false;
    } else if (path === '/settings') {
      this.route = 'settings';
      this.showNav = true;
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
    .settings-menu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      display: flex;
      flex-direction: column;
      min-width: 170px;
      overflow: hidden;
      z-index: 50;
    }
    .settings-menu button {
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 13px;
      padding: 10px 14px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    .settings-menu button:hover,
    .settings-menu button:focus-visible {
      background: var(--bg-hover, rgba(0,0,0,0.04));
      outline: none;
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      /* Leave room for the floating chat button (+ its bottom offset + safe area) */
      padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px));
    }
    @media (max-width: 480px) {
      .nav-main { padding: 8px 12px; }
      .logo { font-size: 0.95rem; }
      .nav-links { gap: 2px; }
      .nav-link { font-size: 0.75rem; padding: 5px 8px; }
      main {
        padding: 12px;
        padding-bottom: calc(85px + env(safe-area-inset-bottom, 0px));
      }
    }
  `;

  render() {
    return html`
      ${this.showNav ? html`
        <nav>
          <div class="nav-main">
            <div class="logo" @click=${this._toggleTheme} style="cursor:pointer" title="Toggle theme">
              <span>${this.theme === 'light' ? '💪' : '🌙'}</span> ${this._instanceName}
            </div>
            <div class="nav-links">
              <button class="nav-link ${this.route === 'today' || this.route === 'day' ? 'active' : ''}" @click=${() => this._navigate('/')}>Today</button>
              <button class="nav-link ${this.route === 'calendar' ? 'active' : ''}" @click=${() => this._navigate('/calendar')}>Calendar</button>
              <button class="nav-link ${this.route === 'trends' ? 'active' : ''}" @click=${() => this._navigate('/trends')}>Trends</button>
              <button class="nav-link ${this.route === 'reports' ? 'active' : ''}" @click=${() => this._navigate('/reports')}>Reports</button>
              <div class="settings-menu-wrap" style="position: relative; display: inline-block;">
                <button
                  class="nav-link ${this.route === 'settings' ? 'active' : ''}"
                  aria-haspopup="menu"
                  aria-expanded="${this._settingsMenuOpen}"
                  aria-label="Settings menu"
                  @click=${(e) => { e.stopPropagation(); this._settingsMenuOpen = !this._settingsMenuOpen; }}
                >⚙️</button>
                ${this._settingsMenuOpen ? html`
                  <div class="settings-menu" role="menu">
                    <button
                      role="menuitem"
                      @click=${() => {
                        this._settingsMenuOpen = false;
                        window.dispatchEvent(new CustomEvent('klebb-enter-reorder-mode'));
                      }}
                    >⋮⋮ Reorder cards</button>
                    <button
                      role="menuitem"
                      @click=${() => {
                        this._settingsMenuOpen = false;
                        this._navigate('/settings');
                      }}
                    >⚙️ Settings</button>
                  </div>
                ` : ''}
              </div>
            </div>
          </div>
        </nav>
      ` : ''}
      <main>
        ${this.route === 'today' ? html`<eh-date-view></eh-date-view>` : ''}
        ${this.route === 'day' ? html`<eh-date-view .date=${this.routeParam}></eh-date-view>` : ''}
        ${this.route === 'calendar' ? html`<eh-calendar-view></eh-calendar-view>` : ''}
        ${this.route === 'trends' ? html`<eh-trends-view></eh-trends-view>` : ''}
        ${this.route === 'reports' ? html`<eh-reports-view></eh-reports-view>` : ''}
        ${this.route === 'settings' ? html`<eh-settings-view></eh-settings-view>` : ''}
      </main>
      <health-chat></health-chat>
    `;
  }
}

customElements.define('health-app', HealthApp);
