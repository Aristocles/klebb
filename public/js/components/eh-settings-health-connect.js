// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import {
  DASHBOARD_METRICS, dashboardCards, dashboardSources, makeDisplaySelection,
  saveDashboardSelection,
} from '../lib/health-connect-dashboard-setup.js';

const BASE = '/api/connectors/health-connect';
const SCOPE = ['WeightRecord', 'StepsRecord'];

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
    _weightSelected: { state: true },
    _stepsSelected: { state: true },
    _grant: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _status: { state: true },
    _dashboardSources: { state: true },
    _dashboardCards: { state: true },
    _dashboardType: { state: true },
    _dashboardCardId: { state: true },
    _dashboardSourceKey: { state: true },
    _displayDate: { state: true },
    _displayTimeZone: { state: true },
    _dashboardBusy: { state: true },
    _dashboardError: { state: true },
    _dashboardStatus: { state: true },
  };

  constructor() {
    super();
    this._destination = '';
    this._connectors = [];
    this._name = 'Android phone';
    this._confirmed = false;
    this._weightSelected = false;
    this._stepsSelected = true;
    this._grant = null;
    this._busy = false;
    this._error = '';
    this._status = '';
    this._revision = 0;
    this._controller = null;
    this._expiryTimer = null;
    this._dashboardSources = [];
    this._dashboardCards = [];
    this._dashboardType = 'WeightRecord';
    this._dashboardCardId = '';
    this._dashboardSourceKey = '';
    this._displayDate = '';
    this._displayTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this._dashboardBusy = false;
    this._dashboardError = '';
    this._dashboardStatus = '';
    this._dashboardRevision = 0;
    this._dashboardController = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
    this._loadDashboard();
  }

  disconnectedCallback() {
    this._cancel();
    ++this._dashboardRevision;
    this._dashboardController?.abort();
    this._dashboardController = null;
    this._dashboardBusy = false;
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
    const categories = SCOPE.filter(type => type === 'WeightRecord'
      ? this._weightSelected === true : this._stepsSelected === true);
    if (this._busy || !this._confirmed || !canonicalHttps(this._destination)
        || !this._name.trim() || categories.length === 0) return;
    this._clearGrant();
    const request = this._start();
    try {
      const response = await fetch(`${BASE}/pairing-grants`, {
        method: 'POST', cache: 'no-store', redirect: 'error',
        signal: request.controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories, name: this._name.trim() }),
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
          || !Array.isArray(grant.categories) || grant.categories.length !== categories.length
          || new Set(grant.categories).size !== categories.length
          || grant.categories.some(type => !categories.includes(type))
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

  _sourceKey(source) {
    return JSON.stringify([source.tenantId, source.sourceStoreId, source.recordType, source.dataOrigin]);
  }

  _dashboardRequest() {
    this._dashboardController?.abort();
    this._dashboardController = new AbortController();
    this._dashboardBusy = true;
    this._dashboardError = '';
    this._dashboardStatus = '';
    return { revision: ++this._dashboardRevision, controller: this._dashboardController };
  }

  _dashboardActive(request) {
    return this.isConnected && request.revision === this._dashboardRevision
      && !request.controller.signal.aborted;
  }

  _selectDashboardCard(id) {
    this._dashboardCardId = id;
    this._dashboardSourceKey = '';
    this._displayDate = '';
    this._dashboardError = '';
    this._dashboardStatus = '';
    const choice = this._dashboardCards.find(card => card.id === id)?.meta?.healthConnectDisplay;
    if (!choice || choice.recordType !== this._dashboardType) return;
    const source = this._dashboardSources.find(value =>
      ['tenantId', 'sourceStoreId', 'recordType', 'dataOrigin'].every(key => value[key] === choice[key]));
    if (source) this._dashboardSourceKey = this._sourceKey(source);
    this._displayDate = choice.switchDate;
    this._displayTimeZone = choice.timeZone;
    this._dashboardStatus = source ? 'The saved display choice is shown below.'
      : 'This card has a saved choice. Refresh or choose an available source to change it.';
  }

  _selectDashboardType(type) {
    this._dashboardType = type;
    this._selectDashboardCard(dashboardCards(this._dashboardCards, type)[0]?.id || '');
  }

  async _loadDashboard() {
    if (this._dashboardBusy) return;
    const request = this._dashboardRequest();
    const options = {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: request.controller.signal,
    };
    try {
      const responses = await Promise.all([
        fetch(`${BASE}/dashboard-sources`, options), fetch('/api/manifests', options),
      ]);
      if (!this._dashboardActive(request)) return;
      if (responses.some(response => !response.ok)) {
        throw new Error(responses.some(response => response.status === 401)
          ? 'Sign in to set up the dashboard.'
          : 'Could not load saved sources and cards. Refresh to try again.');
      }
      const [sources, manifests] = await Promise.all(responses.map(response => response.json()));
      if (!this._dashboardActive(request)) return;
      this._dashboardSources = SCOPE.flatMap(type => dashboardSources(sources, type));
      if (!Array.isArray(manifests.entries)) throw new Error('Could not confirm the available cards.');
      this._dashboardCards = manifests.entries;
      const available = dashboardCards(this._dashboardCards, this._dashboardType);
      this._selectDashboardCard(available.some(card => card.id === this._dashboardCardId)
        ? this._dashboardCardId : available[0]?.id || '');
    } catch (error) {
      if (this._dashboardActive(request)) {
        this._dashboardSources = [];
        this._dashboardError = error.message || 'Could not load dashboard setup.';
      }
    } finally {
      if (this._dashboardActive(request)) this._dashboardBusy = false;
    }
  }

  async _saveDashboard() {
    if (this._dashboardBusy) return;
    const source = this._dashboardSources.find(value => this._sourceKey(value) === this._dashboardSourceKey);
    let selection;
    try { selection = makeDisplaySelection(source, this._displayDate, this._displayTimeZone.trim()); }
    catch (error) { this._dashboardError = error.message; return; }
    const request = this._dashboardRequest();
    let created = false;
    let saved = false;
    try {
      const entry = await saveDashboardSelection({
        cardId: this._dashboardCardId, recordType: this._dashboardType, selection,
        signal: request.controller.signal,
        onCreated: id => {
          if (!this._dashboardActive(request)) return;
          created = true;
          this._dashboardCardId = id;
          this._dashboardCards = [...this._dashboardCards, { id, meta: {
            label: DASHBOARD_METRICS[this._dashboardType].label,
            ingest: { source: 'hae', metric: DASHBOARD_METRICS[this._dashboardType].metric },
          } }];
        },
      });
      if (!this._dashboardActive(request)) return;
      saved = true;
      this._dashboardCards = this._dashboardCards.map(card => card.id === entry.id ? entry : card);
      const label = DASHBOARD_METRICS[this._dashboardType].label;
      this._dashboardStatus = entry.projection?.state === 'saved'
        ? `${label} display choice saved. Saved data is shown for the selected source.`
        : entry.projection?.state === 'pending'
          ? `${label} display choice saved. Captured data is pending.`
          : `${label} display choice saved. Refresh the dashboard to check saved data.`;
    } catch (error) {
      if (this._dashboardActive(request)) {
        this._dashboardError = error.message || 'Could not save the dashboard choice.';
        if (created) this._dashboardStatus = 'The card was created. Retry uses this card; its display choice is not confirmed.';
      }
    } finally {
      if (this._dashboardActive(request)) {
        this._dashboardBusy = false;
        if (created || saved) window.dispatchEvent(new CustomEvent('klebb-cards-changed'));
      }
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
    .dashboard { margin-top: 24px; }
    .dashboard input, .dashboard select { box-sizing: border-box; width: 100%; margin-top: 5px;
      padding: 8px; border: 1px solid var(--border); border-radius: 6px; font: inherit;
      color: var(--text-primary); background: var(--bg-card); min-height: 44px; }
    .dashboard button { min-height: 44px; }
    .dashboard input, .dashboard select { font-size: 16px; }
    select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `;

  _renderDashboard() {
    const metric = DASHBOARD_METRICS[this._dashboardType];
    const cards = dashboardCards(this._dashboardCards, this._dashboardType);
    const sources = this._dashboardSources.filter(source => source.recordType === this._dashboardType);
    return html`
      <section class="dashboard" aria-label="Health Connect dashboard setup">
        <h2>Dashboard display</h2>
        <p>On your phone, save the display date. Copy that date here and choose its timezone.
          This selects the dashboard view; it does not start capture. Existing history is kept.</p>
        <div class="panel">
          <label>Display metric
            <select aria-label="Display metric" .value=${this._dashboardType}
              ?disabled=${this._dashboardBusy}
              @change=${event => this._selectDashboardType(event.target.value)}>
              <option value="WeightRecord">Weight</option>
              <option value="StepsRecord">Steps</option>
            </select>
          </label>
          <label>Dashboard card
            <select aria-label="Dashboard card" .value=${this._dashboardCardId}
              ?disabled=${this._dashboardBusy}
              @change=${event => this._selectDashboardCard(event.target.value)}>
              <option value="" .selected=${!this._dashboardCardId}>Create a new ${metric.label} card</option>
              ${cards.map(card => html`<option value=${card.id}
                .selected=${this._dashboardCardId === card.id}>${card.meta?.label || card.id}</option>`)}
            </select>
          </label>
          <label>Captured source and app
            <select aria-label="Captured source and app" .value=${this._dashboardSourceKey}
              ?disabled=${this._dashboardBusy || sources.length === 0}
              @change=${event => { this._dashboardSourceKey = event.target.value;
                this._dashboardError = ''; this._dashboardStatus = ''; }}>
              <option value="" .selected=${!this._dashboardSourceKey}>Choose a saved source and app</option>
              ${sources.map((source, index) => html`
                <option value=${this._sourceKey(source)}
                  .selected=${this._dashboardSourceKey === this._sourceKey(source)}>${source.dataOrigin} · Source ${index + 1}</option>
              `)}
            </select>
          </label>
          ${!this._dashboardBusy && sources.length === 0 && !this._dashboardError ? html`
            <p>Save a ${metric.label} capture before choosing its source. Refresh after capture.</p>
          ` : ''}
          <label>Phone display date
            <input type="date" aria-label="Phone display date" .value=${this._displayDate}
              ?disabled=${this._dashboardBusy}
              @input=${event => { this._displayDate = event.target.value;
                this._dashboardStatus = ''; }}>
          </label>
          <label>Display timezone
            <input type="text" aria-label="Display timezone" .value=${this._displayTimeZone}
              ?disabled=${this._dashboardBusy} placeholder="UTC" maxlength="80"
              @input=${event => { this._displayTimeZone = event.target.value;
                this._dashboardStatus = ''; }}>
          </label>
          <div class="actions">
            <button class="primary" ?disabled=${this._dashboardBusy || !this._dashboardSourceKey
              || !this._displayDate || !this._displayTimeZone.trim()}
              @click=${this._saveDashboard}>Save ${metric.label} display</button>
            <button ?disabled=${this._dashboardBusy} @click=${this._loadDashboard}>Refresh saved sources and cards</button>
          </div>
          ${this._dashboardError ? html`<p role=${this._error ? 'note' : 'alert'}>${this._dashboardError}</p>` : ''}
          ${this._dashboardStatus ? html`<p role="status">${this._dashboardStatus}</p>` : ''}
        </div>
      </section>
    `;
  }

  render() {
    return html`
      <h2>Health Connect</h2>
      <p>Choose Weight and Steps for pairing. Confirm the HTTPS destination before creating a one-use grant.</p>
      <div class="panel">
        <code class="hc-destination">${this._destination || 'Loading destination...'}</code>
        <label>Phone name
          <input type="text" aria-label="Phone name" maxlength="60"
            .value=${this._name} ?disabled=${this._busy}
            @input=${event => { this._name = event.target.value; }}>
        </label>
        <label><input type="checkbox" aria-label="Weight"
          .checked=${this._weightSelected} ?disabled=${this._busy}
          @change=${event => { this._clearGrant(); this._confirmed = false;
            this._weightSelected = event.target.checked; }}> Weight</label>
        <label><input type="checkbox" aria-label="Steps"
          .checked=${this._stepsSelected} ?disabled=${this._busy}
          @change=${event => { this._clearGrant(); this._confirmed = false;
            this._stepsSelected = event.target.checked; }}> Steps</label>
        <label class="confirmation">
          <input type="checkbox" aria-label="Confirm destination"
            .checked=${this._confirmed} ?disabled=${this._busy || !canonicalHttps(this._destination)}
            @change=${event => { this._confirmed = event.target.checked; }}>
          <span>I confirm this is my Klebb instance.</span>
        </label>
        <div class="actions">
          <button class="primary" ?disabled=${this._busy || !this._confirmed
            || !canonicalHttps(this._destination) || !this._name.trim()
            || (!this._weightSelected && !this._stepsSelected)}
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
      ${this._renderDashboard()}
    `;
  }
}

customElements.define('eh-settings-health-connect', EhSettingsHealthConnect);
