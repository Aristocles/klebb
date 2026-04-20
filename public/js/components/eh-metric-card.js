// eh-metric-card.js — single big number + optional secondary + subtitle.
// Config (meta.view.display):
//   primary:   "latest.field" | "count" | "sum.field" | "literal:X"
//   secondary: same pattern (optional)
//   format:    "{systolic}/{diastolic}"  — optional; when set, substitutes fields
//   unit:      "mmHg" etc.
//   subtitle:  "Last reading: {date}"    — optional; supports {field} tokens
//   thresholds: [{ max, colour, label }] — applied to primary value
//
// Inline input form (meta.view.inputs):
//   If meta.view.inputs is a non-empty array of field descriptors, the card
//   shows an "Edit" link that opens a small inline form. Submitting appends
//   a new entry to the data array (or replaces today's entry if the schema
//   is a date-keyed object). Writeable rules gate the Edit link.
//
//   Field descriptor shape:
//     { name, label, type: "number"|"text", required?, min?, max?, placeholder?, step? }

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export class EhMetricCard extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _editing: { state: true },
    _draft: { state: true },
    _saving: { state: true },
  };

  constructor() {
    super();
    this._editing = false;
    this._draft = {};
    this._saving = false;
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .primary {
        font-size: 2rem;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.1;
      }
      .secondary {
        font-size: 1rem;
        color: var(--text-secondary);
        margin-left: 6px;
      }
      .unit {
        font-size: 0.9rem;
        color: var(--text-muted, var(--text-secondary));
        margin-left: 3px;
      }
      .subtitle {
        font-size: 11px;
        color: var(--text-muted, var(--text-secondary));
        margin-top: 4px;
      }
      .threshold-chip {
        display: inline-block;
        margin-left: 8px;
        padding: 1px 7px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 600;
      }
      .edit-link {
        font-size: 11px;
        color: var(--accent);
        cursor: pointer;
        margin-top: 8px;
        display: inline-block;
      }
      .edit-link:hover { text-decoration: underline; }

      /* Edit form */
      .form {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 10px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .field-row {
        display: flex;
        gap: 8px;
      }
      .field-row .field { flex: 1; }
      .field label {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .field input, .field textarea {
        background: var(--bg-input, var(--bg-card));
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 6px 8px;
        font-family: inherit;
        font-size: 14px;
        box-sizing: border-box;
      }
      .field input:focus, .field textarea:focus {
        outline: none;
        border-color: var(--accent);
      }
      .field textarea {
        min-height: 40px;
        resize: vertical;
      }
      .btn-row {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      button {
        background: var(--accent);
        color: var(--bg-card);
        border: none;
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
      }
      button.ghost {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      button[disabled] { opacity: 0.5; cursor: not-allowed; }
      .err {
        color: #ff4466;
        font-size: 11px;
      }
    `,
  ];

  get _inputs() {
    const i = this._config?.inputs;
    return Array.isArray(i) && i.length > 0 ? i : null;
  }

  get _canEdit() {
    return !!this._inputs && this._canWrite;
  }

  // "per-date" (default): upsert by date — one entry per day, editing
  // the existing one if it exists.
  // "append": accumulate entries, no deduplication (old behaviour).
  get _entryMode() {
    return this._config?.entryMode || 'per-date';
  }

  // Find the existing entry for the viewed date (array shape only).
  // Returns { entry, index } or null.
  _existingForDate() {
    if (!Array.isArray(this.data)) return null;
    const idx = this.data.findIndex(e => e.date === this.date);
    return idx >= 0 ? { entry: this.data[idx], index: idx } : null;
  }

  _startEdit() {
    if (!this._canEdit) return;
    const draft = {};
    // Pre-fill from the existing entry for this date (if any, in per-date mode)
    const existing = this._entryMode === 'per-date' ? this._existingForDate() : null;
    for (const f of this._inputs) {
      draft[f.name] = existing?.entry?.[f.name] ?? '';
    }
    this._draft = draft;
    this._editing = true;
  }

  _cancelEdit() {
    this._editing = false;
    this._draft = {};
  }

  _setField(name, value) {
    this._draft = { ...this._draft, [name]: value };
  }

  _validate() {
    for (const f of this._inputs) {
      const v = this._draft[f.name];
      if (f.required && (v === '' || v === null || v === undefined)) {
        return `${f.label || f.name} is required`;
      }
      if (f.type === 'number' && v !== '' && v !== null && v !== undefined) {
        const n = Number(v);
        if (Number.isNaN(n)) return `${f.label || f.name} must be a number`;
        if (f.min !== undefined && n < f.min) return `${f.label || f.name} must be ≥ ${f.min}`;
        if (f.max !== undefined && n > f.max) return `${f.label || f.name} must be ≤ ${f.max}`;
      }
    }
    return null;
  }

  async _saveEntry() {
    const err = this._validate();
    if (err) { this.error = err; return; }
    this._saving = true;
    try {
      // Build the new entry. Coerce numbers; preserve text.
      const entry = { date: this.date };
      for (const f of this._inputs) {
        let v = this._draft[f.name];
        if (v === '' || v === null || v === undefined) continue;
        if (f.type === 'number') v = Number(v);
        entry[f.name] = v;
      }
      entry.loggedAt = new Date().toISOString();

      // Decide how to merge based on data shape + entry mode.
      let newData;
      if (Array.isArray(this.data)) {
        if (this._entryMode === 'per-date') {
          // Upsert: replace any existing entry for this date.
          const idx = this.data.findIndex(e => e.date === this.date);
          if (idx >= 0) {
            // Preserve fields the form doesn't touch (e.g. notes logged earlier)
            const merged = { ...this.data[idx], ...entry };
            newData = this.data.map((e, i) => i === idx ? merged : e);
          } else {
            newData = [...this.data, entry];
          }
        } else {
          // append mode — no dedup
          newData = [...this.data, entry];
        }
      } else if (this.data && typeof this.data === 'object' && !Array.isArray(this.data)) {
        // Date-keyed object — always upsert
        newData = { ...this.data, [this.date]: entry };
      } else {
        newData = [entry];
      }

      const res = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: newData }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = newData;
      this._editing = false;
      this._draft = {};
      this.error = null;
    } catch (e) {
      this.error = e.message;
    } finally {
      this._saving = false;
    }
  }

  renderCard() {
    if (this._editing) return this._renderForm();

    const cfg = this._config;
    const disp = cfg.display || {};
    const record = this._recordForView();

    const primary = this._resolveFromRecord(disp.primary, record);
    const secondary = disp.secondary ? this._resolveFromRecord(disp.secondary, record) : null;
    const unit = disp.unit || '';

    // format: template string with {field} tokens from the viewed record
    let primaryStr = primary;
    if (disp.format && record) {
      primaryStr = disp.format.replace(/\{(\w+)\}/g, (_, k) => {
        const v = record[k];
        return v === undefined || v === null ? '—' : v;
      });
    }

    // If no record for this date, primary is meaningless
    if (!record && (disp.primary || '').startsWith('latest.')) {
      primaryStr = '—';
    }

    const thresh = this._findThreshold(Number(primary), disp.thresholds || []);
    const subtitle = disp.subtitle ? this._interpolateFromRecord(disp.subtitle, record) : null;

    return html`
      <div>
        <span class="primary">${primaryStr ?? '—'}</span>
        ${unit ? html`<span class="unit">${unit}</span>` : ''}
        ${secondary !== null ? html`<span class="secondary">${secondary}</span>` : ''}
        ${thresh ? html`<span class="threshold-chip" style="background:${thresh.colour}22;color:${thresh.colour}">${thresh.label}</span>` : ''}
      </div>
      ${subtitle ? html`<div class="subtitle">${subtitle}</div>` : ''}
      ${this._canEdit ? html`<span class="edit-link" @click=${this._startEdit}>${this._editLinkLabel()}</span>` : ''}
    `;
  }

  _editLinkLabel() {
    const hasExisting = this._existingForDate() !== null
      || (this.data && typeof this.data === 'object' && !Array.isArray(this.data) && this.data[this.date]);
    return hasExisting ? 'Edit' : 'Add';
  }

  _renderForm() {
    const inputs = this._inputs;
    const twoCol = inputs.length === 2 && inputs.every(f => f.type === 'number');
    return html`
      <div class="form">
        ${twoCol
          ? html`
              <div class="field-row">
                ${inputs.map(f => this._renderField(f))}
              </div>
            `
          : inputs.map(f => this._renderField(f))}
        ${this.error ? html`<div class="err">${this.error}</div>` : ''}
        <div class="btn-row">
          <button class="ghost" @click=${this._cancelEdit} ?disabled=${this._saving}>Cancel</button>
          <button @click=${this._saveEntry} ?disabled=${this._saving}>
            ${this._saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    `;
  }

  _renderField(f) {
    const val = this._draft[f.name] ?? '';
    return html`
      <div class="field">
        <label>${f.label || f.name}</label>
        ${f.type === 'text' && (f.multiline || (f.placeholder && f.placeholder.length > 40))
          ? html`
              <textarea
                placeholder=${f.placeholder || ''}
                .value=${val}
                @input=${e => this._setField(f.name, e.target.value)}
              ></textarea>
            `
          : html`
              <input
                type=${f.type === 'number' ? 'number' : 'text'}
                placeholder=${f.placeholder || ''}
                min=${f.min ?? ''}
                max=${f.max ?? ''}
                step=${f.step ?? (f.type === 'number' ? '1' : '')}
                .value=${val}
                @input=${e => this._setField(f.name, e.target.value)}
              />
            `}
      </div>
    `;
  }

  // The record to display. Prioritises the viewed date:
  //   - If viewing a specific date and an entry exists for it → show that entry.
  //   - If viewing today and dateContext is 'latest' → show the most recent entry overall.
  //   - If viewing today with no dateContext specified → latest entry.
  //   - Otherwise → null (no reading for this day).
  _recordForView() {
    const d = this.data;
    if (!d) return null;
    const viewed = this.date;
    // Array shape: each entry has a .date
    if (Array.isArray(d)) {
      const exact = d.find(e => e && e.date === viewed);
      if (exact) return exact;
      // No entry for this date. On today, fall back to latest.
      if (this.dateMode === 'today' && (this._config?.dateContext === 'latest' || !this._config?.dateContext)) {
        return d.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || null;
      }
      return null;
    }
    // Date-keyed object shape: { 'YYYY-MM-DD': {...} }
    if (d && typeof d === 'object') {
      if (d[viewed]) return d[viewed];
      if (this.dateMode === 'today' && (this._config?.dateContext === 'latest' || !this._config?.dateContext)) {
        const keys = Object.keys(d).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
        const latest = keys[keys.length - 1];
        return latest ? d[latest] : null;
      }
      return null;
    }
    return null;
  }

  _latestRecord() {
    // Kept for backwards compatibility with _resolve (used for 'count'/'sum'
    // aggregates that shouldn't care about date). Prefer _recordForView().
    const d = this.data;
    if (!Array.isArray(d) || d.length === 0) return null;
    if (d[0]?.date) {
      return d.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    }
    return d[d.length - 1];
  }

  _resolve(spec) {
    if (!spec) return null;
    if (typeof spec !== 'string') return spec;
    if (spec.startsWith('literal:')) return spec.slice(8);
    if (spec === 'count') return Array.isArray(this.data) ? this.data.length : 0;
    if (spec.startsWith('latest.')) {
      const field = spec.slice(7);
      const r = this._latestRecord();
      return r ? r[field] : null;
    }
    if (spec.startsWith('sum.')) {
      const field = spec.slice(4);
      if (!Array.isArray(this.data)) return null;
      return this.data.reduce((s, e) => s + (Number(e[field]) || 0), 0);
    }
    return null;
  }

  // Variant of _resolve that pulls 'latest.field' from a specific record
  // (used to render the entry for the viewed date).
  _resolveFromRecord(spec, record) {
    if (!spec) return null;
    if (typeof spec !== 'string') return spec;
    if (spec.startsWith('literal:')) return spec.slice(8);
    if (spec === 'count') return Array.isArray(this.data) ? this.data.length : 0;
    if (spec.startsWith('latest.')) {
      const field = spec.slice(7);
      return record ? record[field] : null;
    }
    if (spec.startsWith('sum.')) {
      const field = spec.slice(4);
      if (!Array.isArray(this.data)) return null;
      return this.data.reduce((s, e) => s + (Number(e[field]) || 0), 0);
    }
    return null;
  }

  _interpolate(str) {
    const r = this._latestRecord() || {};
    return String(str).replace(/\{(\w+)\}/g, (_, k) => r[k] ?? '');
  }

  _interpolateFromRecord(str, record) {
    const r = record || {};
    return String(str).replace(/\{(\w+)\}/g, (_, k) => r[k] ?? '');
  }

  _findThreshold(val, list) {
    if (!Array.isArray(list) || list.length === 0 || !Number.isFinite(val)) return null;
    for (const t of list) {
      if (t.max === undefined || val <= t.max) return t;
    }
    return list[list.length - 1];
  }
}
customElements.define('eh-metric-card', EhMetricCard);
registerRenderer('metric-card', 'eh-metric-card');
registerRenderer('metric-card-with-input', 'eh-metric-card');
registerRenderer('metric-card-with-sparkline', 'eh-metric-card');
