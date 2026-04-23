// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-input-form.js
// Generic, manifest-driven input form.
//
// Reads a card's meta.writeable.inputs array and renders the right widget per
// input type. Emits an 'eh-submit' event with the collected values; parent card
// decides what to do with them (usually POST to /api/manifests/:id/data with an
// upserted entry).
//
// Input types supported:
//   number, text, textarea, select, emoji-picker, colour, checkbox, date, time, rating
//
// Each input entry (in meta.writeable.inputs) has:
//   { key, type, label?, placeholder?, required?, min?, max?, step?, options?, emojis? }
//
// Card renderers pass the current date (for defaulting) and any prefilled values
// (for edit mode):
//   <eh-input-form
//     .inputs=${meta.writeable.inputs}
//     .values=${prefilled}
//     .date=${'2026-04-20'}
//     submit-label="Save"
//     @eh-submit=${(e) => this._saveEntry(e.detail)}
//     @eh-cancel=${() => this._closeForm()}
//   ></eh-input-form>

import { LitElement, html, css } from 'https://esm.sh/lit@3';

const DEFAULT_EMOJIS = ['😩', '😞', '😐', '🙂', '😄'];

export class EhInputForm extends LitElement {
  static properties = {
    inputs: { type: Array },
    values: { type: Object },
    date: { type: String },
    submitLabel: { type: String, attribute: 'submit-label' },
    cancelLabel: { type: String, attribute: 'cancel-label' },
    busy: { type: Boolean },
    _state: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this.inputs = [];
    this.values = {};
    this.date = null;
    this.submitLabel = 'Save';
    this.cancelLabel = 'Cancel';
    this.busy = false;
    this._state = {};
    this._error = null;
  }

  willUpdate(changed) {
    if (changed.has('values') || changed.has('inputs')) {
      // Build internal state from prefilled values + input defaults.
      const s = { ...(this.values || {}) };
      for (const input of this.inputs || []) {
        if (!(input.key in s)) {
          // Sensible per-type defaults
          if (input.type === 'checkbox') s[input.key] = !!input.default;
          else if (input.type === 'number' || input.type === 'rating' || input.type === 'stepper') s[input.key] = input.default ?? null;
          else if ('default' in input) s[input.key] = input.default;
          else s[input.key] = '';
        }
      }
      this._state = s;
    }
  }

  _update(key, value) {
    this._state = { ...this._state, [key]: value };
  }

  _isValid() {
    for (const input of this.inputs || []) {
      if (input.required) {
        const v = this._state[input.key];
        if (v === null || v === undefined || v === '') return false;
      }
    }
    return true;
  }

  _onSubmit(e) {
    e.preventDefault();
    e.stopPropagation();
    this._error = null;
    if (!this._isValid()) {
      this._error = 'Please fill the required fields.';
      return;
    }
    // Cast numbers
    const out = { ...this._state };
    for (const input of this.inputs || []) {
      if (input.type === 'number' || input.type === 'rating' || input.type === 'stepper') {
        if (out[input.key] !== null && out[input.key] !== '') {
          const n = Number(out[input.key]);
          if (!Number.isNaN(n)) out[input.key] = n;
        }
      }
    }
    if (this.date && !out.date) out.date = this.date;
    this.dispatchEvent(new CustomEvent('eh-submit', {
      detail: out,
      bubbles: true,
      composed: true,
    }));
  }

  _onCancel() {
    this.dispatchEvent(new CustomEvent('eh-cancel', { bubbles: true, composed: true }));
  }

  _renderInput(input) {
    const v = this._state[input.key];
    const id = `in-${input.key}`;
    switch (input.type) {
      case 'number':
        return html`
          <input
            id=${id}
            type="number"
            .value=${v ?? ''}
            placeholder=${input.placeholder || ''}
            min=${input.min ?? ''}
            max=${input.max ?? ''}
            step=${input.step ?? 'any'}
            ?required=${input.required}
            @input=${(e) => this._update(input.key, e.target.value)}
          />`;
      case 'stepper': {
        const min = input.min ?? 0;
        const max = input.max ?? 999;
        const step = input.step ?? 1;
        const current = (v === null || v === undefined || v === '') ? (input.default ?? 0) : Number(v);
        const isValid = !Number.isNaN(current);
        const safe = isValid ? current : 0;
        const dec = () => this._update(input.key, Math.max(min, safe - step));
        const inc = () => this._update(input.key, Math.min(max, safe + step));
        return html`
          <div class="stepper-row">
            <button
              type="button"
              class="stepper-btn"
              @click=${dec}
              ?disabled=${safe <= min}
              aria-label="Decrease ${input.label || input.key}"
            >−</button>
            <input
              id=${id}
              type="number"
              class="stepper-value"
              .value=${safe}
              min=${min}
              max=${max}
              step=${step}
              ?required=${input.required}
              @input=${(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) this._update(input.key, Math.max(min, Math.min(max, n)));
              }}
            />
            <button
              type="button"
              class="stepper-btn"
              @click=${inc}
              ?disabled=${safe >= max}
              aria-label="Increase ${input.label || input.key}"
            >+</button>
          </div>`;
      }
      case 'text':
        return html`
          <input
            id=${id}
            type="text"
            .value=${v ?? ''}
            placeholder=${input.placeholder || ''}
            maxlength=${input.maxLength ?? ''}
            ?required=${input.required}
            @input=${(e) => this._update(input.key, e.target.value)}
          />`;
      case 'textarea':
        return html`
          <textarea
            id=${id}
            .value=${v ?? ''}
            placeholder=${input.placeholder || ''}
            rows=${input.rows || 3}
            maxlength=${input.maxLength ?? ''}
            ?required=${input.required}
            @input=${(e) => this._update(input.key, e.target.value)}
          ></textarea>`;
      case 'select':
        return html`
          <select
            id=${id}
            .value=${v ?? ''}
            ?required=${input.required}
            @change=${(e) => this._update(input.key, e.target.value)}
          >
            ${input.placeholder ? html`<option value="">${input.placeholder}</option>` : ''}
            ${(input.options || []).map(o => {
              const val = typeof o === 'string' ? o : o.value;
              const label = typeof o === 'string' ? o : (o.label || o.value);
              return html`<option value=${val} ?selected=${String(v) === String(val)}>${label}</option>`;
            })}
          </select>`;
      case 'emoji-picker': {
        const emojis = input.emojis || DEFAULT_EMOJIS;
        const onPick = (i, e) => {
          this._update(input.key, input.emitIndex ? i + 1 : e);
          if (input.autoSubmit) {
            // Fire a synthetic submit on next tick so the value is picked up
            // by _onSubmit's state read.
            setTimeout(() => {
              // Minimal object mimicking a submit event
              this._onSubmit({ preventDefault() {}, stopPropagation() {} });
            }, 0);
          }
        };
        return html`
          <div class="emoji-row">
            ${emojis.map((e, i) => html`
              <button
                type="button"
                class="emoji ${String(v) === String(i + 1) || v === e ? 'selected' : ''}"
                @click=${() => onPick(i, e)}
                aria-label="${input.labels?.[i] || e}"
              >${e}</button>
            `)}
          </div>`;
      }
      case 'colour':
      case 'color':
        return html`
          <input
            id=${id}
            type="color"
            .value=${v || '#888888'}
            @input=${(e) => this._update(input.key, e.target.value)}
          />`;
      case 'checkbox':
        return html`
          <input
            id=${id}
            type="checkbox"
            ?checked=${!!v}
            @change=${(e) => this._update(input.key, e.target.checked)}
          />`;
      case 'date':
        return html`
          <input
            id=${id}
            type="date"
            .value=${v || this.date || ''}
            ?required=${input.required}
            @input=${(e) => this._update(input.key, e.target.value)}
          />`;
      case 'time':
        return html`
          <input
            id=${id}
            type="time"
            .value=${v ?? ''}
            ?required=${input.required}
            @input=${(e) => this._update(input.key, e.target.value)}
          />`;
      case 'rating': {
        const min = input.min ?? 1;
        const max = input.max ?? 5;
        const range = [];
        for (let i = min; i <= max; i++) range.push(i);
        return html`
          <div class="rating-row">
            ${range.map(i => html`
              <button
                type="button"
                class="rating ${Number(v) === i ? 'selected' : ''}"
                @click=${() => this._update(input.key, i)}
              >${i}</button>
            `)}
          </div>`;
      }
      default:
        return html`<em>Unknown input type: ${input.type}</em>`;
    }
  }

  static styles = css`
    :host { display: block; }
    form { display: flex; flex-direction: column; gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
    }
    .field.checkbox {
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }
    .field.checkbox label { order: 2; font-weight: 500; }
    input[type="text"],
    input[type="number"],
    input[type="date"],
    input[type="time"],
    select,
    textarea {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input, var(--bg-card));
      color: var(--text-primary);
      font-family: inherit;
      /* 16px minimum prevents iOS Safari auto-zoom on focus. Don't drop
         this without re-testing on a real iPhone. */
      font-size: 16px;
    }
    input[type="color"] {
      width: 44px;
      height: 32px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input, var(--bg-card));
      padding: 2px;
      cursor: pointer;
    }
    textarea { resize: vertical; min-height: 60px; }
    .emoji-row, .rating-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .emoji, .rating {
      border: 1px solid var(--border);
      background: var(--bg-card);
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 18px;
      cursor: pointer;
      color: var(--text-primary);
      transition: all 0.12s;
      min-width: 40px;
    }
    .rating { font-size: 14px; font-weight: 600; }
    .emoji.selected, .rating.selected {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--text-inverse, white);
    }

    /* --- Stepper (number with −/+ buttons on either side) --- */
    .stepper-row {
      display: flex;
      align-items: stretch;
      gap: 0;
      max-width: 160px;
    }
    .stepper-btn {
      width: 38px;
      height: 38px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      font-size: 20px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      font-family: inherit;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.12s;
      flex-shrink: 0;
    }
    .stepper-btn:first-child {
      border-radius: 6px 0 0 6px;
      border-right: none;
    }
    .stepper-btn:last-child {
      border-radius: 0 6px 6px 0;
      border-left: none;
    }
    .stepper-btn:hover:not([disabled]) {
      border-color: var(--accent);
      color: var(--accent);
    }
    .stepper-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      z-index: 2;
      position: relative;
    }
    .stepper-btn[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .stepper-value {
      width: 60px !important;
      text-align: center;
      border-radius: 0 !important;
      border-left-width: 1px !important;
      border-right-width: 1px !important;
      -moz-appearance: textfield;
      padding: 0 !important;
    }
    .stepper-value::-webkit-outer-spin-button,
    .stepper-value::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .stepper-value:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
      border-color: var(--accent);
      z-index: 2;
      position: relative;
    }

    @media (prefers-reduced-motion: reduce) {
      .stepper-btn { transition: none; }
    }
      color: var(--text-inverse, white);
    }
    .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 6px;
    }
    .btn {
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      font-family: inherit;
    }
    .btn.primary {
      background: var(--accent);
      color: var(--text-inverse, white);
    }
    .btn.ghost {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border);
    }
    .btn[disabled] { opacity: 0.55; cursor: not-allowed; }
    .btn:focus-visible,
    .emoji:focus-visible,
    .rating:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .error { color: #ff4466; font-size: 12px; }
    .help { font-size: 11px; color: var(--text-muted, var(--text-secondary)); }

    @media (prefers-reduced-motion: reduce) {
      .btn, .emoji, .rating { transition: none; }
    }
  `;

  render() {
    if (!Array.isArray(this.inputs) || this.inputs.length === 0) {
      return html`<em>No inputs defined for this card.</em>`;
    }
    return html`
      <form @submit=${this._onSubmit}>
        ${this.inputs.map(input => html`
          <div class="field ${input.type === 'checkbox' ? 'checkbox' : ''}">
            ${input.label ? html`<label for="in-${input.key}">${input.label}${input.required ? ' *' : ''}</label>` : ''}
            ${this._renderInput(input)}
            ${input.help ? html`<div class="help">${input.help}</div>` : ''}
          </div>
        `)}
        ${this._error ? html`<div class="error">${this._error}</div>` : ''}
        <div class="actions">
          <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${this._onCancel}>${this.cancelLabel}</button>
          <button type="submit" class="btn primary" ?disabled=${this.busy || !this._isValid()}>${this.busy ? 'Saving…' : this.submitLabel}</button>
        </div>
      </form>
    `;
  }
}
customElements.define('eh-input-form', EhInputForm);
