// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-connections.js
//
// Settings > Connections pane. External integrations: Health Auto Export
// (endpoint, token, last push diagnostics) and the hidden-metric
// discovery list. Future home for any other inbound-data integration.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { errorFromResponse } from '../lib/save-error.js';

export class EhSettingsConnections extends LitElement {
  static properties = {
    _hiddenDiscoveries: { state: true },
    _busyMetric: { state: true },
    _haeStatus: { state: true },
    _haeLastPushExpanded: { state: true },
    _haeCopied: { state: true },
    _haeToken: { state: true },
    _haeTokenLoaded: { state: true },
    _haeTokenLastRegeneratedAt: { state: true },
    _haeTokenReveal: { state: true },
    _haeTokenCopied: { state: true },
    _haeTokenBusy: { state: true },
    _haeRegenConfirm: { state: true },
    _haeTokenError: { state: true },
  };

  constructor() {
    super();
    this._hiddenDiscoveries = [];
    this._busyMetric = null;
    this._haeStatus = null;
    this._haeLastPushExpanded = false;
    this._haeCopied = false;
    this._haeToken = null;
    this._haeTokenLoaded = false;
    this._haeTokenLastRegeneratedAt = null;
    this._haeTokenReveal = false;
    this._haeTokenCopied = false;
    this._haeTokenBusy = false;
    this._haeRegenConfirm = false;
    this._haeTokenError = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadHiddenDiscoveries();
    this._loadHaeStatus();
    this._loadHaeToken();
  }

  async _loadHaeStatus() {
    try {
      const r = await fetch('/api/health-auto-export/status');
      if (!r.ok) return;
      this._haeStatus = await r.json();
    } catch {}
  }

  async _writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
  }

  async _copyEndpoint() {
    if (!this._haeStatus?.endpointUrl) return;
    await this._writeClipboard(this._haeStatus.endpointUrl);
    this._haeCopied = true;
    setTimeout(() => { this._haeCopied = false; }, 1800);
  }

  async _loadHaeToken() {
    try {
      const r = await fetch('/api/health-auto-export/token');
      if (!r.ok) {
        this._haeToken = null;
        this._haeTokenLastRegeneratedAt = null;
        this._haeTokenLoaded = true;
        return;
      }
      const j = await r.json();
      this._haeToken = j.token || null;
      this._haeTokenLastRegeneratedAt = j.lastRegeneratedAt || null;
      this._haeTokenLoaded = true;
    } catch {
      this._haeTokenLoaded = true;
    }
  }

  async _generateHaeToken() {
    if (this._haeTokenBusy) return;
    this._haeTokenBusy = true;
    this._haeTokenError = null;
    try {
      const r = await fetch('/api/health-auto-export/token', { method: 'POST' });
      if (!r.ok) {
        this._haeTokenError = await errorFromResponse(r, 'Could not generate token.');
        return;
      }
      const j = await r.json();
      this._haeToken = j.token;
      this._haeTokenLastRegeneratedAt = j.lastRegeneratedAt || null;
      this._haeTokenReveal = true;
      this._loadHaeStatus();
      setTimeout(() => { this._haeTokenReveal = false; }, 8000);
    } catch (e) {
      this._haeTokenError = e?.message || 'Could not generate token.';
    } finally {
      this._haeTokenBusy = false;
    }
  }

  _askRegenerateHae() {
    this._haeRegenConfirm = true;
    this._haeTokenError = null;
  }

  _cancelRegenerateHae() {
    this._haeRegenConfirm = false;
  }

  async _confirmRegenerateHae() {
    if (this._haeTokenBusy) return;
    this._haeTokenBusy = true;
    this._haeTokenError = null;
    try {
      const r = await fetch('/api/health-auto-export/token/regenerate', { method: 'POST' });
      if (!r.ok) {
        this._haeTokenError = await errorFromResponse(r, 'Could not regenerate token.');
        return;
      }
      const j = await r.json();
      this._haeToken = j.token;
      this._haeTokenLastRegeneratedAt = j.lastRegeneratedAt || null;
      this._haeRegenConfirm = false;
      this._haeTokenReveal = true;
      setTimeout(() => { this._haeTokenReveal = false; }, 8000);
    } catch (e) {
      this._haeTokenError = e?.message || 'Could not regenerate token.';
    } finally {
      this._haeTokenBusy = false;
    }
  }

  async _copyHaeToken() {
    if (!this._haeToken) return;
    await this._writeClipboard(this._haeToken);
    this._haeTokenCopied = true;
    setTimeout(() => { this._haeTokenCopied = false; }, 1800);
  }

  _maskToken(token) {
    if (!token) return '';
    const tail = token.slice(-4);
    return '•'.repeat(28) + tail;
  }

  _toggleLastPushDetail() {
    this._haeLastPushExpanded = !this._haeLastPushExpanded;
  }

  async _loadHiddenDiscoveries() {
    try {
      const r = await fetch('/api/health-auto-export/discoveries');
      if (!r.ok) return;
      const body = await r.json();
      this._hiddenDiscoveries = Array.isArray(body.dismissed) ? body.dismissed : [];
    } catch {}
  }

  async _unhideDiscovery(metric) {
    this._busyMetric = metric;
    try {
      const r = await fetch(
        `/api/health-auto-export/discoveries/${encodeURIComponent(metric)}/unhide`,
        { method: 'POST' });
      if (r.ok) {
        this._hiddenDiscoveries = this._hiddenDiscoveries.filter(d => d.metric !== metric);
      }
    } finally {
      this._busyMetric = null;
    }
  }

  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    h2.subsequent { margin-top: 24px; }
    .lede {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .lede a {
      color: var(--accent);
      text-decoration: underline;
    }
    .discovery-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 20px;
    }
    .discovery-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
    }
    .discovery-label {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 13px;
      color: var(--text-primary);
    }
    .unhide-btn {
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
    }
    .unhide-btn:hover:not(:disabled) {
      border-color: var(--accent);
      color: var(--accent);
    }
    .unhide-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .hae-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-card);
      margin-bottom: 20px;
    }
    .hae-row {
      display: flex;
      align-items: baseline;
      gap: 10px;
      font-size: 13px;
      flex-wrap: wrap;
    }
    .hae-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted, var(--text-secondary));
      min-width: 80px;
    }
    .hae-endpoint {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      flex: 1;
      min-width: 0;
      flex-wrap: wrap;
    }
    .endpoint-code {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      background: var(--bg-input, rgba(0, 0, 0, 0.04));
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--text-primary);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .copy-btn {
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
      flex-shrink: 0;
    }
    .copy-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .hae-token-empty,
    .hae-token-value {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      flex: 1;
      min-width: 0;
      flex-wrap: wrap;
    }
    .hae-token-meta {
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      flex-basis: 100%;
    }
    .hae-token-error {
      font-size: 11px;
      color: var(--accent-red, #ff5566);
      flex-basis: 100%;
    }
    .copy-btn.primary {
      background: var(--accent, #4488ff);
      color: var(--accent-fg, #fff);
      border-color: var(--accent, #4488ff);
    }
    .copy-btn.primary:hover {
      filter: brightness(1.05);
    }
    .copy-btn.danger {
      background: var(--accent-amber, #ffaa33);
      color: #1a1a1a;
      border-color: var(--accent-amber, #ffaa33);
    }
    .copy-btn.danger:hover {
      filter: brightness(1.05);
    }
    .hae-regen-confirm {
      display: inline-flex;
      flex: 1;
      min-width: 0;
    }
    .hae-regen-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      border: 1px solid var(--accent-amber, #ffaa33);
      border-radius: 8px;
      background: var(--accent-amber-bg, rgba(255, 170, 51, 0.10));
      flex: 1;
    }
    .hae-regen-warning {
      font-size: 12px;
      color: var(--text-primary);
      line-height: 1.4;
    }
    .hae-regen-actions {
      display: inline-flex;
      gap: 8px;
    }
    .hae-lastpush {
      display: inline-flex;
      gap: 8px;
      align-items: baseline;
      flex-wrap: wrap;
      color: var(--text-primary);
    }
    .muted { color: var(--text-muted, var(--text-secondary)); font-style: italic; }
    .warn-pill {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      background: var(--accent-amber-bg, rgba(255, 170, 51, 0.15));
      color: var(--accent-amber, #ffaa33);
      font-weight: 600;
    }
    .hae-detail-row {
      margin-top: 2px;
    }
    .detail-toggle {
      font: inherit;
      font-size: 12px;
      padding: 2px 0;
      background: transparent;
      border: none;
      color: var(--accent);
      cursor: pointer;
    }
    .detail-toggle:hover { text-decoration: underline; }
    .hae-detail {
      margin-top: 6px;
      padding: 10px 12px;
      background: var(--bg-input, rgba(0, 0, 0, 0.02));
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 12px;
    }
    .detail-list {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 6px 12px;
      margin: 0;
    }
    .detail-list dt {
      font-weight: 600;
      color: var(--text-muted, var(--text-secondary));
    }
    .detail-list dd {
      margin: 0;
      color: var(--text-primary);
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .sub-list, .warn-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .sub-list code {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
    }
    .sub-note { color: var(--text-muted, var(--text-secondary)); margin-left: 4px; }
    .metric-tag-list {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      color: var(--text-primary);
    }
    .warn-list li {
      color: var(--accent-amber, #ffaa33);
      font-family: ui-monospace, Menlo, Consolas, monospace;
    }
    @media (max-width: 560px) {
      .detail-list {
        grid-template-columns: 1fr;
        gap: 2px 0;
      }
      .detail-list dt { margin-top: 6px; }
    }
  `;

  render() {
    return html`
      ${this._renderHaePanel()}
      ${this._hiddenDiscoveries.length > 0 ? html`
        <h2 class="subsequent">Hidden Apple Health metrics</h2>
        <div class="lede">
          Metrics you've dismissed from the discovery prompt. Un-hide to see
          them again the next time a push arrives.
        </div>
        <div class="discovery-list">
          ${this._hiddenDiscoveries.map(d => html`
            <div class="discovery-row">
              <span class="discovery-label">${d.metric}</span>
              <button
                class="unhide-btn"
                ?disabled=${this._busyMetric === d.metric}
                @click=${() => this._unhideDiscovery(d.metric)}
              >Un-hide</button>
            </div>
          `)}
        </div>
      ` : ''}
    `;
  }

  _renderHaePanel() {
    if (!this._haeStatus) return '';
    const s = this._haeStatus;
    const lp = s.lastPush;
    return html`
      <h2>Health Auto Export</h2>
      <div class="lede">
        Push iPhone health data into Klebb via the Health Auto Export app.
        <a href="https://github.com/Aristocles/klebb/blob/main/docs/HEALTH-AUTO-EXPORT.md" target="_blank" rel="noopener">Setup guide →</a>
      </div>
      <div class="hae-panel">
        <div class="hae-row">
          <span class="hae-label">Endpoint</span>
          <span class="hae-endpoint">
            <code class="endpoint-code">${s.endpointUrl}</code>
            <button
              class="copy-btn"
              @click=${this._copyEndpoint}
              aria-label="Copy endpoint URL"
            >${this._haeCopied ? 'Copied ✓' : 'Copy'}</button>
          </span>
        </div>
        <div class="hae-row">
          <span class="hae-label">Token</span>
          ${this._renderHaeTokenRow()}
        </div>
        <div class="hae-row">
          <span class="hae-label">Last push</span>
          <span class="hae-lastpush">
            ${this._renderLastPushSummary(lp)}
          </span>
        </div>
        ${lp ? html`
          <div class="hae-detail-row">
            <button
              class="detail-toggle"
              @click=${this._toggleLastPushDetail}
              aria-expanded=${this._haeLastPushExpanded}
            >${this._haeLastPushExpanded ? 'Hide detail ▲' : 'Show detail ▼'}</button>
          </div>
          ${this._haeLastPushExpanded ? html`
            <div class="hae-detail">${this._renderLastPushDetail(lp)}</div>
          ` : ''}
        ` : ''}
      </div>
    `;
  }

  _renderHaeTokenRow() {
    if (!this._haeTokenLoaded) {
      return html`<span class="muted">Loading…</span>`;
    }

    if (this._haeRegenConfirm) {
      return html`
        <span class="hae-regen-confirm">
          <span class="hae-regen-body">
            <span class="hae-regen-warning">
              ⚠ Regenerating will invalidate the current token. You'll need
              to update your iPhone Health Auto Export configuration with
              the new token before the next push will be accepted.
            </span>
            <span class="hae-regen-actions">
              <button
                class="copy-btn"
                @click=${this._cancelRegenerateHae}
                ?disabled=${this._haeTokenBusy}
              >Cancel</button>
              <button
                class="copy-btn danger"
                @click=${this._confirmRegenerateHae}
                ?disabled=${this._haeTokenBusy}
              >Yes, regenerate</button>
            </span>
            ${this._haeTokenError ? html`<span class="hae-token-error">${this._haeTokenError}</span>` : ''}
          </span>
        </span>
      `;
    }

    if (!this._haeToken) {
      return html`
        <span class="hae-token-empty">
          <button
            class="copy-btn primary"
            @click=${this._generateHaeToken}
            ?disabled=${this._haeTokenBusy}
          >${this._haeTokenBusy ? 'Generating…' : 'Generate token'}</button>
          <span class="hae-token-meta">
            Klebb will generate a long random token. Paste it into your
            iPhone Health Auto Export app's Authorization header.
          </span>
          ${this._haeTokenError ? html`<span class="hae-token-error">${this._haeTokenError}</span>` : ''}
        </span>
      `;
    }

    const display = this._haeTokenReveal
      ? this._haeToken
      : this._maskToken(this._haeToken);

    return html`
      <span class="hae-token-value">
        <code class="endpoint-code">${display}</code>
        <button
          class="copy-btn"
          @click=${this._copyHaeToken}
          aria-label="Copy token"
        >${this._haeTokenCopied ? 'Copied ✓' : 'Copy'}</button>
        <button
          class="copy-btn"
          @click=${this._askRegenerateHae}
          ?disabled=${this._haeTokenBusy}
        >Regenerate</button>
        ${this._haeTokenLastRegeneratedAt ? html`
          <span class="hae-token-meta">
            Last generated: ${this._formatTimestamp(this._haeTokenLastRegeneratedAt)}
          </span>
        ` : ''}
        ${this._haeTokenError ? html`<span class="hae-token-error">${this._haeTokenError}</span>` : ''}
      </span>
    `;
  }

  _formatTimestamp(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const yr = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${yr}-${mo}-${da} ${hh}:${mm}`;
    } catch {
      return iso;
    }
  }

  _renderLastPushSummary(lp) {
    if (!lp) return html`<span class="muted">Nothing received yet</span>`;
    const rowsTotal = (lp.subscribers || [])
      .reduce((acc, s) => acc + (s.rowsWritten || 0), 0);
    const subsWithRows = (lp.subscribers || [])
      .filter(s => s.rowsWritten > 0).length;
    const ago = this._relativeTime(lp.receivedAt);
    const hasWarnings = Array.isArray(lp.warnings) && lp.warnings.length > 0;
    return html`
      <span>${rowsTotal} ${rowsTotal === 1 ? 'row' : 'rows'}
             across ${subsWithRows} ${subsWithRows === 1 ? 'card' : 'cards'},
             ${ago}</span>
      ${hasWarnings ? html`<span class="warn-pill">${lp.warnings.length} warning${lp.warnings.length === 1 ? '' : 's'}</span>` : ''}
    `;
  }

  _renderLastPushDetail(lp) {
    return html`
      <dl class="detail-list">
        <dt>Received at</dt>
        <dd>${lp.receivedAt}</dd>
        <dt>Payload size</dt>
        <dd>${this._formatBytes(lp.payloadBytes)}</dd>
        <dt>Subscribers</dt>
        <dd>
          ${lp.subscribers && lp.subscribers.length
            ? html`<ul class="sub-list">
                ${lp.subscribers.map(s => html`
                  <li>
                    <code>${s.id}</code>
                    <span class="muted"> ← ${s.metric}</span>:
                    <strong>${s.rowsWritten} ${s.rowsWritten === 1 ? 'row' : 'rows'}</strong>
                    ${s.note ? html`<span class="sub-note">(${s.note})</span>` : ''}
                  </li>
                `)}
              </ul>`
            : html`<span class="muted">none</span>`}
        </dd>
        <dt>Available but unsubscribed</dt>
        <dd>
          ${lp.availableUnsubscribed && lp.availableUnsubscribed.length
            ? html`<code class="metric-tag-list">${lp.availableUnsubscribed.join(', ')}</code>`
            : html`<span class="muted">none</span>`}
        </dd>
        ${lp.warnings && lp.warnings.length ? html`
          <dt>Warnings</dt>
          <dd>
            <ul class="warn-list">
              ${lp.warnings.map(w => html`<li>${w}</li>`)}
            </ul>
          </dd>
        ` : ''}
      </dl>
    `;
  }

  _relativeTime(iso) {
    try {
      const then = new Date(iso).getTime();
      if (!Number.isFinite(then)) return iso;
      const diff = Date.now() - then;
      const s = Math.round(diff / 1000);
      if (s < 60) return 'just now';
      const m = Math.round(s / 60);
      if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
      const h = Math.round(m / 60);
      if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
      const d = Math.round(h / 24);
      return `${d} day${d === 1 ? '' : 's'} ago`;
    } catch {
      return iso;
    }
  }

  _formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }
}
customElements.define('eh-settings-connections', EhSettingsConnections);
