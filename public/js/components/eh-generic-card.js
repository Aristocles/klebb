// public/js/components/eh-generic-card.js
// Zero-code card renderer driven entirely by meta.view.display + meta.writeable.
//
// Opt a manifest into this renderer by setting:
//   meta.view.component = "generic-card"
//
// Meta fields consumed:
//   meta.label                            — card title
//   meta.emoji                            — optional title emoji
//   meta.view.dateContext = "latest" | "viewedDate"   (default "viewedDate")
//   meta.view.display.template            — template string for the headline
//   meta.view.display.secondary           — optional template for the sub-line
//   meta.view.display.emojiMap            — { key: { value: emoji } } for {key:emoji}
//   meta.view.display.emptyHeadline       — shown when no entry for the day
//   meta.writeable.fromWebapp             — enables the ✏️/➕ input button
//   meta.writeable.inputs                 — array of input specs for eh-input-form
//   meta.writeable.maxReadingsPerDay      — default 1 (upsert behaviour)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { renderTemplate } from '../lib/display-template.esm.js';
import { registerRenderer } from '../renderer-registry.js';
import { EhBaseCard, invalidateManifestCache } from './eh-base-card.js';
import './eh-input-form.js';

export class EhGenericCard extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _editing: { state: true },
    _saving: { state: true },
    _formError: { state: true },
  };

  constructor() {
    super();
    this._editing = false;
    this._saving = false;
    this._formError = null;
  }

  // Local aliases — don't shadow EhBaseCard's _meta getter
  _m() { return this.card?.meta || {}; }
  _vc() { return this.card?.viewConfig || {}; }
  _display() { return this._vc().display || this._m().view?.display || {}; }
  _dateContext() { return this._vc().dateContext || this._m().view?.dateContext || 'viewedDate'; }

  _entries() {
    const d = this.data;
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.data)) return d.data; // defensive
    return [];
  }

  _currentEntry() {
    const entries = this._entries();
    if (entries.length === 0) return null;
    if (this._dateContext() === 'latest') {
      return [...entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    }
    return entries.find(e => e.date === this.date) || null;
  }

  _openEdit() {
    this._editing = true;
    this._formError = null;
  }
  _closeEdit() {
    this._editing = false;
    this._formError = null;
  }

  async _onSubmit(e) {
    const payload = e.detail;
    const meta = this._m();
    this._saving = true;
    this._formError = null;
    try {
      const entry = { ...payload };
      if (!entry.date) entry.date = this.date;
      const existing = this._entries();
      const max = meta?.writeable?.maxReadingsPerDay ?? 1;

      const sameDay = existing.filter(d => d.date === entry.date);
      const others = existing.filter(d => d.date !== entry.date);

      let updated;
      if (max === 1) {
        updated = [...others, entry];
      } else {
        const combined = [...sameDay, entry];
        const capped = combined.slice(-max);
        updated = [...others, ...capped];
      }
      updated.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      const r = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: updated }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      invalidateManifestCache(this.card.id);
      this.data = updated;
      this._editing = false;
    } catch (err) {
      this._formError = err.message;
    } finally {
      this._saving = false;
    }
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .gen-headline {
        font-size: 1.8rem;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.2;
      }
      .gen-secondary {
        margin-top: 6px;
        font-size: 0.95rem;
        color: var(--text-secondary);
      }
      .gen-empty {
        color: var(--text-muted, var(--text-secondary));
        font-style: italic;
        font-size: 1rem;
      }
      .edit-btn {
        position: absolute;
        top: 12px;
        right: 12px;
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        z-index: 2;
      }
      .edit-btn:hover {
        border-color: var(--accent);
        color: var(--accent);
      }
      .card-inner { position: relative; padding-right: 36px; }
      .err { color: #ff4466; font-size: 12px; margin-top: 6px; }
    `,
  ];

  renderCard() {
    const meta = this._m();
    const display = this._display();
    const entry = this._currentEntry();
    const hasEntry = entry !== null;

    const canWrite = !!(meta?.writeable?.fromWebapp && Array.isArray(meta?.writeable?.inputs) && meta.writeable.inputs.length > 0);
    const editIcon = hasEntry ? '✏️' : '➕';

    const headline = hasEntry
      ? renderTemplate(display.template || '', entry, display)
      : (display.emptyHeadline || 'No entry yet');

    const secondary = hasEntry && display.secondary
      ? renderTemplate(display.secondary, entry, display)
      : '';

    return html`
      <div class="card-inner">
        ${canWrite ? html`
          <button class="edit-btn"
            @click=${this._openEdit}
            aria-label="${hasEntry ? 'Edit' : 'Add'} entry"
            title="${hasEntry ? 'Edit' : 'Add'} entry">${editIcon}</button>
        ` : ''}

        ${this._editing ? html`
          <eh-input-form
            .inputs=${meta.writeable.inputs}
            .values=${entry || {}}
            .date=${this.date}
            submit-label=${hasEntry ? 'Update' : 'Add'}
            ?busy=${this._saving}
            @eh-submit=${this._onSubmit}
            @eh-cancel=${this._closeEdit}
          ></eh-input-form>
        ` : hasEntry ? html`
          <div class="gen-headline">${headline}</div>
          ${secondary ? html`<div class="gen-secondary">${secondary}</div>` : ''}
        ` : html`
          <div class="gen-empty">${headline}</div>
        `}

        ${this._formError ? html`<div class="err">${this._formError}</div>` : ''}
      </div>
    `;
  }
}
customElements.define('eh-generic-card', EhGenericCard);
registerRenderer('generic-card', 'eh-generic-card');
