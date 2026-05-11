// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-prompt-modal.js — Full-screen "log this now" modal.
//
// A card with meta.prompt.enabled = true triggers this modal on app load
// (once per day per card). The modal wraps the card's normal input form
// (meta.writeable.inputs) inside a native <dialog>, forcing the user to
// acknowledge. Closing via ✕ or Save marks the card "prompted today"
// in localStorage; the modal won't appear again until the next day.
//
// See docs/CARDS.md → Modal prompts for user-facing documentation.
//
// Public API:
//   <eh-prompt-modal
//     .card=${card}
//     .date=${'2026-04-23'}
//     @eh-prompt-done=${(e) => this._onPromptDone(e.detail)}
//   ></eh-prompt-modal>
//
// card argument: the full manifest object (meta + data). The modal reads
//   meta.label, meta.icon, meta.description, meta.writeable.inputs and
//   uses the card id for the localStorage key.
//
// Events:
//   eh-prompt-done: { cardId, action: 'saved' | 'dismissed', data? }
//     Fired when the user saves OR dismisses via ✕ / Escape / backdrop.
//     The orchestrator (app.js) listens and advances to the next prompt
//     in the queue.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { localToday } from '../lib/date-util.js';
import { errorFromResponse } from '../lib/save-error.js';
import './eh-input-form.js';

export class EhPromptModal extends LitElement {
  static properties = {
    card: { type: Object },
    date: { type: String },
    _error: { state: true },
    _busy: { state: true },
  };

  constructor() {
    super();
    this.card = null;
    this.date = null;
    this._error = null;
    this._busy = false;
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
      /* Small-screen: full-height sheet. Desktop: centered card. */
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
      /* Some platform-native controls (date/time pickers, number
         spinners) render oversized at default padding and push the
         panel wider than 100%, producing a rogue horizontal scrollbar.
         Clip horizontally — inner form fields take the available
         width via box-sizing:border-box and width:100% below. */
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
    .panel input,
    .panel textarea,
    .panel select {
      max-width: 100%;
    }
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
    .icon {
      font-size: 24px;
      line-height: 1;
      flex-shrink: 0;
    }
    .title-block {
      flex: 1;
      min-width: 0;
    }
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

    .error {
      background: rgba(220, 53, 69, 0.1);
      color: #ff6b6b;
      border: 1px solid rgba(220, 53, 69, 0.3);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
    }
  `;

  firstUpdated() {
    // Show the dialog as modal (blocks outside interaction, enables ::backdrop).
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && typeof dlg.showModal === 'function') {
      try { dlg.showModal(); }
      catch { dlg.setAttribute('open', ''); }
    }
    // Native <dialog> fires a 'cancel' event on Escape — treat as dismiss.
    if (dlg) {
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        this._dismiss();
      });
    }
  }

  _dismiss() {
    this._finish('dismissed');
  }

  _finish(action, data) {
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && dlg.open) {
      try { dlg.close(); } catch { /* noop */ }
    }
    this.dispatchEvent(new CustomEvent('eh-prompt-done', {
      detail: { cardId: this.card?.meta?.id, action, data: data || null },
      bubbles: true,
      composed: true,
    }));
  }

  async _onSubmit(e) {
    if (!this.card) return;
    const values = e.detail;
    const meta = this.card.meta || {};
    this._busy = true;
    this._error = null;
    try {
      // Build new entry and upsert into the card's data array following
      // the same pattern as eh-generic-card._save(). This keeps the modal
      // independent of the card's renderer but honours maxReadingsPerDay.
      const entry = { ...values };
      if (!entry.date) entry.date = this.date || localToday();

      // Fetch the current manifest (fresh — avoid stale writes if another
      // tab just wrote something).
      const current = await fetch(`/api/manifests/${encodeURIComponent(meta.id)}`, {
        credentials: 'same-origin',
      }).then(r => r.json());
      const currentData = Array.isArray(current?.data) ? current.data : [];
      const max = meta?.writeable?.maxReadingsPerDay ?? 1;
      const sameDay = currentData.filter(d => d.date === entry.date);
      const others = currentData.filter(d => d.date !== entry.date);
      let updated;
      if (max === 1) {
        updated = [...others, entry];
      } else {
        const combined = [...sameDay, entry];
        const capped = combined.slice(-max);
        updated = [...others, ...capped];
      }
      updated.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      const r = await fetch(`/api/manifests/${encodeURIComponent(meta.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ data: updated }),
      });
      if (!r.ok) throw await errorFromResponse(r);
      this._finish('saved', entry);
    } catch (err) {
      console.warn('[prompt-modal] save failed', err);
      this._error = err.message || 'Could not save. Try again or dismiss.';
    } finally {
      this._busy = false;
    }
  }

  render() {
    if (!this.card) return html``;
    const meta = this.card.meta || {};
    const inputs = meta.writeable?.inputs || [];
    const today = this.date || localToday();
    return html`
      <dialog aria-modal="true" aria-label="${meta.label || 'Log entry'}">
        <div class="wrap">
          <div class="panel" role="document">
            <div class="grip"></div>
            <div class="header">
              ${meta.icon ? html`<span class="icon" aria-hidden="true">${meta.icon}</span>` : ''}
              <div class="title-block">
                <h2 class="title">${meta.label || 'Log entry'}</h2>
                ${meta.description ? html`<p class="subtitle">${meta.description}</p>` : ''}
              </div>
              <button
                class="close-btn"
                type="button"
                aria-label="Dismiss"
                @click=${this._dismiss}
              >✕</button>
            </div>

            ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : ''}

            <eh-input-form
              .inputs=${inputs}
              .values=${{}}
              .date=${today}
              .busy=${this._busy}
              submit-label="Save"
              cancel-label="Not now"
              @eh-submit=${this._onSubmit}
              @eh-cancel=${this._dismiss}
            ></eh-input-form>
          </div>
        </div>
      </dialog>
    `;
  }
}
customElements.define('eh-prompt-modal', EhPromptModal);
