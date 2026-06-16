// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-prompt-modal.js — Full-screen "log this now" modal.
//
// A card with meta.prompt.enabled = true triggers this modal on app load
// (once per day per card). The modal renders one of two shapes based on
// meta.prompt.mode:
//   - "modal" (default): wraps the card's meta.writeable.inputs in
//     eh-input-form for a single Save submission.
//   - "checklist": for schedule-card data where each item has its own
//     scheduled-today status. Renders one row per item scheduled today
//     with a single "Taken" button that stamps that item's doses[]
//     with { scheduledDate, takenAt } and updates in place. Auto-closes
//     when every scheduled item is marked.
// Closing via ✕ or Save (or marking the last checklist row) marks the
// card "prompted today" in localStorage; the modal won't appear again
// until the next day.
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
import { isScheduledOnDate } from '../../../lib/schedule.mjs';
import './eh-input-form.js';

export class EhPromptModal extends LitElement {
  static properties = {
    card: { type: Object },
    date: { type: String },
    _error: { state: true },
    _busy: { state: true },
    _checklistData: { state: true },
    _pendingItem: { state: true },
  };

  constructor() {
    super();
    this.card = null;
    this.date = null;
    this._error = null;
    this._busy = false;
    this._checklistData = null;
    this._pendingItem = null;
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

    .checklist {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
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
    .row.taken { opacity: 0.55; }
    .row-info { min-width: 0; }
    .row-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .row-meta {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    button.taken-btn {
      background: var(--accent);
      color: white;
      border: none;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }
    button.taken-btn:hover { filter: brightness(1.08); }
    button.taken-btn:disabled { cursor: default; opacity: 0.7; }
    button.taken-btn.done {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
    }
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
    .empty-checklist {
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      text-align: center;
      padding: 12px 0;
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

  // Checklist mode: derive today's working item list from the card's data
  // (or from the most recent in-modal write). Items with a schedule/cycle
  // are filtered through isScheduledOnDate; plain items (supplement-stack
  // style without a schedule block) are always due.
  _checklistItems() {
    const data = this._checklistData || this.card?.data || {};
    const items = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.current) ? data.current
      : [];
    const date = this.date || localToday();
    return items.filter(item => {
      if (item.schedule || item.cycle || Array.isArray(item.cycles)) {
        return isScheduledOnDate(item, date) === 'scheduled';
      }
      return true;
    });
  }

  _itemUsesDoses(item) {
    return Array.isArray(item.doses) || !!item.schedule || !!item.cycle || Array.isArray(item.cycles);
  }

  _isItemTaken(item) {
    const date = this.date || localToday();
    if (Array.isArray(item.doses)
      && item.doses.some(d => d.scheduledDate === date && d.takenAt)) return true;
    if (Array.isArray(item.takenDates) && item.takenDates.includes(date)) return true;
    return false;
  }

  _doseLabel(item) {
    const parts = [];
    if (item.dose_label) parts.push(item.dose_label);
    else if (item.dose_mg != null) parts.push(`${item.dose_mg}mg`);
    else if (item.dose) parts.push(item.dose);
    if (item.dose_units) parts.push(`${item.dose_units}u`);
    if (item.route) parts.push(item.route);
    return parts.join(' · ');
  }

  async _markItemTaken(item) {
    if (this._busy || this._pendingItem) return;
    if (this._isItemTaken(item)) return;
    const meta = this.card?.meta || {};
    const date = this.date || localToday();
    this._pendingItem = item.id || item.name;
    this._error = null;
    try {
      const current = await fetch(`/api/manifests/${encodeURIComponent(meta.id)}/data`, {
        credentials: 'same-origin',
      }).then(r => r.json());
      const data = current?.data ?? current ?? {};
      const items = Array.isArray(data.items) ? data.items : [];
      const matchKey = item.id ? 'id' : 'name';
      const matchVal = item[matchKey];
      const useTakenDates = !this._itemUsesDoses(item);
      const updatedItems = items.map(it => {
        if (it[matchKey] !== matchVal) return it;
        if (useTakenDates) {
          const taken = Array.isArray(it.takenDates) ? [...it.takenDates] : [];
          if (!taken.includes(date)) taken.push(date);
          return { ...it, takenDates: taken };
        }
        const doses = Array.isArray(it.doses) ? [...it.doses] : [];
        const idx = doses.findIndex(d => d.scheduledDate === date);
        const stamped = { scheduledDate: date, takenAt: new Date().toISOString() };
        if (idx >= 0) doses[idx] = { ...doses[idx], ...stamped };
        else doses.push(stamped);
        return { ...it, doses };
      });
      const updated = { ...data, items: updatedItems };
      const r = await fetch(`/api/manifests/${encodeURIComponent(meta.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ data: updated }),
      });
      if (!r.ok) throw await errorFromResponse(r);
      this._checklistData = updated;
      // Auto-close once every scheduled item is taken.
      const remaining = this._checklistItems().some(it => !this._isItemTaken(it));
      if (!remaining) this._finish('saved', { mode: 'checklist' });
    } catch (err) {
      console.warn('[prompt-modal] checklist save failed', err);
      this._error = err.message || 'Could not save. Try again or dismiss.';
    } finally {
      this._pendingItem = null;
    }
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
    const today = this.date || localToday();
    const mode = meta.prompt?.mode === 'checklist' ? 'checklist' : 'modal';
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

            ${mode === 'checklist'
              ? this._renderChecklist(today)
              : this._renderModalForm(meta, today)}
          </div>
        </div>
      </dialog>
    `;
  }

  _renderModalForm(meta, today) {
    const inputs = meta.writeable?.inputs || [];
    const display = meta.view?.display || null;
    return html`
      <eh-input-form
        .inputs=${inputs}
        .values=${{}}
        .date=${today}
        .display=${display}
        .requireAny=${meta.writeable?.requireAny || null}
        .busy=${this._busy}
        submit-label="Save"
        cancel-label="Not now"
        @eh-submit=${this._onSubmit}
        @eh-cancel=${this._dismiss}
      ></eh-input-form>
    `;
  }

  _renderChecklist(today) {
    const items = this._checklistItems();
    if (items.length === 0) {
      return html`
        <div class="empty-checklist">Nothing scheduled for today.</div>
        <div class="footer">
          <button class="dismiss-btn" type="button" @click=${this._dismiss}>Close</button>
        </div>
      `;
    }
    return html`
      <div class="checklist" role="list">
        ${items.map(item => {
          const taken = this._isItemTaken(item);
          const pendingKey = item.id || item.name;
          const pending = this._pendingItem === pendingKey;
          const meta = this._doseLabel(item);
          return html`
            <div class="row ${taken ? 'taken' : ''}" role="listitem">
              <div class="row-info">
                <div class="row-name">${item.short_name || item.name}</div>
                ${meta ? html`<div class="row-meta">${meta}</div>` : ''}
              </div>
              <button
                class="taken-btn ${taken ? 'done' : ''}"
                type="button"
                ?disabled=${taken || pending}
                aria-label="mark ${item.name} taken"
                @click=${() => this._markItemTaken(item)}
              >${taken ? '✓ Taken' : pending ? '...' : 'Taken'}</button>
            </div>
          `;
        })}
      </div>
      <div class="footer">
        <button class="dismiss-btn" type="button" @click=${this._dismiss}>Not now</button>
      </div>
    `;
  }
}
customElements.define('eh-prompt-modal', EhPromptModal);
