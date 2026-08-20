// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/chat/chat-drawer.js
// The conversation drawer: every stored conversation newest-first in a
// scroller, each row switchable, renamable inline, and deletable behind a
// two-tap confirm. The whole list renders because the store hard-caps at
// 100 and prunes the least recently active on create. The list refreshes
// on every open, which is also how async model-generated titles appear. A
// footer link surfaces feedback.
//
// The head carries the hamburger that opened the drawer (the drawer covers
// the panel header, so the header's copy is hidden behind it) and a search
// toggle. Both are positioned to land exactly where the header's controls
// sit, so opening the drawer reads as the same icons staying put.
//
// The drawer owns list display, search and the rename/delete calls;
// switching and reacting to the active conversation being deleted belong to
// <health-chat>, reached via events:
//   drawer-select {id}   user tapped a conversation
//   drawer-close         scrim tap / hamburger / close affordance
//   drawer-deleted {id}  a conversation was removed (host checks active)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import {
  listConversations, searchConversations, renameConversation, deleteConversation,
} from './transport.js';

const SEARCH_DEBOUNCE_MS = 200;

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(then).toLocaleDateString();
}

class ChatDrawer extends LitElement {
  static properties = {
    // Reflected: the slide-in CSS keys off :host([open]).
    open: { type: Boolean, reflect: true },
    activeId: { type: String, attribute: 'active-id' },
    _conversations: { state: true },
    _renamingId: { state: true },
    _confirmDeleteId: { state: true },
    _searchOpen: { state: true },
    _query: { state: true },
  };

  static styles = css`
    :host { display: contents; }

    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.35);
      z-index: 5;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    .drawer {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: min(300px, 85%);
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      z-index: 6;
      display: flex;
      flex-direction: column;
      transform: translateX(-102%);
      transition: transform 0.2s ease-out;
      box-shadow: 4px 0 24px rgba(0, 0, 0, 0.15);
    }
    :host([open]) .scrim { opacity: 1; pointer-events: auto; }
    :host([open]) .drawer { transform: translateX(0); }

    /* Padding and button metrics MIRROR .chat-header / .hdr-btn in
       health-chat.js (18px left, 10px top, 10px gap, 34x30 pills). The
       drawer covers the header, so matching them is what makes the
       hamburger look like it stayed put rather than moved. Keep the two in
       step, mobile block included. */
    .drawer-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: max(env(safe-area-inset-top, 0px), 10px) 12px 8px 18px;
      border-bottom: 1px solid var(--border);
    }
    .head-btn {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      min-width: 34px;
      height: 30px;
      padding: 0 8px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .head-btn:hover { border-color: var(--accent); color: var(--accent); }
    .head-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .head-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
    .head-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted, var(--text-secondary));
    }
    .search-input {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      font-family: inherit;
      background: var(--bg-input, rgba(0,0,0,0.04));
      color: var(--text-primary);
      border: 1px solid var(--accent);
      border-radius: 8px;
      padding: 5px 8px;
      outline: none;
    }

    .list {
      flex: 1;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      border-radius: 10px;
      padding: 8px 10px;
      cursor: pointer;
      min-height: 44px;
    }
    .row:hover { background: var(--bg-input, rgba(0,0,0,0.04)); }
    .row.active {
      background: var(--bg-input, rgba(0,0,0,0.06));
      outline: 1px solid var(--accent);
    }
    .row-main { flex: 1; min-width: 0; }
    .row-title {
      font-size: 13px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row-title.untitled { color: var(--text-secondary); font-style: italic; }
    .row-sub {
      font-size: 10px;
      color: var(--text-muted, var(--text-secondary));
    }
    /* Search hits only: the line of transcript that matched. */
    .row-snippet {
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row-btn {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--text-muted, var(--text-secondary));
      cursor: pointer;
      font-size: 12px;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .row-btn:hover { background: rgba(0, 0, 0, 0.06); color: var(--text-primary); }
    .row-btn.danger { color: #ff4466; font-size: 11px; }
    .rename-input {
      width: 100%;
      font-size: 13px;
      font-family: inherit;
      background: var(--bg-input, rgba(0,0,0,0.04));
      color: var(--text-primary);
      border: 1px solid var(--accent);
      border-radius: 6px;
      padding: 4px 6px;
      outline: none;
    }

    .empty {
      padding: 20px 12px;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      text-align: center;
    }

    .drawer-foot {
      border-top: 1px solid var(--border);
      padding: 8px 12px max(env(safe-area-inset-bottom, 0px), 8px);
    }
    ::slotted(*), .drawer-foot slot { display: block; }

    /* Same breakpoint and same 44px targets as the panel header's mobile
       block, so the hamburger keeps its position AND its size on a phone. */
    @media (max-width: 480px) {
      .drawer-head { padding-top: max(env(safe-area-inset-top, 0px), 14px); }
      .head-btn {
        min-width: 44px;
        height: 44px;
        font-size: 15px;
        border-radius: 14px;
      }
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.activeId = '';
    this._conversations = null;
    this._renamingId = null;
    this._confirmDeleteId = null;
    this._searchOpen = false;
    this._query = '';
    this._searchTimer = null;
    this._refreshToken = 0;
  }

  updated(changed) {
    if (changed.has('open') && this.open) {
      this._renamingId = null;
      this._confirmDeleteId = null;
      this._closeSearch();
      this._refresh();
    }
  }

  async _refresh() {
    // Type-ahead answers can land out of order; only the newest one may
    // paint, or a slow early keystroke overwrites a fast later one.
    const token = ++this._refreshToken;
    const q = this._query.trim();
    const rows = q ? await searchConversations(q) : await listConversations();
    if (token === this._refreshToken) this._conversations = rows;
  }

  _toggleSearch() {
    if (this._searchOpen) {
      this._closeSearch();
      this._refresh();
      return;
    }
    this._searchOpen = true;
    this.updateComplete.then(() => this.shadowRoot?.querySelector('.search-input')?.focus());
  }

  _closeSearch() {
    clearTimeout(this._searchTimer);
    this._searchTimer = null;
    this._searchOpen = false;
    this._query = '';
  }

  _onSearchInput(e) {
    this._query = e.target.value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._refresh(), SEARCH_DEBOUNCE_MS);
  }

  // Escape unwinds one layer at a time, matching the panel: the term first,
  // then the field. stopPropagation keeps the panel's window-level Escape
  // listener from closing the whole drawer on the first press.
  _onSearchKeydown(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (e.target.value || this._query) {
      e.target.value = '';
      this._query = '';
      clearTimeout(this._searchTimer);
      this._refresh();
      return;
    }
    this._closeSearch();
  }

  _emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  _select(id) {
    if (this._renamingId) return;
    this._emit('drawer-select', { id });
  }

  _startRename(e, convo) {
    e.stopPropagation();
    this._confirmDeleteId = null;
    this._renamingId = convo.id;
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector('.rename-input');
      if (input) { input.focus(); input.select(); }
    });
  }

  async _commitRename(convo, value) {
    const title = (value || '').trim();
    this._renamingId = null;
    if (!title || title === convo.title) return;
    if (await renameConversation(convo.id, title)) this._refresh();
  }

  // Deleting a transcript is destructive: first tap arms, second within
  // the same open confirms. Anything else disarms.
  async _deleteTap(e, convo) {
    e.stopPropagation();
    this._renamingId = null;
    if (this._confirmDeleteId !== convo.id) {
      this._confirmDeleteId = convo.id;
      return;
    }
    this._confirmDeleteId = null;
    if (await deleteConversation(convo.id)) {
      this._emit('drawer-deleted', { id: convo.id });
      this._refresh();
    }
  }

  _renderRow(convo) {
    const renaming = this._renamingId === convo.id;
    const arming = this._confirmDeleteId === convo.id;
    return html`
      <div
        class="row ${convo.id === this.activeId ? 'active' : ''}"
        role="button"
        tabindex="0"
        @click=${() => this._select(convo.id)}
        @keydown=${(e) => { if (e.key === 'Enter') this._select(convo.id); }}
      >
        <div class="row-main">
          ${renaming ? html`
            <input
              class="rename-input"
              .value=${convo.title || ''}
              aria-label="Conversation title"
              @click=${(e) => e.stopPropagation()}
              @keydown=${(e) => {
                if (e.key === 'Enter') this._commitRename(convo, e.target.value);
                // Cancelling a rename must not also close the drawer, which
                // the panel's window-level Escape listener would do.
                if (e.key === 'Escape') { e.stopPropagation(); this._renamingId = null; }
              }}
              @blur=${(e) => this._commitRename(convo, e.target.value)}
            />
          ` : html`
            <div class="row-title ${convo.title ? '' : 'untitled'}">${convo.title || 'New chat'}</div>
            ${convo.snippet ? html`<div class="row-snippet">${convo.snippet}</div>` : ''}
            <div class="row-sub">${relativeTime(convo.updatedAt)}</div>
          `}
        </div>
        ${renaming ? '' : html`
          <button
            class="row-btn"
            aria-label="Rename conversation"
            title="Rename"
            @click=${(e) => this._startRename(e, convo)}
          >✎</button>
          <button
            class="row-btn danger"
            aria-label=${arming ? 'Confirm delete' : 'Delete conversation'}
            title=${arming ? 'Tap again to delete' : 'Delete'}
            @click=${(e) => this._deleteTap(e, convo)}
          >${arming ? 'Sure?' : '🗑'}</button>
        `}
      </div>
    `;
  }

  _renderHead() {
    const searching = this._searchOpen;
    return html`
      <div class="drawer-head">
        <button
          class="head-btn"
          @click=${() => this._emit('drawer-close')}
          aria-label="Close conversations"
          title="Close"
        >☰</button>
        <button
          class="head-btn"
          @click=${this._toggleSearch}
          aria-label=${searching ? 'Close search' : 'Search conversations'}
          aria-pressed=${searching}
          title=${searching ? 'Close search' : 'Search chats'}
        >${searching ? '✕' : '🔍'}</button>
        ${searching ? html`
          <input
            class="search-input"
            type="search"
            placeholder="Search all chats…"
            aria-label="Search conversations"
            @input=${this._onSearchInput}
            @keydown=${this._onSearchKeydown}
          />
        ` : html`<span class="head-label">Conversations</span>`}
      </div>
    `;
  }

  render() {
    const all = this._conversations || [];
    const searched = this._query.trim();
    return html`
      <div class="scrim" @click=${() => this._emit('drawer-close')}></div>
      <div class="drawer" role="dialog" aria-label="Conversations">
        ${this._renderHead()}
        <div class="list">
          ${this._conversations === null ? html`<div class="empty">Loading…</div>` : ''}
          ${this._conversations !== null && all.length === 0
            ? html`<div class="empty">${searched
                ? `No chats match "${searched}".`
                : 'No conversations yet.'}</div>`
            : ''}
          ${all.map(c => this._renderRow(c))}
        </div>
        <div class="drawer-foot"><slot name="footer"></slot></div>
      </div>
    `;
  }
}

customElements.define('chat-drawer', ChatDrawer);
