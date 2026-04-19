// public/js/components/eh-settings-view.js
// Settings view for v2:
//   - list active cards (with archive button)
//   - list archived cards (with restore button)
//   - show discovered manifest errors (parse issues) for debugging
//   - button to run the setup wizard again (enables more cards)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './eh-setup-wizard.js';

export class EhSettingsView extends LitElement {
  static properties = {
    _cards: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _showWizard: { state: true },
  };

  constructor() {
    super();
    this._cards = { active: [], archived: [] };
    this._loading = true;
    this._error = null;
    this._showWizard = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  async _load() {
    this._loading = true;
    try {
      const r = await fetch('/api/settings/cards');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this._cards = await r.json();
    } catch (e) {
      this._error = e.message;
    } finally {
      this._loading = false;
    }
  }

  async _archive(id) {
    if (!confirm(`Archive "${id}"? It can be restored later.`)) return;
    try {
      const r = await fetch(`/api/settings/cards/${encodeURIComponent(id)}/archive`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._load();
    } catch (e) {
      this._error = e.message;
    }
  }

  async _restore(file) {
    // filename is "<id>.YYYY-MM-DD.json"
    const id = file.split('.')[0];
    try {
      const r = await fetch(`/api/settings/cards/${encodeURIComponent(id)}/restore?file=${encodeURIComponent(file)}`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._load();
    } catch (e) {
      this._error = e.message;
    }
  }

  static styles = css`
    :host { display: block; }
    h2 { font-size: 1.2rem; color: var(--text-primary); margin: 20px 0 10px; }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
    }
    .label { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-primary); }
    .filename { font-size: 11px; color: var(--text-muted, var(--text-secondary)); font-family: monospace; }
    button {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.primary {
      background: var(--accent);
      color: var(--bg-card);
      border-color: var(--accent);
    }
    .empty {
      padding: 16px;
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      text-align: center;
    }
    .error { color: var(--accent-red, #ff4444); font-size: 13px; padding: 10px 0; }
    .actions { display: flex; gap: 10px; margin-top: 16px; }
  `;

  render() {
    if (this._showWizard) return html`<eh-setup-wizard></eh-setup-wizard>`;
    if (this._loading) return html`<div class="empty">Loading…</div>`;
    return html`
      <h2>Active cards</h2>
      ${this._cards.active.length === 0
        ? html`<div class="empty">No active cards yet.</div>`
        : this._cards.active.map(c => html`
            <div class="row">
              <div class="label">${c.emoji || ''} ${c.label || c.id}</div>
              <button @click=${() => this._archive(c.id)}>Archive</button>
            </div>
          `)}

      <h2>Archived</h2>
      ${this._cards.archived.length === 0
        ? html`<div class="empty">No archived cards.</div>`
        : this._cards.archived.map(a => html`
            <div class="row">
              <div class="label">
                <span class="filename">${a.file}</span>
              </div>
              <button @click=${() => this._restore(a.file)}>Restore</button>
            </div>
          `)}

      <div class="actions">
        <button class="primary" @click=${() => this._showWizard = true}>
          + Add more cards
        </button>
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : ''}
    `;
  }
}
customElements.define('eh-settings-view', EhSettingsView);
