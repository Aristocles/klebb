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

    .section { display: flex; flex-direction: column; gap: 8px; }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted, var(--text-secondary));
      margin: 0;
    }
    .section.missed .section-title { color: var(--text-secondary); }

    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--bg-hover, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border);
    }
    .section.missed .row { opacity: 0.85; }
    .row-info { min-width: 0; }
    .row-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      overflow-wrap: anywhere;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--accent-bg, rgba(124, 92, 255, 0.12));
      color: var(--accent);
      font-size: 11px;
      font-weight: 500;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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

    .footer {
      display: flex;
      justify-content: flex-end;
      padding-top: 4px;
    }
    button.dismiss-btn {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      cursor: pointer;
    }
    button.dismiss-btn:hover { color: var(--text-primary); border-color: var(--text-secondary); }
  `;

  firstUpdated() {
    const sections = this._sections();
    if (sections.dueNow.length === 0 && sections.missed.length === 0) {
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

  // Flatten the per-group structured payload into two cross-card lists,
  // each row tagged with its source card so the modal can chip them.
  _sections() {
    const groups = Array.isArray(this.reminders) ? this.reminders : [];
    const dueNow = [];
    const missed = [];
    for (const g of groups) {
      const tag = { cardId: g.cardId, cardLabel: g.cardLabel, cardEmoji: g.cardEmoji };
      for (const it of (g.due_now || [])) {
        if (it) dueNow.push({ ...it, ...tag });
      }
      for (const it of (g.missed_earlier || [])) {
        if (it) missed.push({ ...it, ...tag });
      }
    }
    return { dueNow, missed };
  }

  render() {
    const { dueNow, missed } = this._sections();
    if (dueNow.length === 0 && missed.length === 0) return html``;
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

            ${dueNow.length > 0 ? html`
              <div class="section" role="list" aria-label="Due now">
                <h3 class="section-title">Due now</h3>
                ${dueNow.map(row => this._renderRow(row))}
              </div>
            ` : ''}

            ${missed.length > 0 ? html`
              <div class="section missed" role="list" aria-label="Missed earlier">
                <h3 class="section-title">Missed earlier</h3>
                ${missed.map(row => this._renderRow(row))}
              </div>
            ` : ''}

            <div class="footer">
              <button class="dismiss-btn" type="button" @click=${this._finish}>Close</button>
            </div>
          </div>
        </div>
      </dialog>
    `;
  }

  _renderRow(row) {
    const display = row.short_name || row.name || '';
    const chipText = [row.cardEmoji, row.cardLabel].filter(Boolean).join(' ');
    return html`
      <div class="row" role="listitem">
        <div class="row-info">
          <div class="row-name">${display}</div>
          ${chipText ? html`<span class="chip">${chipText}</span>` : ''}
        </div>
        ${row.cardId ? html`
          <button
            class="open-btn"
            type="button"
            aria-label="Open ${row.cardLabel || 'card'}"
            @click=${() => this._openCard(row.cardId)}
          >Open card</button>
        ` : ''}
      </div>
    `;
  }
}

customElements.define('eh-reminder-modal', EhReminderModal);
