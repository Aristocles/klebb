// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-diagnostics.js
//
// Settings > Diagnostics pane. Reads /api/diagnostics and surfaces
// the bits that answer "why didn't I get reminded?" - timezone,
// VAPID keyId, per-device subscription health, and the recent_fires
// audit ring from the scheduler.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhSettingsDiagnostics extends LitElement {
  static properties = {
    _loading: { state: true },
    _diag: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this._loading = true;
    this._diag = null;
    this._error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  async _load() {
    this._loading = true;
    try {
      const r = await fetch('/api/diagnostics', { credentials: 'same-origin' });
      if (r.status === 410) {
        this._error = 'Diagnostics are disabled in demo mode.';
      } else if (!r.ok) {
        this._error = 'Could not load diagnostics: ' + r.status;
      } else {
        this._diag = await r.json();
      }
    } catch (e) {
      this._error = e.message || 'Could not load diagnostics.';
    } finally {
      this._loading = false;
    }
  }

  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    h3 {
      font-size: 0.85rem;
      color: var(--text-muted, var(--text-secondary));
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 18px 0 8px;
    }
    .lede {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 14px;
    }
    .panel {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }
    dl.kv {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 6px 12px;
      margin: 0;
      font-size: 13px;
    }
    dl.kv dt {
      color: var(--text-muted, var(--text-secondary));
      font-weight: 600;
    }
    dl.kv dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--text-muted, var(--text-secondary));
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.05em;
    }
    td.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
    td.dead { color: var(--accent-amber, #ffaa33); }
    .empty { padding: 12px; text-align: center; color: var(--text-muted, var(--text-secondary)); font-size: 12px; }
    .error { color: var(--accent-red, #ff5566); font-size: 13px; padding: 12px 0; }
    @media (max-width: 560px) {
      dl.kv { grid-template-columns: 1fr; }
      dl.kv dt { margin-top: 6px; }
    }
  `;

  render() {
    if (this._loading) return html`<h2>Diagnostics</h2><div class="lede">Loading...</div>`;
    if (this._error) return html`<h2>Diagnostics</h2><div class="error">${this._error}</div>`;
    if (!this._diag) return html`<h2>Diagnostics</h2><div class="lede">Nothing to show.</div>`;

    const d = this._diag;
    return html`
      <h2>Diagnostics</h2>
      <div class="lede">Push subscription health, timezone, and recent notification delivery.</div>

      <h3>Server</h3>
      <div class="panel">
        <dl class="kv">
          <dt>Timezone</dt>
          <dd>${d.tz || '(unset)'}</dd>
          <dt>VAPID key id</dt>
          <dd>${d.vapid_key_id}</dd>
          <dt>Quiet hours</dt>
          <dd>${d.quiet_hours ? `${d.quiet_hours.start} - ${d.quiet_hours.end}` : '(off)'}</dd>
          <dt>Paused until</dt>
          <dd>${d.paused_until || '(not paused)'}</dd>
        </dl>
      </div>

      <h3>Subscribed devices</h3>
      <div class="panel">
        ${(d.subscriptions || []).length === 0
          ? html`<div class="empty">No devices subscribed yet.</div>`
          : html`
            <table>
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Nickname</th>
                  <th>UA</th>
                  <th>Last sent</th>
                  <th>Last status</th>
                  <th>Dead</th>
                </tr>
              </thead>
              <tbody>
                ${d.subscriptions.map(s => html`
                  <tr>
                    <td class="mono">${(s.id || '').slice(0, 12)}...</td>
                    <td>${s.nickname || '-'}</td>
                    <td>${s.userAgentSummary || '-'}</td>
                    <td>${s.lastSentAt || '-'}</td>
                    <td>${s.lastStatus ?? '-'}</td>
                    <td class=${s.dead ? 'dead' : ''}>${s.dead ? `since ${s.deadSince}` : 'no'}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
      </div>

      <h3>Recent fires</h3>
      <div class="panel">
        ${(d.recent_fires || []).length === 0
          ? html`<div class="empty">No notifications have fired yet.</div>`
          : html`
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Sent</th>
                  <th>Failed</th>
                  <th>Statuses</th>
                </tr>
              </thead>
              <tbody>
                ${[...d.recent_fires].reverse().map(f => html`
                  <tr>
                    <td class="mono">${f.ts}</td>
                    <td>${f.id}</td>
                    <td>${f.sent}</td>
                    <td>${f.failed}</td>
                    <td class="mono">${(f.statuses || []).join(', ')}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
      </div>
    `;
  }
}
customElements.define('eh-settings-diagnostics', EhSettingsDiagnostics);
