// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-add-card-modal.js
// Add Card modal. Three panes:
//   - Gallery (left): templates grouped by category, searchable.
//   - Preview (top right): live render of the selected template's card.
//   - Form (bottom right): one input per placeholder in the selected
//     template, with live updates driving the preview.
//
// Open with:
//   const m = document.createElement('eh-add-card-modal');
//   document.body.appendChild(m);
//   m.open();
//
// Fires 'eh-add-card-done' with { id, welcomeAutoHidden } on success,
// 'eh-add-card-cancel' when closed without creating.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { resolveRenderer } from '../renderer-registry.js';
import {
  extractPlaceholders,
  parseSubstituted,
} from '../lib/template-substitute.js';
import { errorFromResponse } from '../lib/save-error.js';

// Ensure all renderers are imported so the preview can mount them.
import './eh-view-renderer.js';

const CATEGORY_ORDER = ['tracking', 'protocols', 'lifestyle', 'imported'];
const CATEGORY_LABELS = {
  tracking: 'Tracking',
  protocols: 'Protocols',
  lifestyle: 'Lifestyle',
  imported: 'Imported data',
};

export class EhAddCardModal extends LitElement {
  static properties = {
    _templates: { state: true },
    _loading: { state: true },
    _loadError: { state: true },
    _filter: { state: true },
    _selectedId: { state: true },
    _values: { state: true },
    _busy: { state: true },
    _submitError: { state: true },
    _advancedOpen: { state: true },
  };

  constructor() {
    super();
    this._templates = [];
    this._loading = true;
    this._loadError = null;
    this._filter = '';
    this._selectedId = null;
    this._values = {};
    this._busy = false;
    this._submitError = null;
    this._advancedOpen = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadTemplates();
    this._escHandler = (e) => { if (e.key === 'Escape') this._cancel(); };
    window.addEventListener('keydown', this._escHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._escHandler);
  }

  open() {
    const dlg = this.renderRoot?.querySelector('dialog');
    if (dlg && !dlg.open) dlg.showModal();
  }

  async _loadTemplates() {
    this._loading = true;
    this._loadError = null;
    try {
      const r = await fetch('/api/templates');
      if (!r.ok) throw await errorFromResponse(r);
      const body = await r.json();
      this._templates = body.templates || [];
    } catch (e) {
      this._loadError = e.message || 'Could not load templates.';
    } finally {
      this._loading = false;
    }
  }

  _selected() {
    return this._templates.find(t => t.id === this._selectedId) || null;
  }

  _selectTemplate(id) {
    this._selectedId = id;
    this._submitError = null;
    this._advancedOpen = false;
    const t = this._templates.find(x => x.id === id);
    if (!t) { this._values = {}; return; }
    // Seed values with sensible defaults derived from the template id itself.
    const defaults = this._defaultValues(t);
    this._values = defaults;
  }

  _defaultValues(template) {
    const raw = JSON.stringify(template.manifest);
    let placeholders = [];
    try { placeholders = extractPlaceholders(raw); } catch { return {}; }
    const out = {};
    for (const p of placeholders) {
      if (p.name === 'id') {
        // Suggest the template id as the default card id. User can override.
        out[p.name] = template.id;
      } else if (p.name === 'label') {
        out[p.name] = template.title;
      } else if (p.name === 'unit') {
        // Leave unit empty so the user picks.
        out[p.name] = '';
      } else if (p.type === 'date') {
        out[p.name] = new Date().toISOString().slice(0, 10);
      } else if (p.type === 'number') {
        out[p.name] = '';
      } else if (p.type === 'boolean') {
        out[p.name] = false;
      } else {
        out[p.name] = '';
      }
    }
    return out;
  }

  _updateValue(name, value) {
    this._values = { ...this._values, [name]: value };
  }

  _filteredTemplates() {
    const q = (this._filter || '').trim().toLowerCase();
    if (!q) return this._templates;
    return this._templates.filter(t => {
      const hay = `${t.title} ${t.summary} ${(t.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }

  _groupByCategory(templates) {
    const groups = new Map();
    for (const t of templates) {
      const cat = t.category || 'other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(t);
    }
    const ordered = [];
    for (const cat of CATEGORY_ORDER) {
      if (groups.has(cat)) ordered.push([cat, groups.get(cat)]);
    }
    for (const [cat, list] of groups) {
      if (!CATEGORY_ORDER.includes(cat)) ordered.push([cat, list]);
    }
    return ordered;
  }

  _buildPreviewManifest() {
    const t = this._selected();
    if (!t) return null;
    const raw = JSON.stringify(t.manifest);
    const { manifest, error } = parseSubstituted(raw, this._values);
    if (error) return null;
    return manifest;
  }

  async _submit() {
    const t = this._selected();
    if (!t) return;
    const raw = JSON.stringify(t.manifest);
    const { manifest, error } = parseSubstituted(raw, this._values);
    if (error) {
      this._submitError = `Invalid manifest after substitution: ${error}`;
      return;
    }

    // Basic validation: required fields (id, label) must be non-empty.
    if (!manifest.meta?.id || !String(manifest.meta.id).trim()) {
      this._submitError = 'Card id is required.';
      return;
    }
    if (!manifest.meta?.label || !String(manifest.meta.label).trim()) {
      this._submitError = 'Card label is required.';
      return;
    }

    this._busy = true;
    this._submitError = null;
    try {
      const created = await this._createWithCollisionRetry(manifest);
      this.dispatchEvent(new CustomEvent('eh-add-card-done', {
        detail: created,
        bubbles: true,
        composed: true,
      }));
      this._close();
    } catch (e) {
      this._submitError = e.message || 'Could not create card.';
    } finally {
      this._busy = false;
    }
  }

  async _createWithCollisionRetry(manifest, attempt = 1) {
    const attemptManifest = attempt === 1
      ? manifest
      : { ...manifest, meta: { ...manifest.meta, id: `${manifest.meta.id}-${attempt}` } };
    const r = await fetch('/api/manifests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attemptManifest),
    });
    if (r.status === 201) {
      return await r.json();
    }
    if (r.status === 409 && attempt < 20) {
      return this._createWithCollisionRetry(manifest, attempt + 1);
    }
    throw await errorFromResponse(r);
  }

  _cancel() {
    this.dispatchEvent(new CustomEvent('eh-add-card-cancel', {
      bubbles: true, composed: true,
    }));
    this._close();
  }

  _close() {
    const dlg = this.renderRoot?.querySelector('dialog');
    if (dlg && dlg.open) dlg.close();
  }

  _handleDialogClose() {
    // Clean up: detach ourselves from the DOM so a fresh instance gets
    // a fresh template list next time.
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  _renderGallery() {
    if (this._loading) return html`<div class="empty">Loading templates…</div>`;
    if (this._loadError) return html`<div class="empty error">⚠︎ ${this._loadError}</div>`;
    const filtered = this._filteredTemplates();
    if (!filtered.length) return html`<div class="empty">No templates match.</div>`;
    const groups = this._groupByCategory(filtered);
    return html`
      ${groups.map(([cat, list]) => html`
        <div class="gallery-group">
          <div class="gallery-group-title">${CATEGORY_LABELS[cat] || cat}</div>
          ${list.map(t => html`
            <button
              type="button"
              class="gallery-item ${this._selectedId === t.id ? 'selected' : ''}"
              @click=${() => this._selectTemplate(t.id)}
            >
              <div class="gi-emoji">${t.manifest?.meta?.emoji || '📄'}</div>
              <div class="gi-body">
                <div class="gi-title">${t.title}</div>
                <div class="gi-summary">${t.summary}</div>
              </div>
            </button>
          `)}
        </div>
      `)}
    `;
  }

  _renderPreview() {
    const t = this._selected();
    if (!t) return html`<div class="preview-empty">Select a template on the left to preview.</div>`;
    const manifest = this._buildPreviewManifest();
    if (!manifest) return html`<div class="preview-empty">Preview not available.</div>`;
    const component = manifest.meta?.view?.component;
    const tag = resolveRenderer(component);
    if (!tag) return html`<div class="preview-empty">Unknown renderer: ${component}</div>`;

    // Build a card prop the renderer expects.
    const card = {
      id: manifest.meta.id,
      meta: manifest.meta,
      viewConfig: manifest.meta.view || {},
    };
    return html`
      <div class="preview-wrap">
        ${this._instantiateRenderer(tag, card, manifest.data)}
      </div>
    `;
  }

  _instantiateRenderer(tag, card, data) {
    // Render dynamically. The renderer fetches its own data via
    // /api/manifests/:id/data normally; in preview mode there is no such
    // manifest on disk, so we stub the data by overriding the prop after
    // the element mounts. Simpler: create the element imperatively.
    const el = document.createElement(tag);
    el.card = card;
    el.data = data ?? [];
    el.date = new Date().toISOString().slice(0, 10);
    el.dateMode = 'today';
    el.loading = false;
    // Prevent the real data fetch from blowing away our stub: override the
    // method on the instance.
    if (typeof el._fetchData === 'function') {
      el._fetchData = async () => { el.loading = false; };
    }
    return el;
  }

  _renderForm() {
    const t = this._selected();
    if (!t) return html``;
    const raw = JSON.stringify(t.manifest);
    let placeholders = [];
    try { placeholders = extractPlaceholders(raw); } catch { return html``; }
    // "id" and "label" are always visible up top; everything else below.
    const primary = placeholders.filter(p => p.name === 'id' || p.name === 'label');
    const rest = placeholders.filter(p => p.name !== 'id' && p.name !== 'label');
    return html`
      <form class="form" @submit=${e => { e.preventDefault(); this._submit(); }}>
        ${primary.map(p => this._renderField(p))}
        ${rest.map(p => this._renderField(p))}
        ${this._submitError ? html`<div class="form-error">${this._submitError}</div>` : ''}
        <div class="form-actions">
          <button type="button" class="btn-secondary" @click=${this._cancel} ?disabled=${this._busy}>Cancel</button>
          <button type="submit" class="btn-primary" ?disabled=${this._busy}>
            ${this._busy ? 'Creating…' : 'Add card'}
          </button>
        </div>
      </form>
    `;
  }

  _renderField(p) {
    const value = this._values[p.name] ?? '';
    const label = this._fieldLabel(p);
    const inputId = `f-${p.name}`;
    let input;
    switch (p.type) {
      case 'number':
        input = html`<input id=${inputId} type="number" .value=${String(value)}
          @input=${e => this._updateValue(p.name, e.target.value)} />`;
        break;
      case 'boolean':
        input = html`<input id=${inputId} type="checkbox" ?checked=${!!value}
          @change=${e => this._updateValue(p.name, e.target.checked)} />`;
        break;
      case 'date':
        input = html`<input id=${inputId} type="date" .value=${String(value)}
          @input=${e => this._updateValue(p.name, e.target.value)} />`;
        break;
      case 'enum':
      case 'string':
      default:
        input = html`<input id=${inputId} type="text" .value=${String(value)}
          @input=${e => this._updateValue(p.name, e.target.value)} />`;
    }
    return html`
      <div class="field ${p.type === 'boolean' ? 'field-inline' : ''}">
        <label for=${inputId}>${label}</label>
        ${input}
      </div>
    `;
  }

  _fieldLabel(p) {
    const pretty = p.name.replace(/_/g, ' ').replace(/\b./, c => c.toUpperCase());
    return pretty;
  }

  render() {
    return html`
      <dialog @close=${this._handleDialogClose}>
        <div class="shell">
          <header>
            <h2>Add a card</h2>
            <button type="button" class="close" @click=${this._cancel} aria-label="Close">✕</button>
          </header>
          <div class="body">
            <aside class="gallery">
              <input
                class="search"
                type="search"
                placeholder="Search templates…"
                .value=${this._filter}
                @input=${e => this._filter = e.target.value}
              />
              <div class="gallery-list">${this._renderGallery()}</div>
            </aside>
            <section class="main">
              <div class="preview">${this._renderPreview()}</div>
              <div class="form-wrap">${this._renderForm()}</div>
            </section>
          </div>
        </div>
      </dialog>
    `;
  }

  static styles = css`
    dialog {
      border: none;
      padding: 0;
      border-radius: 12px;
      background: var(--bg-card, #fff);
      color: var(--text-primary, #111);
      width: min(1000px, 95vw);
      max-height: 90vh;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    }
    .shell { display: flex; flex-direction: column; max-height: 90vh; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
    }
    header h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .close {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 18px;
      color: var(--text-secondary);
      padding: 4px 10px;
    }
    .close:hover { color: var(--text-primary); }
    .body {
      display: grid;
      grid-template-columns: 280px 1fr;
      min-height: 400px;
      overflow: hidden;
    }
    .gallery {
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .search {
      margin: 12px 12px 8px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input, transparent);
      color: inherit;
      font-size: 13px;
    }
    .gallery-list { overflow: auto; padding: 0 12px 12px; }
    .gallery-group { margin-top: 8px; }
    .gallery-group-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-muted, var(--text-secondary));
      letter-spacing: 0.5px;
      padding: 6px 4px;
    }
    .gallery-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      text-align: left;
      cursor: pointer;
      color: inherit;
    }
    .gallery-item:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.05)); }
    .gallery-item.selected {
      background: var(--bg-selected, rgba(0, 212, 170, 0.1));
      border-color: var(--accent, #00d4aa);
    }
    .gi-emoji { font-size: 20px; line-height: 1.2; }
    .gi-body { flex: 1; min-width: 0; }
    .gi-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
    .gi-summary {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .empty { padding: 20px; color: var(--text-secondary); font-size: 13px; }
    .empty.error { color: var(--accent-red, #ff4444); }
    .main {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .preview {
      padding: 20px;
      background: var(--bg-app, var(--bg-page, #f5f5f5));
      border-bottom: 1px solid var(--border);
      min-height: 180px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .preview-wrap { width: 100%; max-width: 420px; }
    .preview-empty {
      color: var(--text-secondary);
      font-size: 13px;
    }
    .form-wrap { overflow: auto; padding: 16px 20px; }
    .form { display: grid; gap: 10px; }
    .field { display: grid; gap: 4px; }
    .field-inline { grid-template-columns: auto 1fr; align-items: center; gap: 10px; }
    .field label {
      font-size: 12px;
      color: var(--text-secondary);
      font-weight: 600;
    }
    .field input {
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input, transparent);
      color: inherit;
      font-size: 14px;
    }
    .field input:focus {
      outline: none;
      border-color: var(--accent, #00d4aa);
    }
    .form-error {
      padding: 8px 10px;
      font-size: 13px;
      color: var(--accent-red, #ff4444);
      background: rgba(255, 68, 68, 0.08);
      border-radius: 6px;
    }
    .form-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 8px;
    }
    .btn-primary, .btn-secondary {
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
    }
    .btn-primary {
      background: var(--accent, #00d4aa);
      color: #000;
      border-color: var(--accent, #00d4aa);
    }
    .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
    .btn-primary:disabled { opacity: 0.5; cursor: wait; }
    .btn-secondary {
      background: transparent;
      color: inherit;
    }
    .btn-secondary:hover:not(:disabled) { background: var(--bg-hover, rgba(0,0,0,0.05)); }
  `;
}
customElements.define('eh-add-card-modal', EhAddCardModal);
