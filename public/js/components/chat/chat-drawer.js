// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/chat/chat-drawer.js
// The conversation drawer: new chat pinned on top, then conversations
// newest-first (five, with a show-all expander; the store caps at 100),
// each row switchable, renamable inline, and deletable behind a two-tap
// confirm. The list refreshes on every open, which is also how async
// model-generated titles appear. A footer link surfaces feedback.
//
// The drawer owns list display and the rename/delete calls; switching,
// new-chat semantics, and reacting to the active conversation being
// deleted belong to <health-chat>, reached via events:
//   drawer-select {id}   user tapped a conversation
//   drawer-new           user tapped New chat
//   drawer-close         scrim tap / close affordance
//   drawer-deleted {id}  a conversation was removed (host checks active)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { listConversations, renameConversation, deleteConversation } from './transport.js';

const PREVIEW_COUNT = 5;

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
    _showAll: { state: true },
    _renamingId: { state: true },
    _confirmDeleteId: { state: true },
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

    .drawer-head {
      padding: max(env(safe-area-inset-top, 0px), 12px) 12px 8px;
      border-bottom: 1px solid var(--border);
    }
    .new-chat {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-primary);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      min-height: 44px;
    }
    .new-chat:hover { border-color: var(--accent); color: var(--accent); }

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

    .show-all {
      background: transparent;
      border: none;
      color: var(--accent);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      padding: 8px;
      text-align: left;
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
  `;

  constructor() {
    super();
    this.open = false;
    this.activeId = '';
    this._conversations = null;
    this._showAll = false;
    this._renamingId = null;
    this._confirmDeleteId = null;
  }

  updated(changed) {
    if (changed.has('open') && this.open) {
      this._showAll = false;
      this._renamingId = null;
      this._confirmDeleteId = null;
      this._refresh();
    }
  }

  async _refresh() {
    this._conversations = await listConversations();
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
                if (e.key === 'Escape') this._renamingId = null;
              }}
              @blur=${(e) => this._commitRename(convo, e.target.value)}
            />
          ` : html`
            <div class="row-title ${convo.title ? '' : 'untitled'}">${convo.title || 'New chat'}</div>
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

  render() {
    const all = this._conversations || [];
    const visible = this._showAll ? all : all.slice(0, PREVIEW_COUNT);
    const hidden = all.length - visible.length;
    return html`
      <div class="scrim" @click=${() => this._emit('drawer-close')}></div>
      <div class="drawer" role="dialog" aria-label="Conversations">
        <div class="drawer-head">
          <button class="new-chat" @click=${() => this._emit('drawer-new')} aria-label="New chat">
            <span>＋</span><span>New chat</span>
          </button>
        </div>
        <div class="list">
          ${this._conversations === null ? html`<div class="empty">Loading…</div>` : ''}
          ${this._conversations !== null && all.length === 0
            ? html`<div class="empty">No conversations yet.</div>` : ''}
          ${visible.map(c => this._renderRow(c))}
          ${hidden > 0 ? html`
            <button class="show-all" @click=${() => { this._showAll = true; }}>
              Show all (${all.length})
            </button>
          ` : ''}
        </div>
        <div class="drawer-foot"><slot name="footer"></slot></div>
      </div>
    `;
  }
}

customElements.define('chat-drawer', ChatDrawer);
