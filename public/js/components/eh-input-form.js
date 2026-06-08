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
//   number, stepper, text, textarea, select, emoji-picker, colour, checkbox,
//   date, time, rating, chips, chips-multi
//
// Each input entry (in meta.writeable.inputs) has:
//   { key, type, label?, placeholder?, required?, min?, max?, step?, options?, emojis? }
//
// chips / chips-multi share `select`'s `options` shape (string array, or
// [{value, label}] for display-vs-stored splits). chips stores the
// selected option's value as a string. chips-multi stores an array of
// selected values; empty array = unset, and required: true means at
// least one chip selected.
//
// Card renderers pass the current date (for defaulting) and any prefilled values
// (for edit mode):
//   <eh-input-form
//     .inputs=${meta.writeable.inputs}
//     .values=${prefilled}
//     .date=${'2026-04-20'}
//     submit-label="Save"
//     divider-after-key="reactions"   // optional, see below
//     @eh-submit=${(e) => this._saveEntry(e.detail)}
//     @eh-cancel=${() => this._closeForm()}
//   ></eh-input-form>
//
// divider-after-key (optional): render a thin horizontal separator
// after the input whose key matches. Used by schedule-card to split
// its previous-dose fields visually from its new-dose fields.
// divider-label (optional, pairs with divider-after-key): a small
// heading rendered immediately after the divider, labelling the
// section that begins on the divider's far side. Used by schedule-
// card to anchor the new-dose section (e.g. "This injection").

import { LitElement, html, css } from 'https://esm.sh/lit@3';

const DEFAULT_EMOJIS = ['😩', '😞', '😐', '🙂', '😄'];

export class EhInputForm extends LitElement {
  static properties = {
    inputs: { type: Array },
    values: { type: Object },
    date: { type: String },
    // Optional `meta.view.display` from the host card. When present,
    // certain input types (currently `rating`) consult its
    // `emojiMap[input.key]` so the buttons render as emojis instead
    // of plain numbers — matching what the card headline already
    // shows. See #193 Part A.
    display: { type: Object },
    // Optional cross-field "either-or" required list. When set (e.g.
    // ["mood", "note"]) the form validates as "at least one of these
    // keys has a value". Individual inputs' `required: true` flags
    // still apply in addition — use requireAny for the listed keys
    // instead of per-input required. See #193 Part B.
    requireAny: { type: Array, attribute: 'require-any' },
    // When set, the form renders a thin horizontal separator after the
    // input whose key matches. Used by schedule-card to visually group
    // its previous-dose fields (reactions) above a divider, with the
    // current-dose fields below. Opt-in; absent = no divider.
    dividerAfterKey: { type: String, attribute: 'divider-after-key' },
    // Optional small heading rendered immediately after the divider —
    // labels the section that begins on the divider's far side. Only
    // takes effect when divider-after-key is also set. Used by
    // schedule-card to anchor the new-dose section ("This injection",
    // "This dose"). Absent = no heading.
    dividerLabel: { type: String, attribute: 'divider-label' },
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
    this.display = null;
    this.requireAny = null;
    this.dividerAfterKey = null;
    this.dividerLabel = null;
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
          else if (input.type === 'chips-multi') s[input.key] = Array.isArray(input.default) ? [...input.default] : [];
          else if ('default' in input) s[input.key] = input.default;
          else s[input.key] = '';
        } else if (input.type === 'chips-multi' && !Array.isArray(s[input.key])) {
          // Coerce a non-array prefilled value (legacy single-string)
          // to the array shape this type expects.
          const v = s[input.key];
          s[input.key] = (v === null || v === undefined || v === '') ? [] : [v];
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
        if (input.type === 'chips-multi' && (!Array.isArray(v) || v.length === 0)) return false;
      }
    }
    // requireAny: at least one of the listed keys must have a value.
    // Use this for either-or fields like mood's [mood, note] where the
    // user might log just a feeling, just a journal line, or both.
    if (Array.isArray(this.requireAny) && this.requireAny.length > 0) {
      const hasAny = this.requireAny.some(k => {
        const v = this._state[k];
        if (v === null || v === undefined || v === '') return false;
        if (Array.isArray(v)) return v.length > 0;
        return true;
      });
      if (!hasAny) return false;
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
      case 'chips': {
        // Single-select pill chips. Stores the option's `value` as a
        // string. Tap an unselected chip to select it; tapping the
        // selected chip again clears the value (so a non-required
        // chips field can be left empty after a stray tap).
        const opts = (input.options || []).map(o => (
          typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value }
        ));
        const selectedStr = v === null || v === undefined ? '' : String(v);
        return html`
          <div
            class="chip-row"
            id=${id}
            role="group"
            aria-label="${input.label || input.key}"
          >
            ${opts.map(o => {
              const isSel = selectedStr === String(o.value);
              return html`
                <button
                  type="button"
                  class="chip ${isSel ? 'selected' : ''}"
                  role="button"
                  aria-pressed=${isSel ? 'true' : 'false'}
                  @click=${() => this._update(input.key, isSel ? '' : o.value)}
                >${o.label}</button>
              `;
            })}
          </div>`;
      }
      case 'chips-multi': {
        // Multi-select pill chips. Stores an array of option values.
        // Tap to toggle. Required: at least one chip selected.
        const opts = (input.options || []).map(o => (
          typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value }
        ));
        const arr = Array.isArray(v) ? v : [];
        const selectedSet = new Set(arr.map(x => String(x)));
        const onToggle = (val) => {
          const sval = String(val);
          const next = selectedSet.has(sval)
            ? arr.filter(x => String(x) !== sval)
            : [...arr, val];
          this._update(input.key, next);
        };
        return html`
          <div
            class="chip-row"
            id=${id}
            role="group"
            aria-label="${input.label || input.key}"
          >
            ${opts.map(o => {
              const isSel = selectedSet.has(String(o.value));
              return html`
                <button
                  type="button"
                  class="chip ${isSel ? 'selected' : ''}"
                  role="button"
                  aria-pressed=${isSel ? 'true' : 'false'}
                  @click=${() => onToggle(o.value)}
                >${o.label}</button>
              `;
            })}
          </div>`;
      }
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
        // When the host card's display block carries an emojiMap,
        // render emojis as the button label instead of the raw number.
        // Two emojiMap shapes are supported, matching what the rest
        // of the app already handles:
        //   flat:  { "1": "😩", "2": "😔", ... }        — used by mood, most atomic rating cards
        //   keyed: { mood: {"1": "😩", ...}, ... }      — used by multi-field cards / {key:emoji} template
        // Value persisted on save stays the numeric index — the
        // emoji is label-only. See #193.
        const rawMap = this.display && this.display.emojiMap;
        let emojiMap = null;
        if (rawMap && typeof rawMap === 'object') {
          if (rawMap[input.key] && typeof rawMap[input.key] === 'object') {
            emojiMap = rawMap[input.key];
          } else if (rawMap[String(min)] !== undefined || rawMap[min] !== undefined) {
            // Flat shape — keys look like the rating values themselves.
            emojiMap = rawMap;
          }
        }
        return html`
          <div class="rating-row">
            ${range.map(i => {
              const label = (emojiMap && (emojiMap[String(i)] ?? emojiMap[i])) || String(i);
              return html`
                <button
                  type="button"
                  class="rating ${emojiMap ? 'rating-emoji' : ''} ${Number(v) === i ? 'selected' : ''}"
                  @click=${() => this._update(input.key, i)}
                  aria-label="${input.label || input.key} ${i}"
                >${label}</button>
              `;
            })}
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
      /* width:100% + padding pushes the computed width past the parent
         unless we opt into border-box. Without this, inputs overflow
         the enclosing modal/panel and produce a rogue horizontal
         scrollbar at the bottom — see #188. */
      box-sizing: border-box;
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
    /* When the rating renders emoji labels (driven by display.emojiMap
       on the host manifest — see #193), bump the font size so the
       emoji read at a touch-friendly size. */
    .rating.rating-emoji { font-size: 22px; font-weight: normal; padding: 6px 8px; }
    .emoji.selected, .rating.selected {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--text-inverse, white);
    }

    /* --- Chip pills (chips / chips-multi) --- */
    .chip-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .chip {
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.12s;
      font-family: inherit;
      line-height: 1.2;
    }
    .chip:hover:not(.selected) {
      border-color: var(--accent);
      color: var(--accent);
    }
    .chip.selected {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--text-inverse, white);
    }
    .chip:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .chip { transition: none; }
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
    /* Opt-in section separator. Set divider-after-key="<input.key>" on
       the host to render this after that field. Used by schedule-card
       (#359) to split previous-dose fields from current-dose fields. */
    hr.form-divider {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 4px 0 4px;
    }
    /* Optional heading paired with the divider — pass divider-label to
       label the section beginning on the far side of the divider. See
       #361 for the schedule-card usage ("This injection" / "This
       dose"). */
    .form-section-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      margin: 0 0 4px;
      text-transform: none;
    }

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
          ${this.dividerAfterKey && this.dividerAfterKey === input.key
            ? html`
              <hr class="form-divider" />
              ${this.dividerLabel ? html`<div class="form-section-label">${this.dividerLabel}</div>` : ''}
            ` : ''}
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
