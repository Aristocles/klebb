// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-data.js
//
// Settings > Data pane. Two sections: export (a plain anchor to
// /api/export; the browser's own download handling does the rest) and the
// import wizard, a small client state machine mirroring the server's
// (routes/data.js): pick a zip, upload with real progress, preview the
// plan, confirm destruction on a populated instance, apply, report.
//
// Apply and rollback answer 202 immediately and the pipeline runs detached
// on the server (#633: a blocking apply outlived proxy response ceilings, so
// the user saw an error while the import quietly succeeded). The component
// polls GET /api/import/status until the job settles, rendering the current
// stage; a page that loads while a job is applying lands straight in the
// progress view from status alone. The confirmNonce is served exactly once
// (on whichever start/status response first carries it) and held in
// component state; re-fetching status for it would come back empty and
// dead-end the Apply button.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

const CONFIRM_WORD = 'REPLACE';
const POLL_INTERVAL_MS = 1500;
// A transient network blip keeps polling; this many consecutive failures
// means the instance is genuinely unreachable and honesty beats a spinner.
const MAX_POLL_FAILURES = 10;

const STAGE_LABELS = {
  snapshot: 'Saving a rollback snapshot',
  wipe: 'Clearing this instance',
  copy: 'Copying the archive in',
  drain: 'Importing history',
  import: 'Importing cards',
  reload: 'Reloading',
  verify: 'Verifying',
  sweep: 'Tidying up',
};

export class EhSettingsData extends LitElement {
  static properties = {
    _phase: { state: true },
    _demo: { state: true },
    _snapshot: { state: true },
    _hasNonce: { state: true },
    _confirmText: { state: true },
    _uploadPct: { state: true },
    _error: { state: true },
    _canRetry: { state: true },
    _exportBusy: { state: true },
  };

  constructor() {
    super();
    this._phase = 'loading';
    this._demo = false;
    this._snapshot = null;
    this._nonce = null;
    this._hasNonce = false;
    this._confirmText = '';
    this._uploadPct = null;
    this._error = null;
    this._canRetry = false;
    this._exportBusy = false;
    this._lastFile = null;
    this._retryFn = null;
    this._polling = false;
    this._pollFailures = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this._refreshStatus();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._polling = false;
  }

  async _refreshStatus() {
    this._error = null;
    try {
      const r = await fetch('/api/import/status');
      if (r.status === 403) { this._demo = true; return; }
      if (!r.ok) {
        await this._surfaceError(r, () => this._refreshStatus());
        this._phase = 'idle';
        return;
      }
      this._applySnapshot(await r.json());
    } catch {
      this._error = 'Could not reach the instance.';
      this._retryFn = () => this._refreshStatus();
      this._canRetry = true;
      this._phase = 'idle';
    }
  }

  _applySnapshot(snap) {
    this._snapshot = snap;
    if (snap.confirmNonce) {
      this._nonce = snap.confirmNonce;
      this._hasNonce = true;
    }
    switch (snap.state) {
      case 'idle': this._phase = 'idle'; break;
      case 'awaiting-confirm': this._phase = 'awaiting-confirm'; break;
      case 'done': this._phase = 'done'; break;
      case 'failed': this._phase = 'failed'; break;
      case 'applying':
      case 'verifying':
        // A fresh page load mid-job lands here too: the progress view and
        // the poll loop come from status alone, no local history needed.
        this._phase = 'applying';
        this._startPolling();
        break;
      default: this._phase = 'in-progress';
    }
  }

  _startPolling() {
    if (this._polling) return;
    this._polling = true;
    this._pollFailures = 0;
    this._pollLoop();
  }

  // One chained loop, never overlapping fetches. Ends when the job settles
  // (done/failed/idle), when the component leaves the DOM, or when the
  // instance has been unreachable for MAX_POLL_FAILURES polls running.
  async _pollLoop() {
    while (this._polling) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      if (!this._polling) return;
      try {
        const r = await fetch('/api/import/status');
        if (!r.ok) throw new Error(`status ${r.status}`);
        const snap = await r.json();
        this._pollFailures = 0;
        this._applySnapshot(snap);
        if (snap.state === 'done' || snap.state === 'failed' || snap.state === 'idle') {
          this._polling = false;
          return;
        }
      } catch {
        this._pollFailures += 1;
        if (this._pollFailures >= MAX_POLL_FAILURES) {
          this._polling = false;
          this._error = 'Lost contact with the instance mid-import; reload this page to see where it landed.';
          this._canRetry = false;
          return;
        }
      }
    }
  }

  // Shared error surfacing for the non-200 statuses the server answers
  // with. Sets _error (and demo mode on a 403); the caller decides which
  // phase to fall back to.
  async _surfaceError(r, retryFn = null) {
    let body = {};
    try { body = await r.json(); } catch {}
    if (r.status === 403) { this._demo = true; return; }
    if (r.status === 413) {
      const mb = Number.isFinite(body.maxBytes)
        ? ` The limit is ${Math.round(body.maxBytes / (1024 * 1024))} MB.` : '';
      this._error = `The archive is too large.${mb}`;
    } else if (r.status === 507) {
      this._error = 'Not enough free disk space on the instance to import safely.';
    } else if (r.status === 422) {
      this._error = `The archive was refused (${body.code || 'invalid'}): ${body.error || 'not a Klebb export'}`;
    } else if (r.status === 428) {
      this._error = 'Confirmation required: the import was not applied.';
    } else if (r.status === 409 && body.code === 'JOB_ACTIVE') {
      this._error = 'An import is already in progress on this instance.';
    } else if (r.status === 503 && body.code === 'IMPORT_FROZEN') {
      this._error = 'An import is running right now; this instance answers again when it finishes.';
    } else if (r.status === 503 && body.code === 'IMPORT_RECOVERY_FAILED') {
      this._error = `An interrupted import could not be recovered: ${body.reason || body.error || 'see the server log'}`;
    } else {
      this._error = body.error || `Request failed (${r.status}).`;
    }
    this._retryFn = retryFn;
    this._canRetry = !!retryFn;
  }

  _onExportClick(e) {
    if (this._exportBusy) { e.preventDefault(); return; }
    this._exportBusy = true;
    setTimeout(() => { this._exportBusy = false; }, 4000);
  }

  _onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    this._lastFile = file;
    this._upload(file);
  }

  _upload(file) {
    this._phase = 'uploading';
    this._uploadPct = 0;
    this._error = null;
    // XMLHttpRequest, not fetch: only xhr.upload.onprogress can observe
    // upload progress, and a whole-archive send deserves a real bar.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import/upload');
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) this._uploadPct = Math.round((ev.loaded / ev.total) * 100);
    };
    xhr.onload = async () => {
      if (xhr.status === 200) { this._start(); return; }
      const fake = new Response(xhr.responseText, { status: xhr.status });
      await this._surfaceError(fake, () => this._upload(this._lastFile));
      this._phase = 'idle';
    };
    xhr.onerror = () => {
      this._error = 'The upload failed part-way; check the connection and retry.';
      this._retryFn = () => this._upload(this._lastFile);
      this._canRetry = true;
      this._phase = 'idle';
    };
    xhr.send(file);
  }

  async _start() {
    this._phase = 'starting';
    this._error = null;
    try {
      const r = await fetch('/api/import/start', { method: 'POST' });
      if (!r.ok) {
        await this._surfaceError(r, null);
        this._phase = 'idle';
        return;
      }
      this._applySnapshot(await r.json());
    } catch {
      this._error = 'Could not reach the instance to check the archive.';
      this._retryFn = () => this._start();
      this._canRetry = true;
      this._phase = 'idle';
    }
  }

  _onConfirmInput(e) {
    this._confirmText = e.target.value;
  }

  get _confirmSatisfied() {
    const snap = this._snapshot;
    if (!snap || !snap.requiresConfirm) return true;
    return this._hasNonce && this._confirmText === CONFIRM_WORD;
  }

  async _apply() {
    if (!this._confirmSatisfied) return;
    this._phase = 'applying';
    this._error = null;
    const body = this._nonce ? { nonce: this._nonce } : {};
    try {
      const r = await fetch('/api/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        await this._surfaceError(r, null);
        await this._syncPhaseKeepError();
        return;
      }
      // 202: the pipeline is running detached; the snapshot says applying
      // and _applySnapshot starts the status polling.
      this._applySnapshot(await r.json());
    } catch {
      // The connection dropped but the pipeline may already be running
      // server-side. Poll rather than re-POST: a second apply after done
      // would only earn a 409.
      this._startPolling();
    }
  }

  // Re-sync the phase from the server after a refused mutation, without
  // clearing the error just surfaced. _applySnapshot never re-delivers the
  // nonce (the server serves it once); the held copy stays valid.
  async _syncPhaseKeepError() {
    try {
      const r = await fetch('/api/import/status');
      if (r.ok) { this._applySnapshot(await r.json()); return; }
    } catch {}
    this._phase = 'idle';
  }

  async _rollback() {
    this._phase = 'applying';
    this._error = null;
    try {
      const r = await fetch('/api/import/rollback', { method: 'POST' });
      if (!r.ok) {
        await this._surfaceError(r, null);
        await this._syncPhaseKeepError();
        return;
      }
      // 202 + poll, exactly like apply; the done view reads snap.rolledBack.
      this._applySnapshot(await r.json());
    } catch {
      this._startPolling();
    }
  }

  async _startOver() {
    this._polling = false;
    this._error = null;
    try {
      const r = await fetch('/api/import/abort', { method: 'POST' });
      if (!r.ok && r.status !== 409) {
        await this._surfaceError(r, null);
        return;
      }
    } catch {
      this._error = 'Could not reach the instance.';
      return;
    }
    this._snapshot = null;
    this._nonce = null;
    this._hasNonce = false;
    this._confirmText = '';
    this._uploadPct = null;
    this._phase = 'idle';
  }

  _reloadApp() {
    location.reload();
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
    .panel {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-card);
      margin-bottom: 20px;
      font-size: 13px;
      color: var(--text-primary);
    }
    .btn {
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      text-align: center;
    }
    .btn:hover:not(:disabled):not(.disabled) {
      border-color: var(--accent);
      color: var(--accent);
    }
    .btn.primary {
      background: var(--accent, #4488ff);
      color: var(--accent-fg, #fff);
      border-color: var(--accent, #4488ff);
    }
    .btn.primary:hover:not(:disabled):not(.disabled) {
      filter: brightness(1.05);
      color: var(--accent-fg, #fff);
    }
    .btn.danger {
      background: var(--accent-red, #ff5566);
      color: #fff;
      border-color: var(--accent-red, #ff5566);
    }
    .btn:disabled, .btn.disabled {
      opacity: 0.4;
      cursor: not-allowed;
      pointer-events: none;
    }
    .btn-row { display: inline-flex; gap: 8px; flex-wrap: wrap; }
    .file-input {
      font: inherit;
      font-size: 13px;
      color: var(--text-primary);
    }
    .progress-track {
      width: 100%;
      height: 8px;
      border-radius: 4px;
      background: var(--bg-input, rgba(0, 0, 0, 0.08));
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.2s;
    }
    .muted { color: var(--text-muted, var(--text-secondary)); }
    .counts { font-weight: 600; }
    .warn-list, .finding-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
    }
    .warn-list li { color: var(--accent-amber, #ffaa33); }
    .finding-list li { color: var(--text-primary); }
    .finding-list li.refusal { color: var(--accent-red, #ff5566); }
    .finding-code {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      margin-right: 6px;
    }
    .exclusions {
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      line-height: 1.5;
    }
    .danger-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      border: 1px solid var(--accent-red, #ff5566);
      border-radius: 8px;
      background: var(--accent-red-bg, rgba(255, 85, 102, 0.08));
    }
    .danger-warning {
      font-size: 13px;
      font-weight: 600;
      color: var(--accent-red, #ff5566);
    }
    .confirm-input {
      font: inherit;
      font-size: 14px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-input, rgba(0, 0, 0, 0.04));
      color: var(--text-primary);
      width: 100%;
      box-sizing: border-box;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .spinner { animation-duration: 2s; }
      .progress-fill { transition: none; }
    }
    .busy-row { display: flex; align-items: center; gap: 10px; }
    .error-note {
      font-size: 12px;
      color: var(--accent-red, #ff5566);
    }
    .demo-note {
      font-size: 13px;
      color: var(--text-secondary);
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-card);
    }
  `;

  render() {
    if (this._demo) {
      return html`
        <h2>Data</h2>
        <div class="demo-note">Not available on the demo instance.</div>
      `;
    }
    return html`
      <h2>Export</h2>
      <div class="lede">
        Download a complete copy of this instance: every card with its
        history, reports and settings, as a zip.
      </div>
      <div class="panel">
        <span>
          <a
            class="btn primary export-btn ${this._exportBusy ? 'disabled' : ''}"
            href="/api/export"
            @click=${this._onExportClick}
          >${this._exportBusy ? 'Preparing…' : 'Download export'}</a>
        </span>
      </div>

      <h2 class="subsequent">Import</h2>
      <div class="lede">Restore an export archive onto this instance.</div>
      ${this._renderImport()}
      ${this._error ? html`
        <div class="error-note">
          ${this._error}
          ${this._canRetry ? html`
            <button class="btn retry-btn" @click=${() => { const f = this._retryFn; this._canRetry = false; this._error = null; f && f(); }}>Retry</button>
          ` : ''}
        </div>
      ` : ''}
    `;
  }

  _renderImport() {
    switch (this._phase) {
      case 'loading':
        return html`<div class="panel"><span class="muted">Loading…</span></div>`;
      case 'idle':
        return html`
          <div class="panel">
            <input
              class="file-input"
              type="file"
              accept=".zip,application/zip"
              aria-label="Choose an export archive"
              @change=${this._onFileChosen}
            >
          </div>
        `;
      case 'uploading':
        return html`
          <div class="panel upload-panel">
            <span>Uploading the archive… ${this._uploadPct ?? 0}%</span>
            <div class="progress-track">
              <div class="progress-fill" style="width: ${this._uploadPct ?? 0}%"></div>
            </div>
          </div>
        `;
      case 'starting':
        return html`
          <div class="panel">
            <div class="busy-row"><span class="spinner"></span><span>Checking the archive…</span></div>
          </div>
        `;
      case 'awaiting-confirm':
        return this._renderPreview();
      case 'applying':
        return this._renderApplying();
      case 'done':
        return this._renderDone();
      case 'failed':
        return this._renderFailed();
      case 'in-progress':
        return html`
          <div class="panel">
            <div class="busy-row"><span class="spinner"></span><span>An import is in progress on this instance.</span></div>
            <span><button class="btn" @click=${this._refreshStatus}>Refresh</button></span>
          </div>
        `;
      default:
        return '';
    }
  }

  _renderApplying() {
    const snap = this._snapshot || {};
    const stage = STAGE_LABELS[snap.stage] || (snap.rolledBack ? 'Rolling back' : 'Importing');
    return html`
      <div class="panel applying-panel">
        <div class="busy-row">
          <span class="spinner"></span>
          <span class="stage-label">${stage}…</span>
        </div>
        <span class="muted">${snap.rolledBack
          ? 'Rolling back to the snapshot; keep this page open.'
          : 'The import is running on the instance; keep this page open to follow it.'}</span>
      </div>
    `;
  }

  _renderPreview() {
    const snap = this._snapshot || {};
    const plan = snap.plan || {};
    const warnings = (snap.findings || []).filter(f => f.severity === 'warning');
    const nonceLost = snap.requiresConfirm && !this._hasNonce;
    return html`
      <div class="panel preview-panel">
        <span class="counts plan-counts">
          ${this._n(plan.cards, 'card')} (${plan.cardsWithData ?? 0} with data),
          ${this._n(plan.samplesPushes, 'HAE push', 'HAE pushes')},
          ${this._n(plan.reports, 'report')}
        </span>
        ${warnings.length ? html`
          <ul class="warn-list">
            ${warnings.map(f => html`
              <li><span class="finding-code">${f.code}</span>${f.message}</li>
            `)}
          </ul>
        ` : ''}
        <div class="exclusions">
          Passkeys, connected devices and chat history stay with the
          instance; data timestamps reset to the import time.
        </div>
        ${nonceLost ? html`
          <div class="danger-panel">
            <span class="danger-warning">This import was started elsewhere and its confirmation cannot be shown again.</span>
            <span class="btn-row">
              <button class="btn startover-btn" @click=${this._startOver}>Start over</button>
            </span>
          </div>
        ` : snap.requiresConfirm ? html`
          <div class="danger-panel">
            <span class="danger-warning">This will replace everything on this instance.</span>
            <span>Type ${CONFIRM_WORD} to confirm.</span>
            <input
              class="confirm-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder=${CONFIRM_WORD}
              .value=${this._confirmText}
              @input=${this._onConfirmInput}
            >
            <span class="btn-row">
              <button class="btn startover-btn" @click=${this._startOver}>Cancel</button>
              <button
                class="btn danger apply-btn"
                ?disabled=${!this._confirmSatisfied}
                @click=${this._apply}
              >Apply</button>
            </span>
          </div>
        ` : html`
          <span class="btn-row">
            <button class="btn startover-btn" @click=${this._startOver}>Cancel</button>
            <button class="btn primary apply-btn" @click=${this._apply}>Apply</button>
          </span>
        `}
      </div>
    `;
  }

  _renderDone() {
    const snap = this._snapshot || {};
    const v = snap.verified || {};
    return html`
      <div class="panel result-panel">
        <span class="counts result-counts">
          ${snap.rolledBack
            ? 'Rolled back: the instance is back to its pre-import state.'
            : html`Import complete: verified ${this._n(v.cards, 'card')},
                   ${this._n(v.pushes, 'HAE push', 'HAE pushes')},
                   ${this._n(v.reports, 'report')}.`}
        </span>
        <span class="btn-row">
          <button class="btn primary reload-btn" @click=${this._reloadApp}>Reload the app</button>
          <button class="btn startover-btn" @click=${this._startOver}>Dismiss</button>
        </span>
      </div>
    `;
  }

  _renderFailed() {
    const snap = this._snapshot || {};
    const findings = (snap.findings || []).filter(f => f.severity !== 'info');
    const canRollBack = !!snap.snapshotPath;
    return html`
      <div class="panel failed-panel">
        <span class="counts">The import did not complete.</span>
        ${findings.length ? html`
          <ul class="finding-list">
            ${findings.map(f => html`
              <li class=${f.severity}><span class="finding-code">${f.code}</span>${f.message}</li>
            `)}
          </ul>
        ` : ''}
        <span class="btn-row">
          ${canRollBack ? html`
            <button class="btn primary rollback-btn" @click=${this._rollback}>Roll back</button>
          ` : ''}
          <button class="btn startover-btn" @click=${this._startOver}>Start over</button>
        </span>
      </div>
    `;
  }

  _n(count, singular, plural = null) {
    const c = Number.isFinite(count) ? count : 0;
    return `${c} ${c === 1 ? singular : (plural || `${singular}s`)}`;
  }
}
customElements.define('eh-settings-data', EhSettingsData);
