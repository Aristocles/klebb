// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-reminder-modal.js — surfaced after a notification tap to re-show
// the things the notification was reminding about. The OS banner
// already named them once; this gives them somewhere durable to land.
//
// The modal renders entirely from the data passed via .reminders;
// it does not fetch the source card. The SW already includes
// cardLabel/cardEmoji per group, so there's no manifest dependency.
//
// Public API:
//   <eh-reminder-modal
//     .reminders=${[
//       {
//         cardId: 'peptide-cycle',
//         cardLabel: 'Injections',
//         cardEmoji: '💉',
//         due_now: [{name, short_name}, ...],
//         missed_earlier: [{name, short_name}, ...],
//       },
//       ...
//     ]}
//     @eh-reminder-done=${this._onReminderDone}
//   ></eh-reminder-modal>
//
// Events:
//   eh-reminder-done: fired on close (✕, Escape, backdrop, "Open card",
//   or auto-close when reminders is empty). No detail.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhReminderModal extends LitElement {
  static properties = {
    reminders: { type: Array },
  };

  constructor() {
    super();
    this.reminders = null;
  }

  static styles = css`
    :host { position: relative; }

    dialog {
      border: none;
      padding: 0;
      margin: 0;
      width: 100vw;
      height: 100vh;
      max-width: 100vw;
      max-height: 100vh;
      background: transparent;
      overflow: visible;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    }

    .wrap {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }
    @media (min-width: 640px) {
      .wrap { align-items: center; }
    }

    .panel {
      position: relative;
      width: 100%;
      max-width: 520px;
      max-height: 92vh;
      overflow-y: auto;
      overflow-x: hidden;
      background: var(--bg-card, #1a1a1a);
      color: var(--text-primary);
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.35);
      padding: 20px 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .panel * { box-sizing: border-box; }
    @media (min-width: 640px) {
      .panel {
        border-radius: 16px;
        box-shadow: 0 8px 60px rgba(0, 0, 0, 0.45);
      }
    }

    .grip {
      align-self: center;
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: var(--border);
      margin-top: -6px;
    }
    @media (min-width: 640px) {
      .grip { display: none; }
    }

    .header {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .title-block { flex: 1; min-width: 0; }
    .title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
      line-height: 1.2;
    }
    .subtitle {
      font-size: 13px;
      color: var(--text-secondary);
      margin: 2px 0 0;
      line-height: 1.35;
    }

    .close-btn {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 22px;
      line-height: 1;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 6px;
      flex-shrink: 0;
    }
    .close-btn:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.05)); color: var(--text-primary); }
    .close-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border-radius: 12px;
      background: var(--bg-hover, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border);
    }
    .group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .group-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      min-width: 0;
    }
    .group-emoji { font-size: 18px; line-height: 1; flex-shrink: 0; }

    .group-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .group-section.missed { opacity: 0.85; }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted, var(--text-secondary));
      margin: 0;
    }
    .group-section.missed .section-title { color: var(--text-secondary); }

    .row {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 0;
      border-top: 1px solid var(--border);
    }
    .row:first-of-type { border-top: none; padding-top: 0; }
    .row-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      overflow-wrap: anywhere;
    }
    .row-meta {
      font-size: 12px;
      color: var(--text-secondary);
      overflow-wrap: anywhere;
    }

    .open-btn {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }
    .open-btn:hover { filter: brightness(1.08); }
  `;

  firstUpdated() {
    if (!this._hasAnyRows()) {
      // Defensive: an empty reminders payload should never reach the
      // modal (the app shell gates on it), but if it does, close
      // immediately rather than render an empty dialog.
      queueMicrotask(() => this._finish());
      return;
    }
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && typeof dlg.showModal === 'function') {
      try { dlg.showModal(); }
      catch { dlg.setAttribute('open', ''); }
    }
    if (dlg) {
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        this._finish();
      });
    }
  }

  _finish() {
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && dlg.open) {
      try { dlg.close(); } catch { /* noop */ }
    }
    this.dispatchEvent(new CustomEvent('eh-reminder-done', {
      bubbles: true,
      composed: true,
    }));
  }

  _openCard(cardId) {
    if (cardId) {
      const path = '/?card=' + encodeURIComponent(cardId);
      window.dispatchEvent(new CustomEvent('navigate', { detail: { path } }));
    }
    this._finish();
  }

  _groups() {
    return (Array.isArray(this.reminders) ? this.reminders : [])
      .filter(g => g && ((g.due_now || []).length || (g.missed_earlier || []).length));
  }

  _hasAnyRows() {
    return this._groups().length > 0;
  }

  render() {
    const groups = this._groups();
    if (groups.length === 0) return html``;
    return html`
      <dialog aria-modal="true" aria-label="Reminders">
        <div class="wrap">
          <div class="panel" role="document">
            <div class="grip"></div>
            <div class="header">
              <div class="title-block">
                <h2 class="title">Reminders</h2>
                <p class="subtitle">From your last notification.</p>
              </div>
              <button
                class="close-btn"
                type="button"
                aria-label="Close"
                @click=${this._finish}
              >✕</button>
            </div>

            ${groups.map(g => this._renderGroup(g))}
          </div>
        </div>
      </dialog>
    `;
  }

  _renderGroup(g) {
    const due = Array.isArray(g.due_now) ? g.due_now : [];
    const miss = Array.isArray(g.missed_earlier) ? g.missed_earlier : [];
    return html`
      <div class="group">
        <div class="group-header">
          <div class="group-label">
            ${g.cardEmoji ? html`<span class="group-emoji" aria-hidden="true">${g.cardEmoji}</span>` : ''}
            <span>${g.cardLabel || 'Card'}</span>
          </div>
          ${g.cardId ? html`
            <button
              class="open-btn"
              type="button"
              aria-label="Open ${g.cardLabel || 'card'}"
              @click=${() => this._openCard(g.cardId)}
            >Open card</button>
          ` : ''}
        </div>

        ${due.length > 0 ? html`
          <div class="group-section" role="list" aria-label="Due now">
            <h3 class="section-title">Due now</h3>
            ${due.map(it => this._renderRow(it))}
          </div>
        ` : ''}

        ${miss.length > 0 ? html`
          <div class="group-section missed" role="list" aria-label="Missed earlier">
            <h3 class="section-title">Missed earlier</h3>
            ${miss.map(it => this._renderRow(it))}
          </div>
        ` : ''}
      </div>
    `;
  }

  _renderRow(it) {
    const display = it.short_name || it.name || '';
    const meta = [it.dose, it.timing].filter(Boolean).join(' · ');
    return html`
      <div class="row" role="listitem">
        <div class="row-name">${display}</div>
        ${meta ? html`<div class="row-meta">${meta}</div>` : ''}
      </div>
    `;
  }
}

customElements.define('eh-reminder-modal', EhReminderModal);
