// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-report-detail.js — detail sheet for one report, with the OCR compare view.
//
// Bottom sheet on a phone, centred dialog on a desktop, matching
// eh-card-settings-modal. Two jobs:
//
//   1. Show what the comprehension pass made of the document: title, date,
//      bullets, and why it degraded if it did.
//   2. Let a human check OCR text against the original image. That check is
//      what unlocks the report for chat, so it has to be genuinely usable on
//      the phone the photo was taken with: side by side above 720 px, and two
//      tabs below that, because 375 px cannot host a real comparison.
//
// Public API:
//   <eh-report-detail
//     .report=${{ name, title, date, bullets, status, verify, ... }}
//     @eh-report-changed=${(e) => ...}   // { name, action }
//     @eh-report-closed=${() => ...}
//   ></eh-report-detail>

import { LitElement, html, css } from 'https://esm.sh/lit@3';

const COMPARE_MIN_WIDTH = 720;

export class EhReportDetail extends LitElement {
  static properties = {
    report: { type: Object },
    _mode: { state: true },
    _tab: { state: true },
    _ocrText: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _confirmDelete: { state: true },
    _wide: { state: true },
  };

  constructor() {
    super();
    this.report = null;
    // 'detail' | 'compare'
    this._mode = 'detail';
    this._tab = 'image';
    this._ocrText = null;
    this._busy = null;
    this._error = null;
    this._confirmDelete = false;
    this._wide = false;
    this._onResize = () => { this._wide = window.innerWidth >= COMPARE_MIN_WIDTH; };
  }

  connectedCallback() {
    super.connectedCallback();
    this._onResize();
    window.addEventListener('resize', this._onResize);
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this._onResize);
    super.disconnectedCallback();
  }

  firstUpdated() {
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && typeof dlg.showModal === 'function') {
      try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
      // Escape must go through _close so the parent hears about it.
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); this._close(); });
    }
  }

  static styles = css`
    :host { position: relative; }
    dialog {
      border: none; padding: 0; margin: 0;
      width: 100vw; height: 100vh; max-width: 100vw; max-height: 100vh;
      background: transparent; overflow: visible;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    }
    .wrap {
      position: fixed; inset: 0;
      display: flex; align-items: flex-end; justify-content: center;
    }
    @media (min-width: 640px) { .wrap { align-items: center; } }
    .panel {
      position: relative;
      width: 100%; max-width: 480px; max-height: 92vh;
      overflow-y: auto; overflow-x: hidden;
      background: var(--bg-card, #1a1a1a);
      color: var(--text-primary);
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.35);
      padding: 20px 20px 16px;
      display: flex; flex-direction: column; gap: 14px;
    }
    .panel * { box-sizing: border-box; }
    @media (min-width: 640px) {
      .panel { border-radius: 16px; box-shadow: 0 8px 60px rgba(0, 0, 0, 0.45); }
    }
    /* The compare view earns more room, but only where there is room to earn. */
    .panel.compare { max-width: 480px; }
    @media (min-width: 720px) {
      .panel.compare { max-width: 900px; }
    }
    .grip {
      align-self: center; width: 36px; height: 4px; border-radius: 2px;
      background: var(--border); margin-top: -6px;
    }
    @media (min-width: 640px) { .grip { display: none; } }
    .header { display: flex; align-items: flex-start; gap: 10px; }
    .title-block { flex: 1; min-width: 0; }
    .kicker {
      font-size: 11px; font-weight: 700; letter-spacing: 0.6px;
      text-transform: uppercase; color: var(--text-muted, var(--text-secondary));
      margin: 0 0 2px;
    }
    .title {
      font-size: 18px; font-weight: 700; margin: 0; line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .close-btn {
      background: none; border: none; color: var(--text-secondary);
      font-size: 22px; line-height: 1; padding: 4px 8px; cursor: pointer;
      border-radius: 6px; flex-shrink: 0;
    }
    .close-btn:hover { background: var(--bg-hover, rgba(255,255,255,0.05)); color: var(--text-primary); }
    .close-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip {
      font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 8px;
      background: var(--bg-secondary, rgba(128,128,128,0.15));
      color: var(--text-secondary); white-space: nowrap;
    }
    .chip.warn { background: rgba(255, 170, 0, 0.15); color: #ffaa00; }
    .chip.bad { background: rgba(220, 53, 69, 0.12); color: #ff6b6b; }
    .bullets { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
    .bullets li { font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .note {
      font-size: 13px; line-height: 1.45; color: var(--text-secondary);
      background: var(--bg-secondary, rgba(128,128,128,0.1));
      border-radius: 8px; padding: 10px 12px; overflow-wrap: anywhere;
    }
    .note.warn { background: rgba(255, 170, 0, 0.1); color: #ffaa00; }
    .error {
      background: rgba(220, 53, 69, 0.1); color: #ff6b6b;
      border: 1px solid rgba(220, 53, 69, 0.3); border-radius: 8px;
      padding: 8px 12px; font-size: 13px; overflow-wrap: anywhere;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button.action {
      font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--bg-card);
      color: var(--text-primary); cursor: pointer;
    }
    button.action:hover:not([disabled]) { border-color: var(--accent); }
    button.action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.action[disabled] { opacity: 0.45; cursor: not-allowed; }
    button.action.primary { background: var(--accent); border-color: var(--accent); color: #06231d; font-weight: 700; }
    button.action.danger { color: #ff6b6b; }
    a.action {
      font-size: 13px; padding: 8px 14px; border-radius: 8px;
      border: 1px solid var(--border); color: var(--text-primary);
      text-decoration: none; display: inline-block;
    }
    a.action:hover { border-color: var(--accent); }
    /* Tabs: the phone comparison. */
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
    .tab {
      font: inherit; font-size: 13px; font-weight: 600; padding: 8px 12px;
      background: none; border: none; border-bottom: 2px solid transparent;
      color: var(--text-secondary); cursor: pointer;
    }
    .tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .panes { display: grid; grid-template-columns: 1fr; gap: 12px; min-width: 0; }
    @media (min-width: 720px) {
      .panes.side-by-side { grid-template-columns: 1fr 1fr; }
    }
    .pane { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .pane-label {
      font-size: 11px; font-weight: 700; letter-spacing: 0.5px;
      text-transform: uppercase; color: var(--text-muted, var(--text-secondary));
    }
    .pane img, .pane embed {
      width: 100%; max-height: 55vh; object-fit: contain;
      background: #000; border-radius: 8px; border: 1px solid var(--border);
    }
    .pane audio { width: 100%; }
    /* pre must not widen the sheet: long OCR lines wrap rather than
       introducing a horizontal scrollbar on the whole panel. */
    .ocr {
      margin: 0; font-family: ui-monospace, monospace; font-size: 12px;
      line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
      max-height: 55vh; overflow-y: auto;
      background: var(--bg-secondary, rgba(128,128,128,0.1));
      border-radius: 8px; padding: 10px 12px;
    }
    .loading { font-size: 13px; color: var(--text-secondary); }
  `;

  get _isUnverified() {
    return this.report?.verify === 'required';
  }

  _close() {
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && typeof dlg.close === 'function') { try { dlg.close(); } catch {} }
    this.dispatchEvent(new CustomEvent('eh-report-closed', { bubbles: true, composed: true }));
  }

  _announce(action) {
    this.dispatchEvent(new CustomEvent('eh-report-changed', {
      detail: { name: this.report?.name, action },
      bubbles: true, composed: true,
    }));
  }

  async _post(suffix, body) {
    const r = await fetch(`/api/reports/${encodeURIComponent(this.report.name)}${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch {}
    if (!r.ok) throw new Error(json?.error || `request failed (${r.status})`);
    return json;
  }

  async _openCompare() {
    this._mode = 'compare';
    this._error = null;
    if (this._ocrText === null) {
      try {
        // The dedicated text endpoint, not /report/<name>: that route renders a
        // whole styled HTML page, so stripping the frontmatter back out of
        // markup client-side leaks the header into the very pane the human is
        // supposed to be checking the numbers in.
        const r = await fetch(`/api/reports/${encodeURIComponent(this.report.name)}/text`);
        if (!r.ok) throw new Error(`could not load the text (${r.status})`);
        this._ocrText = (await r.text()).trim();
      } catch (e) {
        this._error = `could not load the report text: ${e.message}`;
        this._ocrText = '';
      }
    }
  }

  async _verify() {
    this._busy = 'verify';
    this._error = null;
    try {
      await this._post('/verify');
      this._announce('verified');
      this._close();
    } catch (e) {
      this._error = e.message;
    } finally {
      this._busy = null;
    }
  }

  async _reprocess() {
    this._busy = 'reprocess';
    this._error = null;
    try {
      await this._post('/reprocess');
      this._announce('reprocessing');
      this._close();
    } catch (e) {
      this._error = e.message;
    } finally {
      this._busy = null;
    }
  }

  async _delete() {
    if (!this._confirmDelete) { this._confirmDelete = true; return; }
    this._busy = 'delete';
    this._error = null;
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(this.report.name)}`, { method: 'DELETE' });
      let json = null;
      try { json = await r.json(); } catch {}
      if (!r.ok) throw new Error(json?.error || `delete failed (${r.status})`);
      this._announce('deleted');
      this._close();
    } catch (e) {
      this._error = e.message;
      this._confirmDelete = false;
    } finally {
      this._busy = null;
    }
  }

  _renderSourcePane() {
    const r = this.report;
    const src = `/api/reports/${encodeURIComponent(r.name)}/source`;
    if (!r.hasSource) {
      return html`<div class="note">The original file is no longer stored for this report.</div>`;
    }
    if (r.sourceFormat === 'image') {
      return html`<img src="${src}" alt="Original document for ${r.title || r.name}">`;
    }
    if (r.sourceFormat === 'audio') {
      return html`<audio controls src="${src}"></audio>`;
    }
    // A PDF cannot be reliably inlined across browsers; a link always works.
    return html`
      <embed src="${src}" type="application/pdf">
      <a class="action" href="${src}" target="_blank" rel="noopener">Open the original</a>
    `;
  }

  _renderCompare() {
    const showBoth = this._wide;
    return html`
      ${showBoth ? '' : html`
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" aria-selected=${this._tab === 'image'}
                  @click=${() => { this._tab = 'image'; }}>Original</button>
          <button class="tab" role="tab" aria-selected=${this._tab === 'text'}
                  @click=${() => { this._tab = 'text'; }}>Text read</button>
        </div>
      `}
      <div class="panes ${showBoth ? 'side-by-side' : ''}">
        ${showBoth || this._tab === 'image' ? html`
          <div class="pane">
            <span class="pane-label">Original</span>
            ${this._renderSourcePane()}
          </div>
        ` : ''}
        ${showBoth || this._tab === 'text' ? html`
          <div class="pane">
            <span class="pane-label">Text read from it</span>
            ${this._ocrText === null
              ? html`<div class="loading">Loading…</div>`
              : html`<pre class="ocr">${this._ocrText || '(no text)'}</pre>`}
          </div>
        ` : ''}
      </div>
      <p class="note">
        Check the numbers against the original. Until you confirm it, this
        report is kept out of chat, so the assistant cannot quote a misread
        value back to you.
      </p>
      ${this._error ? html`<div class="error">${this._error}</div>` : ''}
      <div class="actions">
        <button class="action primary" ?disabled=${!!this._busy} @click=${this._verify}>
          ${this._busy === 'verify' ? 'Saving…' : 'Looks right'}
        </button>
        <button class="action" ?disabled=${!!this._busy} @click=${this._reprocess}>
          ${this._busy === 'reprocess' ? 'Retrying…' : 'Retry reading it'}
        </button>
        <button class="action" ?disabled=${!!this._busy} @click=${() => { this._mode = 'detail'; }}>
          Back
        </button>
      </div>
    `;
  }

  _renderDetail() {
    const r = this.report;
    return html`
      <div class="meta">
        ${r.date ? html`<span class="chip">${r.date}</span>` : ''}
        ${r.sourceFormat ? html`<span class="chip">${r.sourceFormat}</span>` : ''}
        ${this._isUnverified ? html`<span class="chip warn">Needs checking</span>` : ''}
        ${r.status === 'raw' ? html`<span class="chip warn">Not summarised</span>` : ''}
        ${r.status === 'rejected' ? html`<span class="chip bad">Not a health document</span>` : ''}
      </div>

      ${r.bullets?.length ? html`
        <ul class="bullets">${r.bullets.map(b => html`<li>${b}</li>`)}</ul>
      ` : ''}

      ${r.reason ? html`<div class="note warn">${r.reason}</div>` : ''}

      ${this._isUnverified ? html`
        <p class="note">
          This came from a photo or a scan, so the text was read by OCR and
          could contain mistakes. Check it against the original and it becomes
          available to chat.
        </p>
      ` : ''}

      ${this._error ? html`<div class="error">${this._error}</div>` : ''}

      <div class="actions">
        <a class="action" href="${r.url}" target="_blank" rel="noopener">View full report</a>
        ${r.hasSource ? html`
          <button class="action ${this._isUnverified ? 'primary' : ''}" @click=${this._openCompare}>
            ${this._isUnverified ? 'Check the text' : 'Compare with original'}
          </button>
          <button class="action" ?disabled=${!!this._busy} @click=${this._reprocess}>
            ${this._busy === 'reprocess' ? 'Retrying…' : 'Read it again'}
          </button>
        ` : ''}
        ${r.managed ? html`
          <button class="action danger" ?disabled=${!!this._busy} @click=${this._delete}>
            ${this._busy === 'delete' ? 'Deleting…'
              : this._confirmDelete ? 'Really delete?' : 'Delete'}
          </button>
        ` : ''}
      </div>
      ${this._confirmDelete && !this._busy ? html`
        <p class="note">Deleting removes the report and the original file. This cannot be undone.</p>
      ` : ''}
    `;
  }

  render() {
    const r = this.report;
    if (!r) return html``;
    return html`
      <dialog aria-modal="true" aria-label="${r.title || r.name}">
        <div class="wrap">
          <div class="panel ${this._mode === 'compare' ? 'compare' : ''}">
            <div class="grip"></div>
            <div class="header">
              <div class="title-block">
                <p class="kicker">${this._mode === 'compare' ? 'Check the text' : 'Report'}</p>
                <h2 class="title">${r.title || r.name}</h2>
              </div>
              <button class="close-btn" type="button" aria-label="Close" @click=${this._close}>✕</button>
            </div>
            ${this._mode === 'compare' ? this._renderCompare() : this._renderDetail()}
          </div>
        </div>
      </dialog>
    `;
  }
}
customElements.define('eh-report-detail', EhReportDetail);
