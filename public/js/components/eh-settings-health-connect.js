// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>

import { LitElement, html, css } from 'https://esm.sh/lit@3';

const BASE = '/api/connectors/health-connect';
const SCOPE = ['StepsRecord'];

function canonicalHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash && url.origin === value;
  } catch { return false; }
}

function refusal(status) {
  if (status === 401) return 'Sign in to manage Health Connect.';
  if (status === 403) return 'Access denied for this Klebb instance.';
  if (status === 503) return 'Health Connect pairing is temporarily unavailable.';
  return 'Could not manage Health Connect. Try again.';
}

export class EhSettingsHealthConnect extends LitElement {
  static properties = {
    _destination: { state: true },
    _connectors: { state: true },
    _name: { state: true },
    _confirmed: { state: true },
    _grant: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _status: { state: true },
  };

  constructor() {
    super();
    this._destination = '';
    this._connectors = [];
    this._name = 'Android phone';
    this._confirmed = false;
    this._grant = null;
    this._busy = false;
    this._error = '';
    this._status = '';
    this._revision = 0;
    this._controller = null;
    this._expiryTimer = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  disconnectedCallback() {
    this._cancel();
    super.disconnectedCallback();
  }

  _clearGrant() {
    clearTimeout(this._expiryTimer);
    this._expiryTimer = null;
    this._grant = null;
    const field = this.renderRoot.querySelector('textarea');
    if (field) field.value = '';
  }

  _cancel() {
    ++this._revision;
    this._controller?.abort();
    this._controller = null;
    this._clearGrant();
    this._confirmed = false;
    this._busy = false;
    this._error = '';
    this._status = '';
  }

  _start() {
    this._controller?.abort();
    this._controller = new AbortController();
    this._busy = true;
    this._error = '';
    this._status = '';
    return { revision: ++this._revision, controller: this._controller };
  }

  _active(request) {
    return this.isConnected && request.revision === this._revision
      && !request.controller.signal.aborted;
  }

  async _load() {
    if (this._busy) return;
    this._clearGrant();
    this._confirmed = false;
    const request = this._start();
    try {
      const response = await fetch(BASE, {
        cache: 'no-store', redirect: 'error', signal: request.controller.signal,
      });
      if (!this._active(request)) return;
      if (!response.ok) {
        this._destination = '';
        this._connectors = [];
        this._error = refusal(response.status);
        return;
      }
      const result = await response.json();
      if (!this._active(request)) return;
      this._destination = typeof result.destination === 'string' ? result.destination : '';
      this._connectors = Array.isArray(result.connectors) ? result.connectors : [];
      if (!canonicalHttps(this._destination)) {
        this._error = 'Pairing requires a canonical HTTPS destination.';
      }
    } catch {
      if (this._active(request)) {
        this._destination = '';
        this._connectors = [];
        this._error = 'Could not load Health Connect. Refresh to try again.';
      }
    } finally {
      if (this._active(request)) this._busy = false;
    }
  }

  async _create() {
    if (this._busy || !this._confirmed || !canonicalHttps(this._destination)
        || !this._name.trim()) return;
    this._clearGrant();
    const request = this._start();
    try {
      const response = await fetch(`${BASE}/pairing-grants`, {
        method: 'POST', cache: 'no-store', redirect: 'error',
        signal: request.controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: SCOPE, name: this._name.trim() }),
      });
      if (!this._active(request)) return;
      if (!response.ok) {
        this._error = refusal(response.status);
        this._confirmed = false;
        return;
      }
      const grant = await response.json();
      if (!this._active(request)) return;
      const fields = ['version', 'kind', 'destination', 'tenantId', 'instanceId',
        'sourceStoreId', 'restoreEpoch', 'grant', 'expiresAt', 'categories', 'limits'];
      const expiry = Date.parse(grant.expiresAt);
      if (grant.version !== 1 || grant.kind !== 'pairing-grant'
          || grant.destination !== this._destination
          || !/^[A-Za-z0-9_-]{43}$/.test(grant.grant)
          || !Array.isArray(grant.categories) || grant.categories.length !== 1
          || grant.categories[0] !== SCOPE[0]
          || ['tenantId', 'instanceId', 'sourceStoreId', 'restoreEpoch'].some(key =>
            typeof grant[key] !== 'string' || !grant[key])
          || Object.keys(grant).some(key => !fields.includes(key))
          || !Number.isFinite(expiry) || expiry <= Date.now()) {
        this._error = 'The pairing response is invalid or expired. Create a new grant.';
        this._confirmed = false;
        return;
      }
      this._grant = grant;
      this._confirmed = false;
      this._expiryTimer = setTimeout(() => {
        if (!this.isConnected || this._grant !== grant) return;
        this._clearGrant();
        this._confirmed = false;
        this._status = 'Pairing grant expired. Create a new grant.';
      }, Math.min(300000, Math.max(0, expiry - Date.now())));
    } catch {
      if (this._active(request)) {
        this._error = 'Could not create a pairing grant. Try again.';
        this._confirmed = false;
      }
    } finally {
      if (this._active(request)) this._busy = false;
    }
  }

  async _revoke(id) {
    if (this._busy) return;
    this._clearGrant();
    this._confirmed = false;
    const request = this._start();
    try {
      const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'DELETE', cache: 'no-store', redirect: 'error',
        signal: request.controller.signal,
      });
      if (!this._active(request)) return;
      if (!response.ok) { this._error = refusal(response.status); return; }
      const result = await response.json();
      if (!this._active(request)) return;
      if (result.revoked !== true) {
        this._error = 'Could not confirm revocation. Refresh to check access.';
        return;
      }
      this._connectors = this._connectors.map(connector =>
        connector.id === id ? { ...connector, revokedAt: new Date().toISOString() } : connector);
      this._status = 'Access revoked. Saved history is kept.';
    } catch {
      if (this._active(request)) this._error = 'Could not revoke access. Try again.';
    } finally {
      if (this._active(request)) this._busy = false;
    }
  }

  static styles = css`
    :host { display: block; margin-top: 24px; }
    h2 { margin: 0 0 6px; font-size: 1.2rem; color: var(--text-primary); }
    p { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
    .panel { border: 1px solid var(--border); border-radius: 10px; padding: 14px;
      background: var(--bg-card); }
    .hc-destination { display: block; overflow-wrap: anywhere; font-size: 13px;
      color: var(--text-primary); margin-bottom: 14px; }
    label { display: block; font-size: 13px; color: var(--text-primary); margin-bottom: 12px; }
    input[type="text"], textarea { box-sizing: border-box; width: 100%; margin-top: 5px;
      padding: 8px; border: 1px solid var(--border); border-radius: 6px; font: inherit;
      color: var(--text-primary); background: var(--bg-card); }
    .confirmation { display: flex; align-items: flex-start; gap: 8px; }
    textarea { font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px; resize: vertical; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    button { font: inherit; font-size: 12px; padding: 7px 10px; cursor: pointer;
      border: 1px solid var(--border); border-radius: 6px;
      color: var(--text-primary); background: var(--bg-card); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: .5; cursor: default; }
    button:focus-visible, input:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 2px; }
    .hc-connector-row { border-top: 1px solid var(--border); padding-top: 12px;
      margin-top: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .connector-meta { flex: 1; min-width: 160px; font-size: 13px; color: var(--text-primary); }
    .connector-meta small { display: block; color: var(--text-secondary); margin-top: 4px; }
    [role="alert"] { color: var(--danger, #c33); }
  `;

  render() {
    return html`
      <h2>Health Connect</h2>
      <p>Pairing proof: Steps. Confirm the HTTPS destination before creating a one-use grant.</p>
      <div class="panel">
        <code class="hc-destination">${this._destination || 'Loading destination...'}</code>
        <label>Phone name
          <input type="text" aria-label="Phone name" maxlength="60"
            .value=${this._name} ?disabled=${this._busy}
            @input=${event => { this._name = event.target.value; }}>
        </label>
        <label class="confirmation">
          <input type="checkbox" aria-label="Confirm destination"
            .checked=${this._confirmed} ?disabled=${this._busy || !canonicalHttps(this._destination)}
            @change=${event => { this._confirmed = event.target.checked; }}>
          <span>I confirm this is my Klebb instance.</span>
        </label>
        <div class="actions">
          <button class="primary" ?disabled=${this._busy || !this._confirmed
            || !canonicalHttps(this._destination) || !this._name.trim()}
            @click=${this._create}>Create pairing grant</button>
          <button @click=${this._cancel}>Cancel</button>
        </div>
        ${this._grant ? html`
          <p>This grant works once and expires at ${this._grant.expiresAt}.</p>
          <label>Health Connect pairing payload
            <textarea aria-label="Health Connect pairing payload" readonly rows="9"
              .value=${JSON.stringify(this._grant, null, 2)}></textarea>
          </label>
        ` : ''}
        ${this._error ? html`<p role="alert">${this._error}</p>` : ''}
        ${this._status ? html`<p role="status">${this._status}</p>` : ''}
        <button ?disabled=${this._busy} @click=${this._load}>Refresh connected devices</button>
        ${this._connectors.map(connector => html`
          <div class="hc-connector-row">
            <div class="connector-meta">
              ${connector.name || 'Android phone'}
              <small>${Array.isArray(connector.categories) ? connector.categories.join(', ') : ''}
                ${connector.revokedAt ? ' · Revoked' : ' · Active'}</small>
            </div>
            <button ?disabled=${this._busy || !!connector.revokedAt}
              @click=${() => this._revoke(connector.id)}>Revoke access</button>
          </div>
        `)}
      </div>
    `;
  }
}

customElements.define('eh-settings-health-connect', EhSettingsHealthConnect);
