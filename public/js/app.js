// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
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
import './components/eh-prompt-modal.js';
import { checkPromptsForToday } from './lib/prompt-queue.js';
import { localToday } from './lib/date-util.js';

class HealthApp extends LitElement {
  static properties = {
    route: { type: String },
    routeParam: { type: String },
    showNav: { type: Boolean },
    dayDate: { type: String },
    theme: { type: String },
    _instanceName: { state: true },
    _settingsMenuOpen: { state: true },
    _promptQueue: { state: true },
    _buildInfo: { state: true },
    _demo: { state: true },
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
    this._promptQueue = [];
    this._buildInfo = null;
    this._demo = false;
    document.documentElement.setAttribute('data-theme', this.theme);
    this._handleRoute();
    this._loadInstance();
    this._loadBuildInfo();
    this._loadPrompts();
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
        this._demo = !!j.demo;
        if (this._demo) document.documentElement.setAttribute('data-demo', '1');
      }
    } catch {}
  }

  async _loadBuildInfo() {
    try {
      const r = await fetch('/api/build');
      if (!r.ok) return;
      const j = await r.json();
      if (j && (j.branch || j.commitShort)) this._buildInfo = j;
    } catch {}
  }

  async _loadPrompts() {
    // Evaluate which cards opt into meta.prompt and should fire today.
    // Quiet-fails — prompts are an enhancement, never block app startup.
    try {
      const queue = await checkPromptsForToday();
      if (queue.length) this._promptQueue = queue;
    } catch (err) {
      console.warn('[app] prompt check failed', err);
    }
  }

  _onPromptDone(e) {
    const { cardId, action } = e.detail || {};
    // Mark shown-today regardless of saved/dismissed — per spec, once shown
    // never reshow the same day even on cancel.
    try {
      const today = localToday();
      localStorage.setItem(`klebb-prompt-shown-${cardId}-${today}`, '1');
    } catch {}
    // Advance the queue.
    this._promptQueue = this._promptQueue.slice(1);
    // If that card was saved, nudge a refresh on any rendered cards of
    // the same id (so the Today view reflects the new entry).
    if (action === 'saved') {
      window.dispatchEvent(new CustomEvent('manifest-data-changed', {
        detail: { cardId },
      }));
    }
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
    :host {
      display: block;
      max-width: 100%;
      /* NOTE: don't put overflow-x:hidden here — it can break the
         sticky <nav> child on iOS Safari. Per-container overflow is
         applied further down on <main> and the schedule-card week row. */
    }
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
      /* Explicit full-width so that if a pinch-zoom shifts the visual
         viewport wider than the layout viewport, the nav still spans
         edge-to-edge rather than leaving a gap on the right. */
      width: 100%;
      max-width: 100%;
      /* viewport-fit=cover lets the page extend under the iPhone
         status bar + notch; this padding keeps the nav content
         clear of those hardware regions. */
      padding-top: env(safe-area-inset-top, 0px);
      padding-left: env(safe-area-inset-left, 0px);
      padding-right: env(safe-area-inset-right, 0px);
    }
    .nav-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      min-width: 0;
      gap: 8px;
    }
    .logo {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .logo-mark {
      width: 28px;
      height: 28px;
      display: block;
      flex-shrink: 0;
    }
    .build-badge {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-muted, var(--text-secondary));
      font-size: 0.65rem;
      font-weight: 500;
      letter-spacing: 0.02em;
      font-family: ui-monospace, Menlo, Consolas, monospace;
      white-space: nowrap;
      vertical-align: middle;
    }
    .demo-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 6px 12px;
      background: linear-gradient(135deg, #0ea5e9, #6366f1);
      color: #fff;
      font-size: 0.8rem;
      font-weight: 500;
      letter-spacing: 0.01em;
      text-align: center;
    }
    .demo-banner a {
      color: #fff;
      text-decoration: underline;
    }
    .nav-links {
      display: flex;
      gap: 4px;
      min-width: 0;
      flex-wrap: nowrap;
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
      /* Leave room for the peek-bar chat widget pinned to the bottom */
      padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
      /* Hard guard against any child overflowing horizontally — we'd
         rather clip a stray wide element than have the whole page
         shrink-to-fit on mobile. */
      overflow-x: hidden;
      box-sizing: border-box;
    }
    @media (max-width: 480px) {
      .nav-main { padding: 8px 12px; gap: 6px; }
      .logo { font-size: 0.95rem; gap: 6px; }
      .logo-mark { width: 24px; height: 24px; }
      .nav-links { gap: 2px; }
      .nav-link { font-size: 0.75rem; padding: 5px 8px; }
      main {
        padding: 12px;
        padding-bottom: calc(68px + env(safe-area-inset-bottom, 0px));
      }
    }
  `;

  render() {
    const activePrompt = this._promptQueue[0];
    return html`
      ${activePrompt ? html`
        <eh-prompt-modal
          .card=${activePrompt}
          .date=${localToday()}
          @eh-prompt-done=${this._onPromptDone}
        ></eh-prompt-modal>
      ` : ''}
      ${this.showNav ? html`
        <nav>
          ${this._demo ? html`
            <div class="demo-banner" role="status">
              You're viewing the public Klebb demo. Data resets hourly. Run your own at
              <a href="https://klebb.app" target="_blank" rel="noopener">klebb.app</a>.
            </div>
          ` : ''}
          <div class="nav-main">
            <div class="logo" @click=${this._toggleTheme} style="cursor:pointer" title="Toggle theme">
              <img
                class="logo-mark"
                src="${this.theme === 'dark' ? '/icons/logo-dark.png' : '/icons/logo-light.png'}"
                alt=""
                aria-hidden="true"
                width="28"
                height="28"
              > ${this._instanceName}
              ${this._buildInfo ? html`
                <span class="build-badge"
                  title="${this._buildInfo.commit || ''}${this._buildInfo.builtAt ? ' @ ' + this._buildInfo.builtAt : ''}"
                >${this._buildInfo.branch || ''}${this._buildInfo.branch && this._buildInfo.commitShort ? ' @ ' : ''}${this._buildInfo.commitShort || ''}</span>
              ` : ''}
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
