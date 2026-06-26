// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-card-gallery.js — add-a-card-from-template gallery modal.
//
// Mirrors eh-prompts-gallery: a self-mounting <dialog> with a search
// toolbar, a featured row pinned first, per-row Preview, and a primary
// "Add card" action that POSTs to /api/settings/cards/from-template and
// writes a real manifest. Opens from the Settings › Cards "Browse card
// templates" button and from the welcome card's klebb-open-card-gallery
// event.
//
//   const m = document.createElement('eh-card-gallery');
//   document.body.appendChild(m);
//   m.open();
//
// On a successful create it fires `klebb-cards-changed` (so the Cards pane
// and Today views re-fetch) and closes.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { errorFromResponse } from '../lib/save-error.js';

export class EhCardGallery extends LitElement {
  static properties = {
    _templates: { state: true },
    _loading: { state: true },
    _loadError: { state: true },
    _filter: { state: true },
    _expandedId: { state: true },
    _creatingId: { state: true },
    _createError: { state: true },
  };

  constructor() {
    super();
    this._templates = [];
    this._loading = true;
    this._loadError = null;
    this._filter = '';
    this._expandedId = null;
    this._creatingId = null;
    this._createError = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadTemplates();
    this._escHandler = (e) => { if (e.key === 'Escape') this._close(); };
    window.addEventListener('keydown', this._escHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._escHandler);
  }

  open() {
    const dlg = this.renderRoot?.querySelector('dialog');
    if (dlg && !dlg.open) dlg.showModal();
  }

  _close() {
    const dlg = this.renderRoot?.querySelector('dialog');
    if (dlg && dlg.open) dlg.close();
  }

  _handleDialogClose() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  async _loadTemplates() {
    this._loading = true;
    this._loadError = null;
    try {
      const r = await fetch('/api/templates');
      if (!r.ok) throw await errorFromResponse(r);
      this._templates = (await r.json()).templates || [];
    } catch (e) {
      this._loadError = e.message || 'Could not load templates.';
    } finally {
      this._loading = false;
    }
  }

  _filtered() {
    const q = (this._filter || '').trim().toLowerCase();
    if (!q) return this._templates;
    return this._templates.filter(t => {
      const hay = `${t.title} ${t.summary} ${(t.tags || []).join(' ')} ${t.category || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // Featured templates pinned first, otherwise the server's title sort.
  _ordered(list) {
    const featured = list.filter(t => t.featured);
    const rest = list.filter(t => !t.featured);
    return [...featured, ...rest];
  }

  _toggleExpand(id) {
    this._expandedId = this._expandedId === id ? null : id;
  }

  async _add(t) {
    if (this._creatingId) return;
    this._creatingId = t.id;
    this._createError = null;
    try {
      const r = await fetch('/api/settings/cards/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ templateId: t.id }),
      });
      if (!r.ok) throw await errorFromResponse(r);
      // The new card exists server-side; tell the app to re-fetch and close.
      window.dispatchEvent(new CustomEvent('klebb-cards-changed'));
      this._close();
    } catch (e) {
      this._createError = e.message || 'Could not add the card. Try again.';
      this._creatingId = null;
    }
  }

  _renderList() {
    if (this._loading) return html`<div class="empty">Loading templates…</div>`;
    if (this._loadError) return html`<div class="empty error">⚠︎ ${this._loadError}</div>`;

    const filtered = this._filtered();
    if (!filtered.length) {
      return html`<div class="empty empty-state">
        No templates match.
        <div class="sub">
          You can also add a card by dropping a JSON file in
          <code>$HEALTH_HOME/data/</code>, or ask Klebbius to build one.
        </div>
      </div>`;
    }

    return html`
      <ul class="template-list">
        ${this._ordered(filtered).map(t => this._renderRow(t))}
      </ul>
    `;
  }

  _renderRow(t) {
    const expanded = this._expandedId === t.id;
    const creating = this._creatingId === t.id;
    return html`
      <li class="row ${t.featured ? 'featured' : ''} ${expanded ? 'expanded' : ''}">
        ${t.featured ? html`<div class="featured-chip">★ Start here</div>` : ''}
        <div class="row-head">
          <div class="row-body">
            <div class="row-title">
              ${t.emoji ? html`<span class="row-emoji" aria-hidden="true">${t.emoji}</span>` : ''}
              ${t.title}
            </div>
            <div class="summary">${t.summary}</div>
            ${t.tags && t.tags.length ? html`
              <div class="row-tags">${t.tags.map(tag => html`<span class="tag">${tag}</span>`)}</div>
            ` : ''}
          </div>
          <div class="row-actions">
            <button type="button" class="btn-ghost"
              @click=${() => this._toggleExpand(t.id)}
              aria-expanded=${expanded}>
              ${expanded ? 'Hide' : 'Preview'}
            </button>
            <button type="button" class="btn-primary"
              @click=${() => this._add(t)}
              ?disabled=${!!this._creatingId}>
              ${creating ? 'Adding…' : 'Add card'}
            </button>
          </div>
        </div>
        ${expanded ? html`
          <div class="row-preview"><pre>${JSON.stringify(t.manifest, null, 2)}</pre></div>
        ` : ''}
      </li>
    `;
  }

  render() {
    return html`
      <dialog @close=${this._handleDialogClose}>
        <div class="shell">
          <header>
            <h2>Add a card from a template</h2>
            <button type="button" class="close" @click=${this._close} aria-label="Close">✕</button>
          </header>
          <div class="toolbar">
            <input
              class="search"
              type="search"
              placeholder="Search templates…"
              .value=${this._filter}
              @input=${e => this._filter = e.target.value}
            />
          </div>
          ${this._createError ? html`<div class="banner error" role="alert">${this._createError}</div>` : ''}
          <div class="body">${this._renderList()}</div>
        </div>
      </dialog>
    `;
  }

  static styles = css`
    dialog {
      border: none;
      padding: 0;
      border-radius: 12px;
      background: var(--bg-card, #fff);
      color: var(--text-primary, #111);
      width: min(760px, 95vw);
      max-height: 90vh;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    }
    /* Mobile-first: full-bleed sheet at narrow widths. */
    @media (max-width: 520px) {
      dialog {
        width: 100vw;
        max-width: 100vw;
        height: 100vh;
        max-height: 100vh;
        border-radius: 0;
        padding-top: env(safe-area-inset-top, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
    }
    .shell { display: flex; flex-direction: column; max-height: 90vh; }
    @media (max-width: 520px) { .shell { max-height: 100vh; } }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid var(--border);
    }
    header h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .close {
      background: none; border: none; cursor: pointer; font-size: 18px;
      color: var(--text-secondary); padding: 4px 10px; min-height: 44px;
    }
    .close:hover { color: var(--text-primary); }
    .toolbar { padding: 12px 18px 8px; }
    .search {
      width: 100%; padding: 10px; border: 1px solid var(--border);
      border-radius: 6px; background: var(--bg-input, transparent);
      color: inherit;
      /* 16px keeps iOS Safari from auto-zooming on focus. */
      font-size: 16px;
    }
    .banner {
      margin: 0 18px 8px; padding: 10px 12px; border-radius: 8px;
      font-size: 12.5px; line-height: 1.5;
    }
    .banner.error {
      background: rgba(220, 53, 69, 0.1); color: #ff6b6b;
      border: 1px solid rgba(220, 53, 69, 0.3);
    }
    .body { overflow: auto; padding: 6px 18px 18px; }
    .empty {
      padding: 24px 10px; color: var(--text-secondary);
      font-size: 13px; text-align: center;
    }
    .empty.error { color: var(--accent-red, #ff4444); }
    .empty .sub {
      margin-top: 8px; font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
    }
    .template-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .row {
      border: 1px solid var(--border); border-radius: 10px;
      padding: 14px 16px; background: var(--bg-input, rgba(0, 0, 0, 0.02));
      position: relative;
    }
    .row.featured {
      border-color: var(--accent, #00d4aa);
      background: rgba(0, 212, 170, 0.06);
    }
    .featured-chip {
      position: absolute; top: -9px; left: 14px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
      text-transform: uppercase; padding: 3px 8px;
      background: var(--accent, #00d4aa); color: #000; border-radius: 10px;
    }
    .row-head { display: flex; align-items: flex-start; gap: 14px; }
    .row-body { flex: 1; min-width: 0; }
    .row-title {
      font-size: 14px; font-weight: 700; color: var(--text-primary);
      margin-bottom: 4px; display: flex; align-items: center; gap: 7px;
    }
    .row-emoji { font-size: 16px; }
    .summary {
      font-size: 12.5px; line-height: 1.5;
      color: var(--text-secondary); margin-bottom: 6px;
    }
    .row-tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag {
      font-size: 10.5px; padding: 2px 7px;
      background: var(--bg-hover, rgba(0, 0, 0, 0.05));
      border-radius: 10px; color: var(--text-muted, var(--text-secondary));
    }
    .row-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
    @media (max-width: 520px) {
      .row-head { flex-direction: column; }
      .row-actions { flex-direction: row; }
    }
    .btn-primary, .btn-ghost {
      padding: 9px 12px; border-radius: 6px; font-size: 12px;
      font-weight: 600; cursor: pointer; border: 1px solid var(--border);
      white-space: nowrap; min-height: 44px;
    }
    .btn-primary {
      background: var(--accent, #00d4aa); color: #000;
      border-color: var(--accent, #00d4aa);
    }
    .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
    .btn-primary:disabled { opacity: 0.5; cursor: wait; }
    .btn-ghost { background: transparent; color: inherit; }
    .btn-ghost:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.05)); }
    .row-preview {
      margin-top: 10px; padding: 10px 12px; background: var(--bg-card, #fff);
      border: 1px solid var(--border); border-radius: 6px;
      max-height: 300px; overflow: auto;
    }
    .row-preview pre {
      margin: 0; white-space: pre-wrap; word-wrap: break-word;
      font-size: 12px; line-height: 1.5; font-family: ui-monospace, Menlo, Consolas, monospace;
      color: var(--text-primary);
    }
  `;
}
customElements.define('eh-card-gallery', EhCardGallery);
