// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-prompts-gallery.js — starter-prompts gallery modal.
//
// Opens from the welcome card's "Starter prompts" action. Lists prompts
// fetched from /api/prompts. Clicking "Load into chat" pastes the prompt
// body into the chat input (without sending) and opens the chat panel.
// If the chat gateway isn't configured, the action becomes "Copy to
// clipboard" with an inline note.
//
//   const m = document.createElement('eh-prompts-gallery');
//   document.body.appendChild(m);
//   m.open();

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { errorFromResponse } from '../lib/save-error.js';

const FEATURED_ID = 'new-to-klebb';

export class EhPromptsGallery extends LitElement {
  static properties = {
    _prompts: { state: true },
    _loading: { state: true },
    _loadError: { state: true },
    _filter: { state: true },
    _chatConfigured: { state: true },
    _copiedId: { state: true },
    _expandedId: { state: true },
  };

  constructor() {
    super();
    this._prompts = [];
    this._loading = true;
    this._loadError = null;
    this._filter = '';
    this._chatConfigured = null;
    this._copiedId = null;
    this._expandedId = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadPrompts();
    this._loadChatStatus();
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

  async _loadPrompts() {
    this._loading = true;
    this._loadError = null;
    try {
      const r = await fetch('/api/prompts');
      if (!r.ok) throw await errorFromResponse(r);
      const body = await r.json();
      this._prompts = body.prompts || [];
    } catch (e) {
      this._loadError = e.message || 'Could not load prompts.';
    } finally {
      this._loading = false;
    }
  }

  async _loadChatStatus() {
    try {
      const r = await fetch('/api/chat/status');
      if (!r.ok) { this._chatConfigured = false; return; }
      const body = await r.json();
      this._chatConfigured = !!body.configured;
    } catch {
      this._chatConfigured = false;
    }
  }

  _filteredPrompts() {
    const q = (this._filter || '').trim().toLowerCase();
    if (!q) return this._prompts;
    return this._prompts.filter(p => {
      const hay = `${p.title} ${p.summary} ${(p.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }

  _orderPrompts(list) {
    const featured = list.find(p => p.id === FEATURED_ID);
    const rest = list.filter(p => p.id !== FEATURED_ID);
    return featured ? [featured, ...rest] : list;
  }

  _action(prompt) {
    if (this._chatConfigured) {
      window.dispatchEvent(new CustomEvent('klebb-paste-into-chat', {
        detail: { text: prompt.body },
      }));
      this._close();
    } else {
      this._copy(prompt);
    }
  }

  async _copy(prompt) {
    try {
      await navigator.clipboard.writeText(prompt.body);
      this._copiedId = prompt.id;
      setTimeout(() => { if (this._copiedId === prompt.id) this._copiedId = null; }, 1800);
    } catch {
      // Fallback: select into a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = prompt.body;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
      this._copiedId = prompt.id;
      setTimeout(() => { if (this._copiedId === prompt.id) this._copiedId = null; }, 1800);
    }
  }

  _toggleExpand(id) {
    this._expandedId = this._expandedId === id ? null : id;
  }

  _renderList() {
    if (this._loading) return html`<div class="empty">Loading prompts…</div>`;
    if (this._loadError) return html`<div class="empty error">⚠︎ ${this._loadError}</div>`;

    const filtered = this._filteredPrompts();
    if (!filtered.length) {
      return html`<div class="empty">
        No prompts match.
        ${this._prompts.length === 0 ? html`
          <div class="sub">See <code>CONTRIBUTING-PROMPTS.md</code> to add one.</div>
        ` : ''}
      </div>`;
    }

    const ordered = this._orderPrompts(filtered);
    return html`
      <ul class="prompt-list">
        ${ordered.map(p => this._renderRow(p))}
      </ul>
    `;
  }

  _renderRow(p) {
    const isFeatured = p.id === FEATURED_ID;
    const isExpanded = this._expandedId === p.id;
    const copied = this._copiedId === p.id;
    const actionLabel = this._chatConfigured === false
      ? (copied ? 'Copied ✓' : 'Copy to clipboard')
      : 'Load into chat →';
    return html`
      <li class="row ${isFeatured ? 'featured' : ''} ${isExpanded ? 'expanded' : ''}">
        ${isFeatured ? html`<div class="featured-chip">★ Start here</div>` : ''}
        <div class="row-head">
          <div class="row-body">
            <div class="row-title">${p.title}</div>
            <div class="row-summary">${p.summary}</div>
            ${p.tags && p.tags.length ? html`
              <div class="row-tags">
                ${p.tags.map(t => html`<span class="tag">${t}</span>`)}
              </div>
            ` : ''}
          </div>
          <div class="row-actions">
            <button type="button" class="btn-ghost"
              @click=${() => this._toggleExpand(p.id)}
              aria-expanded=${isExpanded}>
              ${isExpanded ? 'Hide' : 'Preview'}
            </button>
            <button type="button" class="btn-primary"
              @click=${() => this._action(p)}
              ?disabled=${this._chatConfigured === null}>
              ${actionLabel}
            </button>
          </div>
        </div>
        ${isExpanded ? html`
          <div class="row-preview"><pre>${p.body}</pre></div>
        ` : ''}
      </li>
    `;
  }

  render() {
    const notConfigured = this._chatConfigured === false;
    return html`
      <dialog @close=${this._handleDialogClose}>
        <div class="shell">
          <header>
            <h2>Starter prompts</h2>
            <button type="button" class="close" @click=${this._close} aria-label="Close">✕</button>
          </header>
          <div class="toolbar">
            <input
              class="search"
              type="search"
              placeholder="Search prompts…"
              .value=${this._filter}
              @input=${e => this._filter = e.target.value}
            />
          </div>
          ${notConfigured ? html`
            <div class="banner">
              <strong>Chat agent not configured.</strong>
              Klebb is LLM-first and works best with a chat agent wired up.
              You can still copy any prompt to paste into another tool, or
              set up a chat gateway (<a
                href="https://github.com/Aristocles/klebb/blob/main/docs/CHAT-AGENT.md"
                target="_blank"
                rel="noopener"
              >see docs</a>) to use them with Klebb's chat.
            </div>
          ` : ''}
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
    .shell { display: flex; flex-direction: column; max-height: 90vh; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
    }
    header h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .close {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 18px;
      color: var(--text-secondary);
      padding: 4px 10px;
    }
    .close:hover { color: var(--text-primary); }
    .toolbar { padding: 12px 18px 8px; }
    .search {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input, transparent);
      color: inherit;
      font-size: 13px;
    }
    .banner {
      margin: 0 18px 8px;
      padding: 10px 12px;
      background: rgba(255, 170, 0, 0.08);
      border: 1px solid rgba(255, 170, 0, 0.3);
      color: var(--text-primary);
      border-radius: 8px;
      font-size: 12.5px;
      line-height: 1.5;
    }
    .banner a { color: var(--accent, #2d7ff9); }
    .body { overflow: auto; padding: 6px 18px 18px; }
    .empty {
      padding: 24px 10px;
      color: var(--text-secondary);
      font-size: 13px;
      text-align: center;
    }
    .empty.error { color: var(--accent-red, #ff4444); }
    .empty .sub {
      margin-top: 6px;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
    }
    .prompt-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .row {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      background: var(--bg-input, rgba(0, 0, 0, 0.02));
      position: relative;
    }
    .row.featured {
      border-color: var(--accent, #00d4aa);
      background: rgba(0, 212, 170, 0.06);
    }
    .featured-chip {
      position: absolute;
      top: -9px;
      left: 14px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      padding: 3px 8px;
      background: var(--accent, #00d4aa);
      color: #000;
      border-radius: 10px;
    }
    .row-head {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    .row-body { flex: 1; min-width: 0; }
    .row-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .row-summary {
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    .row-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .tag {
      font-size: 10.5px;
      padding: 2px 7px;
      background: var(--bg-hover, rgba(0, 0, 0, 0.05));
      border-radius: 10px;
      color: var(--text-muted, var(--text-secondary));
    }
    .row-actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    @media (max-width: 520px) {
      .row-head { flex-direction: column; }
      .row-actions { flex-direction: row; }
    }
    .btn-primary, .btn-ghost {
      padding: 7px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      white-space: nowrap;
    }
    .btn-primary {
      background: var(--accent, #00d4aa);
      color: #000;
      border-color: var(--accent, #00d4aa);
    }
    .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
    .btn-primary:disabled { opacity: 0.5; cursor: wait; }
    .btn-ghost {
      background: transparent;
      color: inherit;
    }
    .btn-ghost:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.05)); }
    .row-preview {
      margin-top: 10px;
      padding: 10px 12px;
      background: var(--bg-card, #fff);
      border: 1px solid var(--border);
      border-radius: 6px;
      max-height: 300px;
      overflow: auto;
    }
    .row-preview pre {
      margin: 0;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-size: 12px;
      line-height: 1.5;
      font-family: inherit;
      color: var(--text-primary);
    }
  `;
}
customElements.define('eh-prompts-gallery', EhPromptsGallery);
