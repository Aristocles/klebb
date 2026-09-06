// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-reports-view.js
// The Reports view — combines:
//   1. Manifest-driven cards with meta.reports.enabled: true (snps, adherence)
//   2. Uploaded and hand-authored documents from /api/reports
//
// This is the only place a document can enter an instance, so it carries the
// upload control, the quota, per-report state, and the OCR verification loop.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './eh-view-renderer.js';
import './eh-report-detail.js';

const POLL_MS = 3000;
// Polling stops after this many attempts even if something is still listed as
// processing. A file whose extraction died before the pipeline could move it to
// _failed/ would otherwise sit in the inbox forever and be polled forever with
// it.
const MAX_POLLS = 20;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export class EhReportsView extends LitElement {
  static properties = {
    _reports: { state: true },
    _processing: { state: true },
    _failed: { state: true },
    _quota: { state: true },
    _loading: { state: true },
    _demo: { state: true },
    _uploads: { state: true },
    _error: { state: true },
    _selected: { state: true },
    _pollExhausted: { state: true },
  };

  constructor() {
    super();
    this._reports = [];
    this._processing = [];
    this._failed = [];
    this._quota = null;
    this._loading = true;
    this._demo = false;
    // Per-file upload progress: [{ name, state: 'sending'|'done'|'error', message }]
    this._uploads = [];
    this._error = null;
    this._selected = null;
    this._pollExhausted = false;
    this._pollTimer = null;
    this._pollCount = 0;
    this._allowed = [];
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchInstance();
    this._fetchReports();
  }

  disconnectedCallback() {
    this._stopPolling();
    super.disconnectedCallback();
  }

  async _fetchInstance() {
    try {
      const r = await fetch('/api/instance');
      if (r.ok) {
        const info = await r.json();
        this._demo = !!info.demo;
      }
    } catch {}
  }

  async _fetchReports() {
    try {
      const r = await fetch('/api/reports');
      if (!r.ok) throw new Error(`could not load reports (${r.status})`);
      const data = await r.json();
      // Tolerate the pre-envelope shape so a stale cached script does not
      // render a blank page.
      if (Array.isArray(data)) {
        this._reports = data;
        this._processing = [];
        this._failed = [];
        this._quota = null;
      } else {
        this._reports = data.reports || [];
        this._processing = data.processing || [];
        this._failed = data.failed || [];
        this._quota = data.quota || null;
      }
      this._error = null;
    } catch (e) {
      this._error = e.message;
    } finally {
      this._loading = false;
      this._syncPolling();
    }
  }

  // Poll only while something is in flight, and only for a bounded number of
  // attempts.
  _syncPolling() {
    if (this._processing.length && !this._pollExhausted) {
      if (!this._pollTimer) {
        this._pollTimer = setInterval(() => {
          this._pollCount++;
          if (this._pollCount >= MAX_POLLS) {
            this._pollExhausted = true;
            this._stopPolling();
            return;
          }
          this._fetchReports();
        }, POLL_MS);
      }
    } else {
      this._stopPolling();
      if (!this._processing.length) {
        this._pollCount = 0;
        this._pollExhausted = false;
      }
    }
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  get _atCap() {
    return !!this._quota && this._quota.remaining < 1;
  }

  async _onPick(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    // One request per file, sequentially: the endpoint takes a single raw body,
    // and serial uploads keep the queue honest about the cap.
    for (const file of files) await this._upload(file);
    this._fetchReports();
  }

  async _upload(file) {
    const entry = { name: file.name, state: 'sending', message: null };
    this._uploads = [...this._uploads, entry];
    const update = (patch) => {
      Object.assign(entry, patch);
      this._uploads = [...this._uploads];
    };

    if (file.size > MAX_UPLOAD_BYTES) {
      update({ state: 'error', message: 'Larger than the 30 MB limit' });
      return;
    }
    try {
      const r = await fetch('/api/reports/upload', {
        method: 'POST',
        // Raw body, no multipart. The filename rides in a header, URL-encoded,
        // because HTTP headers are latin-1 and a name like "Résultats.pdf"
        // would otherwise corrupt or throw.
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Klebb-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      let json = null;
      try { json = await r.json(); } catch {}
      if (!r.ok) {
        // Surface the server's own message: it distinguishes an unsupported
        // type from the cap from a size limit, and the user needs to know which.
        update({ state: 'error', message: json?.error || `Upload failed (${r.status})` });
        return;
      }
      update({ state: 'done', message: null });
      if (json && typeof json.used === 'number') {
        this._quota = { ...(this._quota || {}), used: json.used, max: json.max, remaining: json.max - json.used };
      }
    } catch (e) {
      update({ state: 'error', message: e.message });
    }
  }

  _onReportChanged() {
    this._selected = null;
    // A reprocess re-enters the queue, so refresh promptly and let the poll
    // pick up the rest.
    this._fetchReports();
  }

  _formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return dateStr; }
  }

  static styles = css`
    :host { display: block; }
    h2 { font-size: 1.2rem; color: var(--text-primary); margin: 0 0 16px; }
    h3 {
      font-size: 0.85rem; color: var(--text-muted, var(--text-secondary));
      margin: 24px 0 10px; text-transform: uppercase; letter-spacing: 0.08em;
    }
    .upload {
      display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px; margin-bottom: 4px;
    }
    .upload-btn {
      font: inherit; font-size: 13px; font-weight: 700; padding: 8px 14px;
      border-radius: 8px; border: 1px solid var(--accent);
      background: var(--accent); color: #06231d; cursor: pointer;
    }
    .upload-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
    .upload-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    input[type="file"] { display: none; }
    .quota { font-size: 12px; color: var(--text-secondary); }
    .hint { font-size: 12px; color: var(--text-muted, var(--text-secondary)); }
    .banner {
      background: rgba(255, 170, 0, 0.1); color: #ffaa00;
      border: 1px solid rgba(255, 170, 0, 0.3); border-radius: 8px;
      padding: 10px 12px; font-size: 13px; margin-bottom: 10px;
    }
    .error {
      background: rgba(220, 53, 69, 0.1); color: #ff6b6b;
      border: 1px solid rgba(220, 53, 69, 0.3); border-radius: 8px;
      padding: 8px 12px; font-size: 13px; margin-bottom: 10px;
      overflow-wrap: anywhere;
    }
    .md-list { display: flex; flex-direction: column; gap: 8px; }
    .md-item {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px; text-decoration: none;
      color: inherit; transition: all 0.15s; display: block; width: 100%;
      text-align: left; font: inherit; cursor: pointer;
    }
    .md-item:hover { border-color: var(--accent); background: var(--bg-hover, rgba(0,0,0,0.02)); }
    .md-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .md-item.pending { opacity: 0.75; cursor: default; }
    .md-title { font-size: 14px; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
    .md-meta {
      font-size: 11px; color: var(--text-muted, var(--text-secondary));
      margin-top: 4px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    }
    .md-bullets {
      margin: 8px 0 0; padding-left: 18px; display: flex;
      flex-direction: column; gap: 3px;
    }
    .md-bullets li { font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .badge {
      padding: 1px 7px; border-radius: 8px; font-size: 10px; font-weight: 600;
      background: var(--accent-bg, rgba(0,212,170,0.1)); color: var(--accent);
    }
    .badge.warn { background: rgba(255, 170, 0, 0.15); color: #ffaa00; }
    .badge.bad { background: rgba(220, 53, 69, 0.12); color: #ff6b6b; }
    .badge.muted { background: var(--bg-secondary, rgba(128,128,128,0.15)); color: var(--text-secondary); }
    .spinner {
      width: 10px; height: 10px; border-radius: 50%;
      border: 2px solid var(--border); border-top-color: var(--accent);
      display: inline-block; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    .empty { color: var(--text-muted, var(--text-secondary)); font-size: 13px; padding: 12px; }
    .uploads { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 0; }
    .upload-row { font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .upload-row.error { color: #ff6b6b; }
  `;

  _renderUpload() {
    // Upload is a mutating route and 403s in demo mode server-side; hiding the
    // control keeps a demo visitor from meeting a dead button.
    if (this._demo) {
      return html`<p class="hint">Uploading is disabled in the demo.</p>`;
    }
    const q = this._quota;
    const accept = '.pdf,.png,.jpg,.jpeg,.txt,.md,.csv,.docx,.mp3,.wav,.m4a,.ogg,.opus';
    return html`
      <div class="upload">
        <button class="upload-btn" ?disabled=${this._atCap}
                @click=${() => this.renderRoot.querySelector('#file').click()}>
          Add a document
        </button>
        <input id="file" type="file" accept=${accept} multiple @change=${this._onPick}>
        ${q ? html`<span class="quota">${q.used} of ${q.max} used</span>` : ''}
        ${this._atCap
          ? html`<span class="hint">Delete a report to upload another.</span>`
          : html`<span class="hint">PDF, photo, Word, text, CSV or audio. Up to 30 MB.</span>`}
      </div>
      ${this._uploads.length ? html`
        <div class="uploads">
          ${this._uploads.map(u => html`
            <div class="upload-row ${u.state === 'error' ? 'error' : ''}">
              ${u.name}: ${u.state === 'sending' ? 'uploading…' : u.state === 'done' ? 'received' : u.message}
            </div>
          `)}
        </div>
      ` : ''}
    `;
  }

  _renderReportCard(r) {
    const badges = [];
    if (r.verify === 'required') badges.push(html`<span class="badge warn">Needs checking</span>`);
    if (r.status === 'raw') badges.push(html`<span class="badge muted">Not summarised</span>`);
    if (r.status === 'rejected') badges.push(html`<span class="badge bad">Not health</span>`);
    return html`
      <button class="md-item" @click=${() => { this._selected = r; }}>
        <div class="md-title">${r.title || r.name}</div>
        <div class="md-meta">
          ${badges}
          ${r.sourceFormat ? html`<span class="badge">${r.sourceFormat}</span>` : ''}
          ${r.date ? html`<span>${this._formatDate(r.date)}</span>` : ''}
        </div>
        ${r.bullets?.length ? html`
          <ul class="md-bullets">${r.bullets.map(b => html`<li>${b}</li>`)}</ul>
        ` : ''}
      </button>
    `;
  }

  render() {
    const unverified = this._reports.filter(r => r.verify === 'required').length;
    return html`
      <h2>📋 Reports</h2>
      <eh-view-renderer view="reports"></eh-view-renderer>

      <h3>Documents</h3>
      ${this._renderUpload()}
      ${this._error ? html`<div class="error">${this._error}</div>` : ''}
      ${unverified ? html`
        <div class="banner">
          ${unverified === 1 ? 'One report needs' : `${unverified} reports need`}
          its text checked against the original before chat can use it.
        </div>
      ` : ''}
      ${this._pollExhausted ? html`
        <div class="banner">Still processing. Reload the page to check again.</div>
      ` : ''}

      ${this._loading
        ? html`<div class="empty">Loading…</div>`
        : html`
          <div class="md-list">
            ${this._processing.map(p => html`
              <div class="md-item pending">
                <div class="md-title">${p.filename}</div>
                <div class="md-meta"><span class="spinner"></span><span>Reading it…</span></div>
              </div>
            `)}
            ${this._failed.map(f => html`
              <div class="md-item pending">
                <div class="md-title">${f.filename}</div>
                <div class="md-meta">
                  <span class="badge bad">Failed</span>
                  ${f.reason ? html`<span>${f.reason}</span>` : ''}
                </div>
              </div>
            `)}
            ${this._reports.map(r => this._renderReportCard(r))}
            ${!this._reports.length && !this._processing.length && !this._failed.length
              ? html`<div class="empty">No documents yet. Add a blood test, a scan or a letter above.</div>`
              : ''}
          </div>
        `}

      ${this._selected ? html`
        <eh-report-detail
          .report=${this._selected}
          @eh-report-changed=${this._onReportChanged}
          @eh-report-closed=${() => { this._selected = null; }}
        ></eh-report-detail>
      ` : ''}
    `;
  }
}
customElements.define('eh-reports-view', EhReportsView);
