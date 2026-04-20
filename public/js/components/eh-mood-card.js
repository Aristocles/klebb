// eh-mood-card.js — mood check-in card. Shows today's logged mood if any,
// otherwise offers a tap-to-log flow.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';

const MOODS = [
  { value: 1, emoji: '\u{1F629}', label: 'Awful' },
  { value: 2, emoji: '\u{1F634}', label: 'Tired' },
  { value: 3, emoji: '\u{1F610}', label: 'Meh' },
  { value: 4, emoji: '\u{1F642}', label: 'Good' },
  { value: 5, emoji: '\u{1F604}', label: 'Great' },
];

export class EhMoodCard extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _editing: { state: true },
    _draftMood: { state: true },
    _draftNotes: { state: true },
    _saving: { state: true },
  };

  constructor() {
    super();
    this._editing = false;
    this._draftMood = null;
    this._draftNotes = '';
    this._saving = false;
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .row {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 4px 0 2px;
      }
      .big-emoji { font-size: 32px; line-height: 1; }
      .label {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .notes {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 3px;
      }
      .placeholder {
        font-size: 13px;
        color: var(--text-muted, var(--text-secondary));
        font-style: italic;
        padding: 6px 0;
      }
      .prompt {
        font-size: 13px;
        color: var(--text-primary);
        margin-bottom: 8px;
      }
      .emoji-row {
        display: flex;
        gap: 6px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .emoji-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: 2px solid var(--border);
        background: var(--bg-card);
        font-size: 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: all 0.15s;
      }
      .emoji-btn:hover { border-color: var(--accent); transform: scale(1.08); }
      .emoji-btn.selected {
        border-color: var(--accent);
        background: var(--accent-bg, rgba(0,212,170,0.15));
      }
      textarea {
        width: 100%;
        min-height: 50px;
        background: var(--bg-input, var(--bg-card));
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 6px 10px;
        font-family: inherit;
        font-size: 13px;
        resize: vertical;
        box-sizing: border-box;
        margin-bottom: 8px;
      }
      .btn-row { display: flex; gap: 8px; justify-content: flex-end; }
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
      .edit-link {
        font-size: 11px;
        color: var(--accent);
        cursor: pointer;
        margin-left: auto;
      }
    `,
  ];

  get _todaysEntry() {
    const d = this.data;
    if (!d || typeof d !== 'object' || !this.date) return null;
    return d[this.date] || null;
  }

  _moodMeta(value) {
    return MOODS.find(m => m.value === value) || null;
  }

  _startEdit() {
    if (!this._canWrite) return;
    const current = this._todaysEntry;
    this._draftMood = current?.mood || null;
    this._draftNotes = current?.notes || '';
    this._editing = true;
  }

  _cancelEdit() {
    this._editing = false;
    this._draftMood = null;
    this._draftNotes = '';
  }

  async _save() {
    if (!this._draftMood) return;
    this._saving = true;
    try {
      const existing = (this.data && typeof this.data === 'object') ? { ...this.data } : {};
      existing[this.date] = {
        mood: this._draftMood,
        notes: this._draftNotes.trim(),
        time: new Date().toISOString(),
      };
      const res = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: existing }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = existing;
      this._editing = false;
      // Tell the floating mood-checkin to dismiss for today
      try { localStorage.setItem('mood-checkin-date', this.date); } catch {}
    } catch (e) {
      this.error = e.message;
    } finally {
      this._saving = false;
    }
  }

  renderCard() {
    const entry = this._todaysEntry;

    if (this._editing) {
      return html`
        <div class="prompt">How are you feeling${this.dateMode === 'today' ? ' today' : ''}?</div>
        <div class="emoji-row">
          ${MOODS.map(m => html`
            <button
              class="emoji-btn ${this._draftMood === m.value ? 'selected' : ''}"
              @click=${() => this._draftMood = m.value}
              title="${m.label}"
            >${m.emoji}</button>
          `)}
        </div>
        <textarea
          placeholder="Notes (optional)…"
          .value=${this._draftNotes}
          @input=${e => this._draftNotes = e.target.value}
        ></textarea>
        <div class="btn-row">
          <button class="ghost" @click=${this._cancelEdit} ?disabled=${this._saving}>Cancel</button>
          <button @click=${this._save} ?disabled=${!this._draftMood || this._saving}>
            ${this._saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      `;
    }

    if (entry) {
      const m = this._moodMeta(entry.mood);
      return html`
        <div class="row">
          <span class="big-emoji">${m?.emoji || '❓'}</span>
          <div style="flex:1">
            <div class="label">${m?.label || 'Unknown'}</div>
            ${entry.notes ? html`<div class="notes">${entry.notes}</div>` : ''}
          </div>
          ${this._canWrite ? html`<span class="edit-link" @click=${this._startEdit}>Edit</span>` : ''}
        </div>
      `;
    }

    if (!this._canWrite) {
      return html`<div class="placeholder">No mood logged.</div>`;
    }
    return html`
      <div class="placeholder">How are you feeling${this.dateMode === 'today' ? ' today' : ''}?</div>
      <div class="btn-row" style="justify-content: flex-start;">
        <button @click=${this._startEdit}>Log mood</button>
      </div>
    `;
  }
}
customElements.define('eh-mood-card', EhMoodCard);
registerRenderer('quick-action-card', 'eh-mood-card'); // keep quick-action-card name for backwards compat
registerRenderer('mood-card', 'eh-mood-card');
