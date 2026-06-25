// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-card-settings-modal.js — per-card settings gear modal.
//
// Opened from a card's header gear. Renders the safe, common-sense
// manifest toggles for the card (merged COMMON_SETTINGS + the renderer's
// static settingsSchema) as switches pre-filled from the manifest. Saving
// PATCHes meta via /api/manifests/:id. Structured/free-text options stay
// with Klebbius; a footer points there.
//
// Public API:
//   <eh-card-settings-modal
//     .card=${{ id, meta }}
//     .schema=${[descriptor, ...]}
//     .displayName=${'Weight tracker'}
//     @eh-card-settings-done=${(e) => ...}
//   ></eh-card-settings-modal>
//
// Events:
//   eh-card-settings-done: { cardId, changed: boolean }
//     Fired on close. changed=true when a PATCH was persisted (app.js then
//     refreshes the view via klebb-cards-changed).

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { errorFromResponse } from '../lib/save-error.js';
import {
  resolveSettingValue, isSettingAvailable, buildMetaPatch,
} from '../lib/card-settings.js';
import {
  notificationsState, notificationsEnabled, buildNotificationsPatch,
} from '../lib/card-notifications.js';

export class EhCardSettingsModal extends LitElement {
  static properties = {
    card: { type: Object },
    schema: { type: Array },
    displayName: { type: String },
    _edited: { state: true },
    _notifEdit: { state: true },
    _data: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _changed: { state: true },
  };

  constructor() {
    super();
    this.card = null;
    this.schema = [];
    this.displayName = '';
    this._edited = {};
    // Notifications is not a path descriptor (enabling can *create* an
    // item), so its toggle tracks a separate tri-state: null = untouched,
    // true/false = user's pending choice.
    this._notifEdit = null;
    this._data = null;
    this._busy = false;
    this._error = null;
    this._changed = false;
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
      display: flex; flex-direction: column; gap: 16px;
    }
    .panel * { box-sizing: border-box; }
    @media (min-width: 640px) {
      .panel { border-radius: 16px; box-shadow: 0 8px 60px rgba(0, 0, 0, 0.45); }
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
      font-size: 18px; font-weight: 700; color: var(--text-primary);
      margin: 0; line-height: 1.2;
    }
    .close-btn {
      background: none; border: none; color: var(--text-secondary);
      font-size: 22px; line-height: 1; padding: 4px 8px; cursor: pointer;
      border-radius: 6px; flex-shrink: 0;
    }
    .close-btn:hover { background: var(--bg-hover, rgba(255,255,255,0.05)); color: var(--text-primary); }
    .close-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .error {
      background: rgba(220, 53, 69, 0.1); color: #ff6b6b;
      border: 1px solid rgba(220, 53, 69, 0.3); border-radius: 8px;
      padding: 8px 12px; font-size: 13px;
    }
    .section-title {
      font-size: 11px; font-weight: 700; letter-spacing: 0.5px;
      text-transform: uppercase; color: var(--text-muted, var(--text-secondary));
      margin: 4px 0 -4px;
    }
    .rows { display: flex; flex-direction: column; gap: 2px; }
    .row {
      display: grid; grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px; align-items: center; padding: 10px 0;
      border-top: 1px solid var(--border);
    }
    .row:first-child { border-top: none; }
    .row.unavailable .row-label { color: var(--text-muted, var(--text-secondary)); }
    .row-info { min-width: 0; }
    .row-label { font-size: 14px; color: var(--text-primary); }
    .row-help, .row-hint {
      font-size: 12px; color: var(--text-secondary); margin-top: 2px;
    }
    .row-hint { font-style: italic; }
    .toggle {
      appearance: none; width: 44px; height: 24px; border-radius: 12px;
      background: var(--border); position: relative; cursor: pointer;
      border: none; transition: background 0.15s; flex-shrink: 0;
    }
    .toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 20px; height: 20px; border-radius: 50%;
      background: var(--bg-card); transition: transform 0.15s;
    }
    .toggle[aria-checked="true"] { background: var(--accent); }
    .toggle[aria-checked="true"]::after { transform: translateX(20px); }
    .toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .toggle[disabled] { opacity: 0.4; cursor: not-allowed; }
    .footer {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; padding-top: 8px;
    }
    .note { font-size: 12px; color: var(--text-muted, var(--text-secondary)); flex: 1; }
    .save-btn {
      background: var(--accent); color: white; border: none;
      padding: 8px 18px; border-radius: 8px; font-size: 14px;
      font-weight: 600; cursor: pointer; flex-shrink: 0;
    }
    .save-btn:hover { filter: brightness(1.08); }
    .save-btn:disabled { opacity: 0.6; cursor: default; }
    .empty { font-size: 13px; color: var(--text-secondary); padding: 8px 0; }
    @media (prefers-reduced-motion: reduce) {
      .toggle, .toggle::after { transition: none; }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Fetch the data block only when a descriptor's availability depends
    // on it. Visibility/input descriptors gate on meta alone, so most
    // cards never trigger this round-trip.
    if (this._needsData()) this._fetchData();
  }

  _needsData() {
    return (this.schema || []).some(d => d.needsData === true);
  }

  async _fetchData() {
    try {
      const r = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        credentials: 'same-origin',
      });
      if (!r.ok) return;
      const j = await r.json();
      this._data = j.data ?? null;
    } catch { /* availability falls back to meta-only; non-fatal */ }
  }

  firstUpdated() {
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && typeof dlg.showModal === 'function') {
      try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
    }
    if (dlg) {
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); this._close(); });
    }
  }

  _ctx() {
    return { meta: this.card?.meta || {}, data: this._data };
  }

  // Current displayed value for a descriptor: an in-session edit wins,
  // else the resolved manifest value.
  _valueOf(d) {
    if (d.path in this._edited) return this._edited[d.path];
    return resolveSettingValue(this.card?.meta || {}, d);
  }

  _toggle(d) {
    if (this._busy) return;
    if (!isSettingAvailable(d, this._ctx())) return;
    this._edited = { ...this._edited, [d.path]: !this._valueOf(d) };
  }

  // Notifications: the displayed value is the pending edit, else the
  // manifest's current state.
  _notifOn() {
    if (this._notifEdit !== null) return this._notifEdit;
    return notificationsEnabled(this.card?.meta || {});
  }

  _toggleNotifications() {
    if (this._busy) return;
    this._notifEdit = !this._notifOn();
  }

  // Deep-merge two meta-patches (each shaped { meta: {...} }) into one PATCH
  // body. Both are produced by us and only ever set scalar booleans or the
  // notifications block, so a shallow merge of meta sub-objects suffices —
  // the only overlap would be meta.notifications, which only one source
  // writes.
  _combinedPatch() {
    const settings = buildMetaPatch(this.schema, this.card?.meta || {}, this._edited);
    const notif = this._notifEdit === null
      ? null
      : buildNotificationsPatch(this.card?.meta || {}, this._notifEdit);
    if (!settings && !notif) return null;
    return { meta: { ...(settings?.meta || {}), ...(notif?.meta || {}) } };
  }

  async _save() {
    const patch = this._combinedPatch();
    if (!patch) { this._close(); return; }
    this._busy = true;
    this._error = null;
    try {
      const r = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw await errorFromResponse(r);
      this._changed = true;
      this._close();
    } catch (err) {
      this._error = err.message || 'Could not save. Try again.';
    } finally {
      this._busy = false;
    }
  }

  _askKlebbius() {
    const meta = this.card?.meta || {};
    const name = meta.label || this.card?.id || 'this card';
    const text = `What else can I configure on my "${name}" card `
      + `(id: ${this.card?.id}, type: ${meta.view?.component || 'card'})? `
      + `Show me options that aren't in the settings panel.`;
    window.dispatchEvent(new CustomEvent('klebb-paste-into-chat', { detail: { text } }));
    this._close();
  }

  _close() {
    const dlg = this.renderRoot.querySelector('dialog');
    if (dlg && dlg.open) { try { dlg.close(); } catch { /* noop */ } }
    this.dispatchEvent(new CustomEvent('eh-card-settings-done', {
      detail: { cardId: this.card?.id, changed: this._changed },
      bubbles: true, composed: true,
    }));
  }

  render() {
    if (!this.card) return html``;
    const ctx = this._ctx();
    const groups = this._grouped();
    return html`
      <dialog aria-modal="true" aria-label="${this.displayName || 'Card'} settings">
        <div class="wrap">
          <div class="panel" role="document">
            <div class="grip"></div>
            <div class="header">
              <div class="title-block">
                <p class="kicker">${this.displayName || 'Card'} settings</p>
                <h2 class="title">${this.card.meta?.label || this.card.id}</h2>
              </div>
              <button class="close-btn" type="button" aria-label="Close" @click=${this._close}>✕</button>
            </div>

            ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : ''}

            ${groups.length === 0
              ? html`<div class="empty">No quick settings for this card yet. Ask Klebbius what you can change.</div>`
              : groups.map(g => html`
                  <div class="section-title">${g.section}</div>
                  <div class="rows">
                    ${g.items.map(d => this._renderRow(d, ctx))}
                  </div>
                `)}

            ${this._renderNotifications()}

            <div class="footer">
              <span class="note">More options? Ask Klebbius about this card.</span>
              <button class="save-btn" type="button" ?disabled=${this._busy} @click=${this._save}>
                ${this._busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            <div class="footer" style="padding-top:0">
              <button class="close-btn" type="button"
                style="font-size:13px;padding:4px 0;color:var(--accent)"
                @click=${this._askKlebbius}>Ask Klebbius →</button>
            </div>
          </div>
        </div>
      </dialog>
    `;
  }

  _renderRow(d, ctx) {
    const available = isSettingAvailable(d, ctx);
    const value = available && this._valueOf(d) === true;
    return html`
      <div class="row ${available ? '' : 'unavailable'}">
        <div class="row-info">
          <div class="row-label">${d.label}</div>
          ${available
            ? (d.help ? html`<div class="row-help">${d.help}</div>` : '')
            : (d.unavailableHint ? html`<div class="row-hint">${d.unavailableHint}</div>` : '')}
        </div>
        <button
          class="toggle"
          role="switch"
          aria-checked=${value ? 'true' : 'false'}
          aria-label=${d.label}
          ?disabled=${!available || this._busy}
          @click=${() => this._toggle(d)}
        ></button>
      </div>
    `;
  }

  _renderNotifications() {
    const meta = this.card?.meta || {};
    const state = notificationsState(meta);
    const on = this._notifOn();
    return html`
      <div class="section-title">Notifications</div>
      <div class="rows">
        ${state === 'none' ? html`
          <div class="row unavailable">
            <div class="row-info">
              <div class="row-label">Reminders</div>
              <div class="row-hint">Ask Klebbius to set up reminders for this card.</div>
            </div>
          </div>
        ` : html`
          <div class="row">
            <div class="row-info">
              <div class="row-label">Reminders</div>
              <div class="row-help">
                ${state === 'can-create'
                  ? 'A daily reminder at 9am. Ask Klebbius for custom times, wording, or multiple reminders.'
                  : 'Turn all reminders for this card on or off. Fine-tune individual ones in Settings › Notifications.'}
              </div>
            </div>
            <button
              class="toggle"
              role="switch"
              aria-checked=${on ? 'true' : 'false'}
              aria-label="Reminders"
              ?disabled=${this._busy}
              @click=${this._toggleNotifications}
            ></button>
          </div>
        `}
      </div>
    `;
  }

  // Group descriptors by their section, preserving first-seen order.
  _grouped() {
    const order = [];
    const bySection = new Map();
    for (const d of this.schema || []) {
      const s = d.section || 'Settings';
      if (!bySection.has(s)) { bySection.set(s, []); order.push(s); }
      bySection.get(s).push(d);
    }
    return order.map(section => ({ section, items: bySection.get(section) }));
  }
}
customElements.define('eh-card-settings-modal', EhCardSettingsModal);
