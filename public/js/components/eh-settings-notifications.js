// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-notifications.js
//
// Settings > Notifications pane. Per-card section list with two
// toggles per row (enabled, show-full-text=privacy), global Quiet
// hours + Pause-for chips, status banner across the supported
// permission states (incl. iOS install instructions), empty state
// and the "ask Klebbius" footer note.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import {
  isPushSupported, detectIosInstallNeeded,
  permissionState, getCurrentSubscription,
  enable as pushEnable, disable as pushDisable,
} from '../lib/notification-client.js';

export class EhSettingsNotifications extends LitElement {
  static properties = {
    _loading: { state: true },
    _items: { state: true },
    _quietHours: { state: true },
    _pausedUntil: { state: true },
    _permission: { state: true },
    _subscribed: { state: true },
    _busyId: { state: true },
    _toast: { state: true },
    _iosNeedsInstall: { state: true },
  };

  constructor() {
    super();
    this._loading = true;
    this._items = [];
    this._quietHours = null;
    this._pausedUntil = null;
    this._permission = 'default';
    this._subscribed = false;
    this._busyId = null;
    this._toast = null;
    this._iosNeedsInstall = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._iosNeedsInstall = detectIosInstallNeeded();
    this._refresh();
  }

  async _refresh() {
    this._permission = permissionState();
    if (isPushSupported()) {
      try {
        const sub = await getCurrentSubscription();
        this._subscribed = !!sub;
      } catch { this._subscribed = false; }
    } else {
      this._subscribed = false;
    }
    try {
      const r = await fetch('/api/notifications', { credentials: 'same-origin' });
      if (r.ok) {
        const json = await r.json();
        this._items = Array.isArray(json.notifications) ? json.notifications : [];
        this._quietHours = json.quiet_hours || null;
        this._pausedUntil = json.paused_until || null;
      } else if (r.status === 410) {
        this._items = [];
      }
    } catch {}
    this._loading = false;
  }

  async _onEnable() {
    const result = await pushEnable();
    if (result.ok) {
      this._toast = 'Notifications enabled on this device.';
    } else {
      this._toast = `Couldn't enable: ${result.reason}`;
    }
    setTimeout(() => { this._toast = null; }, 3000);
    await this._refresh();
  }

  async _onDisableDevice() {
    await pushDisable();
    this._toast = 'This device will no longer receive notifications.';
    setTimeout(() => { this._toast = null; }, 3000);
    await this._refresh();
  }

  async _onToggleEnabled(item) {
    if (this._busyId === item.id) return;
    this._busyId = item.id;
    try {
      const r = await fetch('/api/notifications/state', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, enabled: !item.enabled }),
      });
      if (r.ok) {
        // Replace the array reference so Lit picks up the change. In-
        // place mutation + requestUpdate isn't enough when the parent
        // template loops over the same array reference.
        this._items = this._items.map(it =>
          it.id === item.id ? { ...it, enabled: !it.enabled } : it,
        );
      }
    } finally {
      this._busyId = null;
    }
  }

  async _onTogglePrivacy(item) {
    if (this._busyId === item.id + ':privacy') return;
    this._busyId = item.id + ':privacy';
    try {
      const next = item.privacy === 'public' ? 'private' : 'public';
      const r = await fetch('/api/notifications/state', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, privacy: next }),
      });
      if (r.ok) {
        this._items = this._items.map(it =>
          it.id === item.id ? { ...it, privacy: next } : it,
        );
      }
    } finally {
      this._busyId = null;
    }
  }

  async _onQuietHoursChange(field, value) {
    const next = { ...(this._quietHours || { start: '22:00', end: '07:00' }), [field]: value };
    this._quietHours = next;
    await fetch('/api/notifications/global-state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quiet_hours: next }),
    });
  }

  async _clearQuietHours() {
    this._quietHours = null;
    await fetch('/api/notifications/global-state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quiet_hours: null }),
    });
  }

  async _onPauseFor(durationMs) {
    const value = durationMs === null ? null : new Date(Date.now() + durationMs).toISOString();
    this._pausedUntil = value;
    await fetch('/api/notifications/global-state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused_until: value }),
    });
    window.dispatchEvent(new CustomEvent('klebb-notifications-pause-changed'));
  }

  // Compute the next fire time client-side from the trigger spec so the
  // server doesn't have to ship a separate endpoint for it. Daily and
  // weekly only.
  _formatNext(item) {
    const t = item.trigger;
    if (!t || typeof t.time !== 'string') return '';
    const [hh, mm] = t.time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (t.type === 'daily') {
      if (next <= now) next.setDate(next.getDate() + 1);
    } else if (t.type === 'weekly' && Array.isArray(t.days)) {
      const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const target = new Set(t.days.map(d => map[d]).filter(d => d !== undefined));
      let offset = 0;
      while (offset < 8) {
        const candidate = new Date(now);
        candidate.setDate(candidate.getDate() + offset);
        candidate.setHours(hh, mm, 0, 0);
        if (target.has(candidate.getDay()) && candidate > now) {
          return candidate.toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
        }
        offset += 1;
      }
      return '';
    } else {
      return '';
    }
    return next.toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  _formatLast(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }

  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    .lede {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .banner {
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
    }
    .banner.warn {
      border-color: var(--accent-amber, #ffaa33);
      background: var(--accent-amber-bg, rgba(255, 170, 51, 0.1));
    }
    .banner button {
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--accent);
      color: var(--accent-fg, #fff);
      cursor: pointer;
      flex-shrink: 0;
    }
    .banner button.subdued {
      background: transparent;
      color: var(--text-primary);
    }
    .banner ol { margin: 6px 0 0; padding-left: 20px; }
    .banner ol li { margin: 2px 0; }
    .global-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      padding: 10px 14px;
      border-radius: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      margin-bottom: 10px;
      font-size: 13px;
    }
    .global-row label { font-weight: 600; }
    .global-row input[type=time] {
      font: inherit;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input, var(--bg-card));
      color: var(--text-primary);
    }
    .global-row .chip {
      font: inherit;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
    }
    .global-row .chip:hover { border-color: var(--accent); color: var(--accent); }
    .global-row .clear {
      font: inherit;
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      background: transparent;
      border: none;
      cursor: pointer;
      text-decoration: underline;
    }
    .card-section {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-card);
      margin-bottom: 12px;
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      font-weight: 600;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
    }
    .item-row {
      padding: 10px 14px;
      border-top: 1px solid var(--border);
    }
    .item-row:first-of-type { border-top: none; }
    .item-main {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .item-time {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      min-width: 48px;
    }
    .item-label { flex: 1; min-width: 0; font-size: 14px; color: var(--text-primary); overflow-wrap: anywhere; }
    .item-toggles {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .toggle-pair {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
    }
    /* Reserve a slot the busy-dots can occupy without shifting the
       toggle when a saving indicator appears mid-tap. */
    .toggle-pair .busy-slot {
      width: 18px;
      display: inline-flex;
      justify-content: center;
      flex-shrink: 0;
    }
    .toggle {
      appearance: none;
      background: transparent;
      border: none;
      padding: 0;
      margin: 0;
      cursor: pointer;
      /* 44x44 hit target per WCAG 2.5.5 / Apple HIG. The visible
         track is rendered inside as .toggle-track + .toggle-thumb. */
      width: 44px;
      height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .toggle-track {
      width: 36px;
      height: 20px;
      border-radius: 10px;
      background: var(--border);
      position: relative;
      transition: background 0.15s;
      pointer-events: none;
    }
    .toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--bg-card);
      transition: transform 0.15s;
    }
    .toggle[aria-pressed="true"] .toggle-track { background: var(--accent); }
    .toggle[aria-pressed="true"] .toggle-thumb { transform: translateX(16px); }
    .toggle:focus-visible .toggle-track {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .toggle[aria-busy="true"] .toggle-track {
      box-shadow: 0 0 0 2px var(--accent);
    }
    @media (prefers-reduced-motion: reduce) {
      .toggle-track, .toggle-thumb { transition: none; }
    }
    .busy-dots {
      display: inline-flex;
      gap: 2px;
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      align-items: center;
      flex-shrink: 0;
    }
    .busy-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: currentColor;
      animation: busy-dot 1s ease-in-out infinite;
    }
    .busy-dots span:nth-child(2) { animation-delay: 0.15s; }
    .busy-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes busy-dot {
      0%, 80%, 100% { opacity: 0.2; }
      40% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .busy-dots span { animation: none; opacity: 0.6; }
    }
    .privacy-hint {
      display: none;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      margin-top: 6px;
      text-align: right;
      flex-basis: 100%;
    }
    @media (max-width: 560px) {
      .item-toggles {
        flex-basis: 100%;
        justify-content: flex-end;
        gap: 18px;
      }
      .item-main { row-gap: 6px; }
      .privacy-hint { display: block; }
    }
    .item-meta {
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      margin-top: 4px;
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--text-secondary);
      font-size: 13px;
      border: 1px dashed var(--border);
      border-radius: 10px;
    }
    .footer-note {
      margin-top: 16px;
      color: var(--text-muted, var(--text-secondary));
      font-size: 12px;
      text-align: center;
    }
    .toast {
      position: fixed;
      bottom: calc(72px + env(safe-area-inset-bottom, 0px));
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-card);
      border: 1px solid var(--accent);
      color: var(--text-primary);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      max-width: 90vw;
      text-align: center;
    }
    .privacy-help {
      cursor: pointer;
      border-bottom: 1px dotted var(--text-muted, var(--text-secondary));
      user-select: none;
    }
    .privacy-help:hover { color: var(--text-primary); }
  `;

  render() {
    if (this._loading) return html`<div class="lede">Loading...</div>`;

    return html`
      <h2>Notifications</h2>
      <div class="lede">
        Reminders the dashboard pushes to your devices. Toggle individual
        notifications below; declare new ones by asking Klebbius.
      </div>

      ${this._renderBanner()}
      ${this._renderGlobalRow()}
      ${this._renderItems()}

      <p class="footer-note">
        If a notification you want is missing, ask Klebbius to add it.
      </p>

      ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : ''}
    `;
  }

  _renderBanner() {
    if (this._iosNeedsInstall) {
      return html`
        <div class="banner warn">
          <div>
            <div><strong>On iPhone, add Klebb to your Home Screen first.</strong></div>
            <ol>
              <li>Tap the Share button at the bottom of Safari.</li>
              <li>Scroll down and tap "Add to Home Screen".</li>
              <li>Open Klebb from the new icon.</li>
              <li>Come back here and turn notifications on.</li>
            </ol>
          </div>
        </div>
      `;
    }
    if (!isPushSupported()) {
      return html`<div class="banner warn">This browser doesn't support notifications.</div>`;
    }
    if (this._permission === 'denied') {
      return html`
        <div class="banner warn">
          <span>This browser blocked notifications. Re-enable in your browser's site permissions.</span>
        </div>
      `;
    }
    if (this._permission === 'granted' && this._subscribed) {
      return html`
        <div class="banner">
          <span>Notifications are enabled on this device.</span>
          <button class="subdued" @click=${this._onDisableDevice}>Disconnect this device</button>
        </div>
      `;
    }
    // default or granted-but-not-subscribed
    return html`
      <div class="banner">
        <span>Notifications are off in this browser.</span>
        <button @click=${this._onEnable}>Enable</button>
      </div>
    `;
  }

  _renderGlobalRow() {
    const paused = this._pausedUntil && this._pausedUntil > new Date().toISOString();
    return html`
      <div class="global-row">
        <label>Quiet hours</label>
        <input type="time" .value=${(this._quietHours && this._quietHours.start) || '22:00'}
          @change=${(e) => this._onQuietHoursChange('start', e.target.value)}>
        <span>to</span>
        <input type="time" .value=${(this._quietHours && this._quietHours.end) || '07:00'}
          @change=${(e) => this._onQuietHoursChange('end', e.target.value)}>
        ${this._quietHours ? html`<button class="clear" @click=${this._clearQuietHours}>Clear</button>` : ''}
      </div>
      <div class="global-row">
        <label>Pause</label>
        <button class="chip" @click=${() => this._onPauseFor(60 * 60 * 1000)}>1h</button>
        <button class="chip" @click=${() => this._onPauseFor(4 * 60 * 60 * 1000)}>4h</button>
        <button class="chip" @click=${() => this._onPauseFor(24 * 60 * 60 * 1000)}>1 day</button>
        ${paused ? html`<button class="clear" @click=${() => this._onPauseFor(null)}>Resume now</button>` : ''}
      </div>
    `;
  }

  _renderItems() {
    if (!this._items.length) {
      return html`
        <div class="empty">
          No notifications configured. Ask Klebbius to set one up: try
          "remind me to log mood every evening at 8pm".
        </div>
      `;
    }
    // Group by card_id, preserving original order; sort items inside
    // each group by trigger time.
    const groups = new Map();
    for (const it of this._items) {
      if (!groups.has(it.card_id)) groups.set(it.card_id, { card: it, items: [] });
      groups.get(it.card_id).items.push(it);
    }
    for (const g of groups.values()) {
      g.items.sort((a, b) => (a.trigger?.time || '').localeCompare(b.trigger?.time || ''));
    }
    return html`${[...groups.values()].map(g => this._renderCardSection(g))}`;
  }

  _renderCardSection(g) {
    return html`
      <div class="card-section">
        <div class="card-header">
          <span>${g.card.card_emoji || ''}</span>
          <span>${g.card.card_label}</span>
        </div>
        ${g.items.map(item => this._renderItemRow(item))}
      </div>
    `;
  }

  _renderItemRow(item) {
    const next = this._formatNext(item);
    const last = this._formatLast(item.last_fired);
    const enabledBusy = this._busyId === item.id;
    const privacyBusy = this._busyId === item.id + ':privacy';
    const privacyHint = item.privacy === 'public'
      ? 'Lock screen shows the full reminder text.'
      : 'Lock screen says "You have a reminder".';
    return html`
      <div class="item-row">
        <div class="item-main">
          <span class="item-time">${item.trigger?.time || ''}</span>
          <span class="item-label">${item.label}</span>
          <div class="item-toggles">
            <span class="toggle-pair">
              <span class="busy-slot">${enabledBusy ? this._renderBusyDots() : ''}</span>
              <button
                class="toggle"
                data-role="enabled"
                role="switch"
                aria-checked=${item.enabled}
                aria-pressed=${item.enabled}
                aria-busy=${enabledBusy ? 'true' : 'false'}
                aria-label="Toggle ${item.label}"
                @click=${() => this._onToggleEnabled(item)}
              ><span class="toggle-track"><span class="toggle-thumb"></span></span></button>
            </span>
            <span class="toggle-pair" title="When off, the lock screen says 'You have a reminder' and the real text is shown only when you open Klebb.">
              <span class="busy-slot">${privacyBusy ? this._renderBusyDots() : ''}</span>
              <button
                class="toggle"
                data-role="privacy"
                role="switch"
                aria-checked=${item.privacy === 'public'}
                aria-pressed=${item.privacy === 'public'}
                aria-busy=${privacyBusy ? 'true' : 'false'}
                aria-label="Show full text on the lock screen for ${item.label}"
                @click=${() => this._onTogglePrivacy(item)}
              ><span class="toggle-track"><span class="toggle-thumb"></span></span></button>
              <span
                class="privacy-help"
                @click=${() => this._onTogglePrivacy(item)}
              >Show full text</span>
            </span>
            <span class="privacy-hint">${privacyHint}</span>
          </div>
        </div>
        ${(next || last) ? html`
          <div class="item-meta">
            ${next ? html`<span>Next: ${next}</span>` : ''}
            ${next && last ? ' · ' : ''}
            ${last ? html`<span>Last: ${last}</span>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }

  _renderBusyDots() {
    return html`<span class="busy-dots" aria-hidden="true"><span></span><span></span><span></span></span>`;
  }
}
customElements.define('eh-settings-notifications', EhSettingsNotifications);
