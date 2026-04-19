// eh-notes-card.js — freeform text per date (single block per day)
// Data shape: { "YYYY-MM-DD": "text..." } OR { "YYYY-MM-DD": { text: "..." } }
// Reads/writes based on this.date.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';

export class EhNotesCard extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _editing: { state: true },
    _draft: { state: true },
    _saving: { state: true },
  };

  constructor() {
    super();
    this._editing = false;
    this._draft = '';
    this._saving = false;
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .note-text {
        white-space: pre-wrap;
        font-size: 14px;
        color: var(--text-primary);
        line-height: 1.5;
        min-height: 24px;
      }
      .placeholder {
        color: var(--text-muted, var(--text-secondary));
        font-style: italic;
        font-size: 13px;
      }
      textarea {
        width: 100%;
        min-height: 80px;
        background: var(--bg-input, var(--bg-card));
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 10px;
        font-family: inherit;
        font-size: 14px;
        resize: vertical;
        box-sizing: border-box;
      }
      .btn-row {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      button {
        background: var(--accent-bg, rgba(0,212,170,0.2));
        color: var(--accent, #00d4aa);
        border: 1px solid var(--accent, #00d4aa);
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
      }
      button:hover { background: var(--accent, #00d4aa); color: var(--bg-card); }
      button.secondary {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      button[disabled] { opacity: 0.4; cursor: not-allowed; }
      .edit-link {
        display: inline-block;
        font-size: 11px;
        color: var(--accent, #00d4aa);
        cursor: pointer;
        margin-top: 4px;
      }
    `,
  ];

  get _textForDate() {
    const d = this.data;
    if (!d || !this.date) return '';
    const entry = d[this.date];
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object' && typeof entry.text === 'string') return entry.text;
    return '';
  }

  _startEdit() {
    if (!this._canWrite) return;
    this._draft = this._textForDate;
    this._editing = true;
  }

  _cancelEdit() {
    this._editing = false;
    this._draft = '';
  }

  async _save() {
    this._saving = true;
    // Compose the full data object with the new/updated entry
    const existing = (this.data && typeof this.data === 'object') ? { ...this.data } : {};
    if (this._draft.trim()) {
      existing[this.date] = { text: this._draft.trim(), updated: new Date().toISOString() };
    } else {
      delete existing[this.date];
    }
    try {
      const res = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: existing }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = existing;
      this._editing = false;
      this._draft = '';
    } catch (e) {
      this.error = e.message;
    } finally {
      this._saving = false;
    }
  }

  renderCard() {
    const text = this._textForDate;
    if (this._editing) {
      return html`
        <textarea
          .value=${this._draft}
          @input=${e => this._draft = e.target.value}
          placeholder="Write a note for ${this.date}…"
        ></textarea>
        <div class="btn-row">
          <button @click=${this._save} ?disabled=${this._saving}>
            ${this._saving ? 'Saving…' : 'Save'}
          </button>
          <button class="secondary" @click=${this._cancelEdit} ?disabled=${this._saving}>Cancel</button>
        </div>
      `;
    }
    if (!text) {
      if (!this._canWrite) {
        return html`<div class="placeholder">No note for this day.</div>`;
      }
      return html`
        <div class="placeholder">No note yet.</div>
        <span class="edit-link" @click=${this._startEdit}>＋ Add a note</span>
      `;
    }
    return html`
      <div class="note-text">${text}</div>
      ${this._canWrite ? html`<span class="edit-link" @click=${this._startEdit}>Edit</span>` : ''}
    `;
  }
}
customElements.define('eh-notes-card', EhNotesCard);
registerRenderer('notes-card', 'eh-notes-card');
