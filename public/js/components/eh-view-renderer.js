// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-view-renderer.js
// Generic view composer. Fetches /api/views/:viewName, resolves each card's
// renderer via the renderer-registry, instantiates it with the right props.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import Sortable from 'https://esm.sh/sortablejs@1.15.2';
import { resolveRenderer } from '../renderer-registry.js';

// Ensure all core renderers are loaded
import './eh-unknown-card.js';
import './eh-generic-card.js';
import './eh-list-card.js';
import './eh-greeting-banner.js';
import './eh-checklist-card.js';
import './eh-schedule-card.js';
import './eh-markdown-doc.js';
import './eh-line-chart.js';
import './eh-schedule-timeline.js';
import './eh-adherence-report.js';
import './eh-table-list.js';
import './eh-combination-card.js';
import './eh-welcome-card.js';

export class EhViewRenderer extends LitElement {
  static properties = {
    view: { type: String },       // "view" | "trends" | "reports" | etc.
    date: { type: String },
    dateMode: { type: String },
    cards: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _manifestErrors: { state: true },
    _allCardsCount: { state: true },
    _disabledCount: { state: true },
    _errorsExpanded: { state: true },
    _reorderMode: { state: true },
    _reorderError: { state: true },
    _reorderSaving: { state: true },
    _ariaAnnouncement: { state: true },
  };

  constructor() {
    super();
    this.view = 'view';
    this.date = null;
    this.dateMode = 'today';
    this.cards = [];
    this._loading = true;
    this._error = null;
    this._manifestErrors = [];
    this._allCardsCount = 0;
    this._disabledCount = 0;
    this._errorsExpanded = false;
    this._reorderMode = false;
    this._reorderError = null;
    this._reorderSaving = false;
    this._ariaAnnouncement = '';
    this._sortable = null;
    this._onReorderEvent = () => { this._enterReorderMode(); };
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchCards();
    window.addEventListener('klebb-enter-reorder-mode', this._onReorderEvent);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('klebb-enter-reorder-mode', this._onReorderEvent);
    this._destroySortable();
  }

  static styles = css`
    :host { display: block; }
    .grid {
      display: grid;
      /* minmax(0, 1fr) — NOT plain 1fr. A plain 1fr track resolves to
         minmax(auto, 1fr), which lets a card whose intrinsic min-content
         is wider than its share (a long nowrap string inside a row) push
         its track wider and drag every other card with it. This is the
         root cause of the supplements card blowing the whole Today page
         past the viewport on iPhone 13 mini. Pinning the track min to 0
         forces children to shrink to fit and lets per-card overflow
         handling (nowrap + ellipsis) do its job. */
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
      margin-top: 6px;
    }
    @media (min-width: 768px) {
      .grid {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
    }
    @media (min-width: 1100px) {
      .grid {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
      }
    }

    /* Masonry layout via CSS multi-column. Used outside of reorder mode
       so short cards pack upwards into the gaps left by taller cards
       (e.g. Symptoms/Appointments filling space under Medication/Mood).
       Reorder mode stays on grid because SortableJS misbehaves inside
       column layouts. */
    .masonry {
      column-count: 1;
      column-gap: 12px;
      margin-top: 6px;
    }
    .masonry > * {
      break-inside: avoid;
      margin-bottom: 12px;
      /* display:block on the wrapper so column layout treats it as one
         unit rather than trying to split its contents. */
      display: block;
    }
    .masonry > .slot-top {
      column-span: all;
    }
    @media (min-width: 768px) {
      .masonry { column-count: 2; }
    }
    @media (min-width: 1100px) {
      .masonry { column-count: 3; }
    }
    .loading, .empty {
      padding: 40px 20px;
      text-align: center;
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      line-height: 1.5;
    }
    .empty code {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      background: var(--bg-muted, rgba(255,255,255,0.04));
      padding: 2px 6px;
      border-radius: 4px;
    }
    .slot-top {
      grid-column: 1 / -1;
    }
    .error-pill {
      background: var(--bg-card);
      border: 1px solid #ff7733;
      border-left-width: 4px;
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 10px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      user-select: none;
    }
    .error-pill:hover { border-color: #ff4466; }
    .error-pill-icon { margin-right: 6px; }
    .error-list {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
      font-family: ui-monospace, monospace;
      font-size: 11px;
      text-align: left;
    }
    .error-list-item {
      padding: 2px 0;
      color: var(--text-secondary);
    }
    .error-list-file { color: var(--text-primary); font-weight: 600; }
    .disabled-hint {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px 18px;
      margin-bottom: 10px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-primary);
      text-align: left;
    }
    .disabled-hint a {
      color: var(--accent);
      text-decoration: underline;
    }

    /* --- Reorder mode --- */
    .reorder-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      margin-bottom: 10px;
      background: var(--accent-bg, rgba(0,212,170,0.08));
      border: 1px solid var(--accent);
      border-radius: 8px;
      font-size: 13px;
      color: var(--text-primary);
    }
    .reorder-bar-label { font-weight: 600; }
    .reorder-bar-done {
      background: var(--accent);
      color: var(--text-inverse, #fff);
      border: none;
      border-radius: 6px;
      padding: 6px 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .reorder-bar-done:focus-visible {
      outline: 2px solid var(--text-primary);
      outline-offset: 2px;
    }
    .reorder-error {
      color: #ff4466;
      font-size: 12px;
      margin-bottom: 8px;
      padding: 0 4px;
    }
    .card-wrap { position: relative; }
    .card-wrap.reorder-active {
      cursor: grab;
      outline: 1px dashed var(--accent);
      outline-offset: 3px;
      border-radius: 10px;
    }
    .drag-handle {
      position: absolute;
      top: 8px;
      left: 8px;
      width: 28px;
      height: 28px;
      background: var(--bg-card);
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 50%;
      cursor: grab;
      font-size: 14px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 5;
      line-height: 1;
    }
    .drag-handle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .drag-chosen { opacity: 0.85; }
    .drag-ghost { opacity: 0.3; }

    .sr-live {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      .reorder-bar-done, .drag-handle { transition: none; }
    }
  `;

  updated(changed) {
    // The card LIST only depends on the view name — not the date.
    // Don't re-fetch /api/views/:name when only the date changed; just
    // update the date/dateMode props on the child cards (Lit handles that
    // via the standard property reactivity in render()).
    if (changed.has('view')) {
      this._fetchCards();
      // Exiting reorder mode on view change is safer than carrying it across
      if (this._reorderMode) this._exitReorderMode();
    }
    // Wire/unwire Sortable when reorder-mode or cards change
    if (changed.has('_reorderMode') || changed.has('cards')) {
      this._refreshSortable();
    }
  }

  async _fetchCards() {
    this._loading = true;
    this._error = null;
    try {
      const res = await fetch(`/api/views/${encodeURIComponent(this.view)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      this.cards = Array.isArray(body.cards) ? body.cards : [];
      this._manifestErrors = Array.isArray(body.errors) ? body.errors : [];
      // If the view returned 0 cards, peek at the Settings list to figure
      // out WHY — to give a useful empty-state message.
      if (this.cards.length === 0) {
        try {
          const s = await fetch('/api/settings/cards');
          if (s.ok) {
            const sBody = await s.json();
            this._allCardsCount = Array.isArray(sBody.cards) ? sBody.cards.length : 0;
            this._disabledCount = Array.isArray(sBody.cards)
              ? sBody.cards.filter(c => c.enabled === false).length
              : 0;
          }
        } catch {}
      }
    } catch (e) {
      this._error = e.message || 'fetch failed';
    } finally {
      this._loading = false;
    }
  }

  _renderCard(card) {
    const tag = resolveRenderer(card.viewConfig?.component);
    const isTopSlot = card.viewConfig?.slot === 'top';
    const inner = document.createElement(tag);
    inner.card = card;
    inner.date = this.date;
    inner.dateMode = this.dateMode;

    // Always wrap in a container so Sortable has a stable handle. The
    // wrapper carries the data-card-id attribute the reorder logic reads.
    const wrap = document.createElement('div');
    wrap.className = 'card-wrap' + (isTopSlot ? ' slot-top' : '');
    wrap.dataset.cardId = card.id;
    if (this._reorderMode) {
      const handle = document.createElement('button');
      handle.className = 'drag-handle';
      handle.type = 'button';
      handle.setAttribute('aria-label', `Drag handle for ${card.meta?.label || card.id}`);
      handle.textContent = '⋮⋮';
      // Keyboard reorder: focus handle, arrow-up/down moves this card.
      handle.addEventListener('keydown', (e) => this._onHandleKeydown(e, card.id));
      wrap.appendChild(handle);
      wrap.classList.add('reorder-active');
    }
    wrap.appendChild(inner);
    return wrap;
  }

  _enterReorderMode() {
    // Only makes sense if there's more than one card to reorder
    if (!this.cards || this.cards.length < 2) return;
    this._reorderMode = true;
    this._reorderError = null;
    this._ariaAnnouncement = 'Reorder mode on. Drag cards to reorder, or tab to a drag handle and press the up or down arrow to move it.';
  }

  _onHandleKeydown(e, cardId) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const idx = this.cards.findIndex(c => c.id === cardId);
    if (idx < 0) return;
    const delta = e.key === 'ArrowUp' ? -1 : 1;
    const target = idx + delta;
    if (target < 0 || target >= this.cards.length) return;
    // Swap in place, then POST the whole new order
    const newList = [...this.cards];
    [newList[idx], newList[target]] = [newList[target], newList[idx]];
    const newOrder = newList.map(c => c.id);
    this._ariaAnnouncement = `${this.cards[idx].meta?.label || cardId} moved ${e.key === 'ArrowUp' ? 'up' : 'down'}.`;
    // Fire-and-forget: the onEnd path (drag) does exactly the same thing.
    // Reuse it by monkey-setting the DOM order first isn't clean, so just
    // call the save directly with the new order.
    this._saveReorder(newOrder);
    // Keep focus on the handle in the NEW position after the re-render
    this._refocusAfterUpdate = cardId;
  }

  async _saveReorder(newOrder) {
    this._reorderSaving = true;
    this._reorderError = null;
    try {
      const res = await fetch('/api/manifests/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: newOrder }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const byId = new Map(this.cards.map(c => [c.id, c]));
      this.cards = newOrder.map(id => byId.get(id)).filter(Boolean);
    } catch (e) {
      this._reorderError = e.message || 'reorder failed';
      this._fetchCards();
    } finally {
      this._reorderSaving = false;
    }
  }

  _exitReorderMode() {
    this._reorderMode = false;
    this._reorderError = null;
    this._destroySortable();
    this._ariaAnnouncement = 'Reorder mode off.';
  }

  _destroySortable() {
    if (this._sortable) {
      try { this._sortable.destroy(); } catch {}
      this._sortable = null;
    }
  }

  _refreshSortable() {
    this._destroySortable();
    if (!this._reorderMode) return;
    const gridEl = this.shadowRoot?.querySelector('.grid');
    if (!gridEl) return;
    this._sortable = Sortable.create(gridEl, {
      animation: 150,
      handle: '.drag-handle',
      ghostClass: 'drag-ghost',
      chosenClass: 'drag-chosen',
      onEnd: () => this._onReorderEnd(),
    });
  }

  async _onReorderEnd() {
    // Read the id order from the DOM (Sortable has just updated it)
    const grid = this.shadowRoot?.querySelector('.grid');
    if (!grid) return;
    const newOrder = [];
    for (const child of grid.children) {
      const id = child.dataset?.cardId;
      if (id) newOrder.push(id);
    }
    if (newOrder.length === 0) return;
    await this._saveReorder(newOrder);
    this._ariaAnnouncement = `Reorder saved. New first card: ${this.cards[0]?.meta?.label || this.cards[0]?.id}.`;
  }

  _renderReorderBar() {
    if (!this._reorderMode) return '';
    return html`
      <div class="reorder-bar" role="region" aria-label="Reorder mode">
        <span class="reorder-bar-label">
          ⋮⋮ Drag cards to reorder
          ${this._reorderSaving ? html` · <em>saving…</em>` : ''}
        </span>
        <button class="reorder-bar-done" @click=${this._exitReorderMode}>Done</button>
      </div>
      ${this._reorderError ? html`
        <div class="reorder-error">${this._reorderError}</div>
      ` : ''}
    `;
  }

  _renderErrorPill() {
    const errs = this._manifestErrors || [];
    if (errs.length === 0) return '';
    return html`
      <div
        class="error-pill"
        role="button"
        tabindex="0"
        aria-expanded="${this._errorsExpanded}"
        @click=${() => { this._errorsExpanded = !this._errorsExpanded; }}
        @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._errorsExpanded = !this._errorsExpanded; } }}
      >
        <span class="error-pill-icon">⚠︎</span>
        ${errs.length} manifest file${errs.length === 1 ? '' : 's'} failed to load
        — click to ${this._errorsExpanded ? 'hide' : 'show'}
        ${this._errorsExpanded ? html`
          <div class="error-list">
            ${errs.map(e => html`
              <div class="error-list-item">
                <span class="error-list-file">${e.file}</span>: ${e.error}
              </div>
            `)}
          </div>
        ` : ''}
      </div>
    `;
  }

  _renderAllDisabledHint() {
    return html`
      <div class="disabled-hint">
        <strong>All cards are hidden.</strong>
        You have ${this._disabledCount} card${this._disabledCount === 1 ? '' : 's'}
        but they're all toggled off.
        Head to <a href="/settings">Settings</a> to re-enable some.
      </div>
    `;
  }

  render() {
    if (this._loading) {
      return html`<div class="loading">Loading…</div>`;
    }
    if (this._error) {
      return html`<div class="loading">Failed to load: ${this._error}</div>`;
    }
    if (!this.cards || this.cards.length === 0) {
      // Three empty-state shapes, most-specific first:
      // (1) There ARE cards but they're all disabled → point at Settings
      // (2) There are NO cards at all → docs link
      // (3) Fallback (e.g. cards exist but none have data yet)
      if (this._allCardsCount > 0 && this._disabledCount === this._allCardsCount) {
        return html`
          ${this._renderErrorPill()}
          ${this._renderAllDisabledHint()}
        `;
      }
      if (this._allCardsCount === 0) {
        return html`
          ${this._renderErrorPill()}
          <div class="empty">
            <p>No cards yet.</p>
            <p style="margin-top:8px;">
              Drop a manifest file into <code>$HEALTH_HOME/data/</code> to add
              one, or
              <a href="https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md"
                 target="_blank" rel="noopener"
                 style="color: var(--accent); text-decoration: underline;">
                read the docs →
              </a>
            </p>
          </div>
        `;
      }
      return html`
        ${this._renderErrorPill()}
        <div class="empty">
          <p>No data yet for this view.</p>
          <p style="margin-top:8px;">
            Your cards are set up but nothing's been logged yet.
            Switch to <a href="/" style="color: var(--accent);">Today</a>
            and tap ➕ to log your first entry.
          </p>
        </div>
      `;
    }
    // Normal render
    return html`
      <div class="sr-live" aria-live="polite" aria-atomic="true">${this._ariaAnnouncement}</div>
      ${this._renderReorderBar()}
      ${this._renderErrorPill()}
      <div class=${this._reorderMode ? 'grid' : 'masonry'}>
        ${this.cards.map(c => this._renderCard(c))}
      </div>
    `;
  }
}
customElements.define('eh-view-renderer', EhViewRenderer);
