// public/js/components/eh-list-card.js
// List of persistent items card. Unlike generic-card (which shows one dated
// entry), list-card shows the ENTIRE data array as a roster — every row,
// every day. Rows persist until explicitly deleted. Useful for:
//   - symptoms you're tracking (add one, it shows until removed)
//   - appointments (upcoming list)
//   - allergies / ongoing conditions
//   - anything that's "currently true" rather than "logged on a day"
//
// UX inspired by the iOS home-screen Edit pattern:
//   - Normal view: plain list + a small ✏️ Edit button in top-right
//   - Edit view: every row becomes editable with a red ➖ alongside it
//                + ➕ Add at bottom
//                + Cancel / Done buttons in top-right
//   - Tap ➖ once: row is marked-for-delete (struck through, greyed)
//   - Tap ➖ again: restore
//   - Tap Done: drop marked rows, save whole array, exit edit mode
//   - Tap Cancel: refetch data, discard local changes
//
// Meta config consumed:
//   meta.view.display.primaryField         field name rendered in each row
//   meta.view.display.secondaryTemplate    optional secondary-line template
//   meta.view.display.emptyMessage         shown when data is []
//   meta.view.display.maxCharPreview       default 60; truncates primary
//   meta.writeable.inputs                  schema for the add/edit form
//                                          (primary field + any secondary
//                                          fields the user can fill in)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { renderTemplate } from '../lib/display-template.esm.js';
import { registerRenderer } from '../renderer-registry.js';
import { EhBaseCard, invalidateManifestCache } from './eh-base-card.js';
import './eh-input-form.js';

export class EhListCard extends EhBaseCard {
  static properties = {
    ...EhBaseCard.properties,
    _editing: { state: true },
    _draft: { state: true },       // local copy of data[] while editing
    _deleted: { state: true },     // Set<index> of draft rows marked for deletion
    _expandedRow: { state: true }, // index of the row expanded in view mode
    _saving: { state: true },
    _formError: { state: true },
  };

  constructor() {
    super();
    this._editing = false;
    this._draft = [];
    this._deleted = new Set();
    this._expandedRow = null;
    this._saving = false;
    this._formError = null;
  }

  _m()  { return this.card?.meta || {}; }
  _vc() { return this.card?.viewConfig || {}; }
  _display() { return this._vc().display || this._m().view?.display || {}; }
  _rows() {
    const d = this.data;
    if (Array.isArray(d)) return d;
    return [];
  }
  _primaryField() {
    return this._display().primaryField || 'name';
  }
  _maxCharPreview() {
    return this._display().maxCharPreview ?? 60;
  }
  _inputs() {
    return this._m().writeable?.inputs || [];
  }
  _primaryInput() {
    const inputs = this._inputs();
    return inputs.find(i => i.key === this._primaryField()) || inputs[0] || null;
  }
  _secondaryInputs() {
    const inputs = this._inputs();
    return inputs.filter(i => i.key !== this._primaryField());
  }

  _truncate(s, n) {
    if (typeof s !== 'string') return s == null ? '' : String(s);
    if (s.length <= n) return s;
    return s.slice(0, n).trimEnd() + '…';
  }

  // --- Edit mode ---

  _enterEdit() {
    // Deep clone of current rows so the user can edit without touching `data`
    this._draft = JSON.parse(JSON.stringify(this._rows()));
    this._deleted = new Set();
    this._expandedRow = null;
    this._editing = true;
    this._formError = null;
  }

  _cancelEdit() {
    this._editing = false;
    this._draft = [];
    this._deleted = new Set();
    this._formError = null;
  }

  _toggleDeleted(idx) {
    const next = new Set(this._deleted);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    this._deleted = next;
  }

  _addNewRow() {
    // Seed a blank row with empty strings for each input's key + an 'added' timestamp
    const row = { added: new Date().toISOString() };
    for (const input of this._inputs()) {
      row[input.key] = input.type === 'checkbox' ? false
                      : input.type === 'number' ? null
                      : '';
    }
    this._draft = [...this._draft, row];
  }

  _updateDraftField(idx, key, value) {
    const next = [...this._draft];
    next[idx] = { ...next[idx], [key]: value };
    this._draft = next;
  }

  async _saveEdit() {
    this._saving = true;
    this._formError = null;
    try {
      // Drop deleted rows + any where the primary field is empty
      const primaryKey = this._primaryField();
      const surviving = this._draft
        .filter((_, i) => !this._deleted.has(i))
        .filter(row => {
          const v = row[primaryKey];
          return v !== null && v !== undefined && String(v).trim() !== '';
        });

      const r = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: surviving }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      invalidateManifestCache(this.card.id);
      this.data = surviving;
      this._editing = false;
      this._draft = [];
      this._deleted = new Set();
    } catch (err) {
      this._formError = err.message;
    } finally {
      this._saving = false;
    }
  }

  _toggleExpand(idx) {
    this._expandedRow = this._expandedRow === idx ? null : idx;
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .list-root { position: relative; padding: 0 4px; }
      .edit-toolbar {
        position: absolute;
        /* Position relative to the card-body (list-root is inside it).
           Pull up into the card-header area where users expect edit
           actions to live. Matches the 10-12px top-padding that the
           header uses. */
        top: -32px;
        right: 4px;
        display: flex;
        gap: 6px;
        z-index: 3;
      }
      .tool-btn {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 14px;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        padding: 0;
        transition: all 0.15s;
      }
      .tool-btn:hover { border-color: var(--accent); color: var(--accent); }
      .tool-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .tool-btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--text-inverse, #fff);
      }
      .tool-btn.primary:hover {
        filter: brightness(1.05);
        color: var(--text-inverse, #fff);
      }
      .tool-btn[disabled] { opacity: 0.5; cursor: wait; }

      @media (prefers-reduced-motion: reduce) {
        .tool-btn { transition: none; }
      }

      .rows {
        list-style: none;
        padding: 0;
        margin: 0;
        padding-top: 4px;
      }
      .row {
        padding: 10px 12px;
        border-top: 1px solid var(--border);
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 40px;
      }
      .row:first-child { border-top: none; }
      .row .primary {
        flex: 1;
        min-width: 0;
        font-size: 14px;
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }
      .row.clickable { cursor: pointer; }
      .row.clickable:hover { background: var(--bg-hover, rgba(0,0,0,0.02)); }
      .row.deleted .primary {
        text-decoration: line-through;
        opacity: 0.45;
      }
      .row.deleted .primary-input {
        text-decoration: line-through;
        opacity: 0.45;
      }
      .row-expanded {
        padding: 10px 12px 12px 12px;
        font-size: 12px;
        color: var(--text-secondary);
        background: var(--bg-muted, rgba(0,0,0,0.02));
        border-top: 1px dashed var(--border);
      }
      .row-expanded-form {
        padding: 12px;
        background: var(--bg-muted, rgba(0,0,0,0.02));
        border-top: 1px dashed var(--border);
      }
      .detail-list {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px 10px;
        margin: 0;
        padding: 0;
      }
      .detail-list dt {
        font-weight: 600;
        color: var(--text-muted, var(--text-secondary));
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.04em;
        padding-top: 2px;
      }
      .detail-list dd {
        margin: 0;
        color: var(--text-primary);
        font-size: 13px;
        overflow-wrap: anywhere;
      }
      .detail-empty { opacity: 0.5; }
      .expand-chev {
        color: var(--text-muted, var(--text-secondary));
        font-size: 12px;
        flex-shrink: 0;
        padding-left: 6px;
        line-height: 1;
      }
      .detail-btn {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        font-size: 14px;
        cursor: pointer;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        line-height: 1;
      }
      .detail-btn:hover, .detail-btn:focus-visible {
        border-color: var(--accent);
        color: var(--accent);
        outline: none;
      }

      .minus-btn {
        background: transparent;
        border: none;
        color: #d0323e;
        font-size: 18px;
        line-height: 1;
        padding: 4px 6px;
        cursor: pointer;
        font-family: inherit;
      }
      .minus-btn:focus-visible {
        outline: 2px solid #d0323e;
        outline-offset: 2px;
        border-radius: 4px;
      }

      .primary-input {
        flex: 1;
        min-width: 0;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-input, var(--bg-card));
        color: var(--text-primary);
        font-family: inherit;
        /* 16px prevents iOS Safari auto-zoom on focus */
        font-size: 16px;
      }
      .primary-input:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -1px;
        border-color: var(--accent);
      }

      .secondary-line {
        margin-top: 2px;
        font-size: 12px;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .add-row {
        padding: 10px 12px;
        border-top: 1px dashed var(--border);
      }
      .add-btn {
        background: transparent;
        border: 1px dashed var(--border);
        color: var(--accent);
        padding: 8px 14px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        font-family: inherit;
        font-weight: 600;
        width: 100%;
      }
      .add-btn:hover { border-color: var(--accent); background: var(--accent-bg, rgba(0,212,170,0.05)); }
      .add-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .empty {
        padding: 20px 12px;
        text-align: center;
        color: var(--text-muted, var(--text-secondary));
        font-size: 13px;
        font-style: italic;
      }
      .err { color: #ff4466; font-size: 12px; padding: 8px 12px; }

      @media (prefers-reduced-motion: reduce) {
        .tool-btn, .add-btn, .minus-btn { transition: none; }
      }
    `,
  ];

  renderCard() {
    const rows = this._editing ? this._draft : this._rows();
    const canWrite = !!(this._m().writeable?.fromWebapp);
    const display = this._display();

    return html`
      <div class="list-root">
        ${canWrite ? html`
          <div class="edit-toolbar">
            ${this._editing ? html`
              <button
                class="tool-btn"
                @click=${this._cancelEdit}
                ?disabled=${this._saving}
                aria-label="Cancel — discard changes"
                title="Cancel"
              >\u2715</button>
              <button
                class="tool-btn primary"
                @click=${this._saveEdit}
                ?disabled=${this._saving}
                aria-label="Done — save changes"
                title="${this._saving ? 'Saving…' : 'Done'}"
              >${this._saving ? html`<span style="font-size: 11px;">…</span>` : '\u2713'}</button>
            ` : html`
              <button
                class="tool-btn"
                @click=${this._enterEdit}
                aria-label="Edit list"
                title="Edit"
              >\u270F\uFE0F</button>
            `}
          </div>
        ` : ''}

        ${this._editing
          ? this._renderEditMode(rows)
          : this._renderViewMode(rows, display)}

        ${this._formError ? html`<div class="err">${this._formError}</div>` : ''}
      </div>
    `;
  }

  _renderViewMode(rows, display) {
    if (!rows || rows.length === 0) {
      return html`<div class="empty">${display.emptyMessage || 'No items yet.'}</div>`;
    }
    const maxChars = this._maxCharPreview();
    const primaryField = this._primaryField();
    const secondaryInputs = this._secondaryInputs();
    return html`
      <ul class="rows">
        ${rows.map((row, idx) => {
          const primary = row[primaryField] ?? '';
          const truncated = this._truncate(primary, maxChars);
          const expanded = this._expandedRow === idx;
          const secondary = display.secondaryTemplate
            ? renderTemplate(display.secondaryTemplate, row, display)
            : '';

          // A row is always expandable — tapping reveals the full detail
          // view with every non-primary field rendered as a read-only
          // label + value.
          return html`
            <li>
              <div
                class="row clickable"
                @click=${() => this._toggleExpand(idx)}
                role="button"
                tabindex="0"
                @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._toggleExpand(idx); } }}
                aria-expanded="${expanded}"
              >
                <div class="primary">
                  ${expanded ? primary : truncated}
                  ${secondary && !expanded ? html`<div class="secondary-line">${secondary}</div>` : ''}
                </div>
                <span class="expand-chev" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
              </div>
              ${expanded ? html`
                <div class="row-expanded">
                  ${secondaryInputs.length === 0
                    ? (secondary ? html`<div>${secondary}</div>` : html`<em style="opacity: 0.6;">No extra details.</em>`)
                    : html`
                      <dl class="detail-list">
                        ${secondaryInputs.map(input => {
                          const v = row[input.key];
                          const hasValue = v !== null && v !== undefined && v !== '';
                          return html`
                            <dt>${input.label || input.key}</dt>
                            <dd>${hasValue ? String(v) : html`<span class="detail-empty">—</span>`}</dd>
                          `;
                        })}
                      </dl>
                    `}
                </div>
              ` : ''}
            </li>
          `;
        })}
      </ul>
    `;
  }

  _onExpandedFormSubmit(idx, e) {
    // The generic eh-input-form emits { key: value } for every input on
    // Save. Merge those into the draft row + collapse.
    const payload = e.detail || {};
    const next = [...this._draft];
    next[idx] = { ...next[idx], ...payload };
    // Remove the `date` field that eh-input-form auto-fills — list-card
    // rows don't carry a per-entry date.
    if (next[idx].date && !this._inputs().find(i => i.key === 'date')) {
      delete next[idx].date;
    }
    this._draft = next;
    this._expandedRow = null;
  }

  _onExpandedFormCancel() {
    this._expandedRow = null;
  }

  _renderEditMode(rows) {
    const primaryField = this._primaryField();
    const primaryInput = this._primaryInput();
    const secondaryInputs = this._secondaryInputs();
    const maxLen = primaryInput?.maxLength;
    const hasSecondaryFields = secondaryInputs.length > 0;
    return html`
      <ul class="rows">
        ${rows.map((row, idx) => {
          const isDeleted = this._deleted.has(idx);
          const expanded = this._expandedRow === idx;
          return html`
            <li>
              <div class="row ${isDeleted ? 'deleted' : ''} ${expanded ? 'expanded' : ''}">
                <button
                  class="minus-btn"
                  @click=${(e) => { e.stopPropagation(); this._toggleDeleted(idx); }}
                  aria-label="${isDeleted ? 'Restore' : 'Delete'} row ${idx + 1}"
                  title="${isDeleted ? 'Restore' : 'Delete'}"
                >${isDeleted ? '↺' : '➖'}</button>
                <input
                  class="primary-input"
                  type="text"
                  .value=${row[primaryField] ?? ''}
                  placeholder="${primaryInput?.placeholder || primaryInput?.label || ''}"
                  maxlength="${maxLen || ''}"
                  ?disabled=${isDeleted}
                  @input=${(e) => this._updateDraftField(idx, primaryField, e.target.value)}
                />
                ${hasSecondaryFields && !isDeleted ? html`
                  <button
                    class="detail-btn"
                    @click=${() => this._toggleExpand(idx)}
                    aria-label="${expanded ? 'Close details' : 'Edit extra fields'} for row ${idx + 1}"
                    title="${expanded ? 'Close details' : 'Edit extra fields'}"
                  >${expanded ? '▾' : '…'}</button>
                ` : ''}
              </div>
              ${expanded && !isDeleted ? html`
                <div class="row-expanded-form">
                  <eh-input-form
                    .inputs=${secondaryInputs}
                    .values=${row}
                    submit-label="Apply"
                    cancel-label="Cancel"
                    @eh-submit=${(e) => this._onExpandedFormSubmit(idx, e)}
                    @eh-cancel=${this._onExpandedFormCancel}
                  ></eh-input-form>
                </div>
              ` : ''}
            </li>
          `;
        })}
      </ul>
      <div class="add-row">
        <button class="add-btn" @click=${this._addNewRow}>
          ➕ Add
        </button>
      </div>
    `;
  }
}
customElements.define('eh-list-card', EhListCard);
registerRenderer('list-card', 'eh-list-card');
