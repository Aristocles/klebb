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
import { readTheme, applyTheme } from './lib/theme.js';
import { heartbeat as pushHeartbeat, detectAndHandleKeyRotation } from './lib/notification-client.js';
import { consumePendingDeepLink } from './lib/deep-link.js';

class HealthApp extends LitElement {
  static properties = {
    route: { type: String },
    routeParam: { type: String },
    showNav: { type: Boolean },
    dayDate: { type: String },
    theme: { type: String },
    _instanceName: { state: true },
    _promptQueue: { state: true },
    _buildInfo: { state: true },
    _demo: { state: true },
    _pausedUntil: { state: true },
  };

  constructor() {
    super();
    this.route = 'today';
    this.routeParam = '';
    this.showNav = true;
    this.dayDate = '';
    this.theme = readTheme();
    this._instanceName = 'Klebb';
    this._promptQueue = [];
    this._buildInfo = null;
    this._demo = false;
    this._pausedUntil = null;
    applyTheme(this.theme);
    this._onThemeChanged = (e) => { this.theme = e.detail.theme; };
    window.addEventListener('klebb-theme-changed', this._onThemeChanged);
    this._registerServiceWorker();
    this._postUserTz();
    this._wirePushHeartbeat();
    this._handleRoute();
    this._loadInstance();
    this._loadBuildInfo();
    this._loadPrompts();
    this._loadPausedState();
    this._onPauseChanged = () => this._loadPausedState();
    window.addEventListener('klebb-notifications-pause-changed', this._onPauseChanged);
    this._wireSwMessages();
    this._consumePendingDeepLink();
    window.addEventListener('popstate', () => this._handleRoute());
    window.addEventListener('navigate', (e) => {
      history.pushState(null, '', e.detail.path);
      this._handleRoute();
    });
    window.addEventListener('day-date-changed', (e) => {
      this.dayDate = e.detail.date;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('klebb-theme-changed', this._onThemeChanged);
    window.removeEventListener('klebb-notifications-pause-changed', this._onPauseChanged);
  }

  async _loadPausedState() {
    try {
      const r = await fetch('/api/notifications', { credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      this._pausedUntil = j.paused_until || null;
    } catch {}
  }

  async _resumeNotifications() {
    await fetch('/api/notifications/global-state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused_until: null }),
    });
    this._pausedUntil = null;
  }

  _formatPauseUntil(iso) {
    try {
      return new Date(iso).toLocaleString('en-AU', {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
      });
    } catch { return iso; }
  }

  _registerServiceWorker() {
    // SW registration is fire-and-forget. /sw.js 404s in demo mode, so the
    // registration just rejects there with no user-visible effect. Push
    // delivery is wired up in the notifications PR (#387); for now the SW
    // is registered so the browser keeps it alive once push lands.
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }

  async _consumePendingDeepLink() {
    // On iOS PWA cold-start, clients.openWindow may launch via the
    // manifest's start_url and strip the query the SW set on the
    // notification's data.url. Read-and-clear the stashed intent.
    const pending = await consumePendingDeepLink();
    if (!pending || !pending.url) return;
    try {
      const url = new URL(pending.url, location.origin);
      if (url.origin !== location.origin) return;
      const target = url.pathname + url.search + url.hash;
      // Don't override an explicit deep-link the user already navigated
      // to in the same boot.
      if (location.pathname === '/' && !location.search) {
        history.replaceState(null, '', target);
        this._handleRoute();
      }
    } catch {}
  }

  _wireSwMessages() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (event) => {
      // Origin check is the real cross-frame defence: a third-party
      // iframe could postMessage to this window, but its event.origin
      // would not match. event.source can legitimately be null for
      // messages delivered from a ServiceWorker on Edge/Windows, so
      // gating on it dropped real deep-link messages.
      if (event.origin && event.origin !== location.origin) return;
      const msg = event.data || {};
      if (msg.type !== 'klebb-deep-link' && msg.type !== 'klebb-foreground-notification') return;

      if (msg.type === 'klebb-deep-link') {
        try {
          const url = new URL(msg.url, location.origin);
          if (url.origin === location.origin) {
            history.pushState(null, '', url.pathname + url.search + url.hash);
            this._handleRoute();
          }
        } catch {}
      } else {
        // Render an in-app toast via a CustomEvent so the
        // notifications tab and any future toast layer can pick it up.
        window.dispatchEvent(new CustomEvent('klebb-foreground-notification', {
          detail: { title: msg.title, body: msg.body, items: msg.items },
        }));
      }
    });
  }

  _wirePushHeartbeat() {
    // On every visibility-to-visible transition AND on app boot, ask
    // the server whether it still has our push subscription. If it
    // doesn't (404), the client lib silently resubscribes.
    // Critical for iOS PWA reinstall flows where WebKit storage and
    // server-side subscriptions can drift out of sync.
    pushHeartbeat().catch(() => {});
    detectAndHandleKeyRotation().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pushHeartbeat().catch(() => {});
        detectAndHandleKeyRotation().catch(() => {});
      }
    });
  }

  _postUserTz() {
    // Tell the server which IANA timezone the browser is in, so the
    // notifications scheduler fires reminders in the user's local time
    // when they travel rather than in the server's TZ.
    //
    // Fire-and-forget; quiet on failure (the scheduler falls back to
    // process.env.TZ on the server). Idempotent: skip the round-trip
    // when the value hasn't changed since last boot.
    let tz = null;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    if (!tz) return;
    try {
      if (localStorage.getItem('klebb-tz-last-posted') === tz) return;
    } catch {}
    fetch('/api/user/tz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tz }),
    }).then(r => {
      if (r.ok) {
        try { localStorage.setItem('klebb-tz-last-posted', tz); } catch {}
      }
    }).catch(() => {});
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
    .pause-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 6px 12px;
      background: var(--accent-amber-bg, rgba(255, 170, 51, 0.15));
      color: var(--accent-amber, #ffaa33);
      font-size: 0.8rem;
      font-weight: 500;
      letter-spacing: 0.01em;
    }
    .pause-banner .resume-btn {
      font: inherit;
      font-size: 0.75rem;
      padding: 2px 10px;
      border-radius: 4px;
      border: 1px solid var(--accent-amber, #ffaa33);
      background: transparent;
      color: var(--accent-amber, #ffaa33);
      cursor: pointer;
    }
    .pause-banner .resume-btn:hover { filter: brightness(1.1); }
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
              You're viewing the public Klebb demo. Data resets periodically. Run your own at
              <a href="https://klebb.app" target="_blank" rel="noopener">klebb.app</a>.
            </div>
          ` : ''}
          ${this._pausedUntil && this._pausedUntil > new Date().toISOString() ? html`
            <div class="pause-banner" role="status">
              Notifications paused until ${this._formatPauseUntil(this._pausedUntil)}.
              <button class="resume-btn" @click=${this._resumeNotifications}>Resume</button>
            </div>
          ` : ''}
          <div class="nav-main">
            <div class="logo">
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
              <button
                class="nav-link ${this.route === 'settings' ? 'active' : ''}"
                aria-label="Settings"
                title="Settings"
                @click=${() => this._navigate('/settings')}
              >⚙️</button>
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
