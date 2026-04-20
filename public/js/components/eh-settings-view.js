// public/js/components/eh-settings-view.js
// Settings view for v2.
//
// Shows a unified checklist of ALL known card types:
//   - Checkbox state reflects the live installed state (file exists in $HEALTH_HOME/data/).
//   - Check a box + Save → install the card if missing (copies from data.example/).
//   - Uncheck a box + Save → archive the card (moves to data/_archive/).
//   - Cards discovered in data/ that aren't in the catalog are shown at the bottom
//     (read-only; user can still archive them via a chip).
//
// Also shows archived cards with a one-click restore button.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhSettingsView extends LitElement {
  static properties = {
    _catalog: { state: true },       // [{ id, label, blurb }] from /api/setup
    _active: { state: true },        // Set<id> currently installed
    _archived: { state: true },      // [{ file }]
    _selected: { state: true },      // Set<id> user's desired state
    _extraActive: { state: true },   // cards in active but not in catalog
    _loading: { state: true },
    _saving: { state: true },
    _error: { state: true },
    _saved: { state: true },
  };

  constructor() {
    super();
    this._catalog = [];
    this._active = new Set();
    this._archived = [];
    this._selected = new Set();
    this._extraActive = [];
    this._loading = true;
    this._saving = false;
    this._error = null;
    this._saved = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  async _load() {
    this._loading = true;
    this._error = null;
    try {
      const [setupRes, cardsRes] = await Promise.all([
        fetch('/api/setup'),
        fetch('/api/settings/cards'),
      ]);
      if (!setupRes.ok) throw new Error(`/api/setup HTTP ${setupRes.status}`);
      if (!cardsRes.ok) throw new Error(`/api/settings/cards HTTP ${cardsRes.status}`);
      const setup = await setupRes.json();
      const cards = await cardsRes.json();

      this._catalog = setup.options || [];
      this._active = new Set((cards.active || []).map(c => c.id));
      this._archived = cards.archived || [];

      // Cards installed but not in the wizard catalog (manually added by Onyx,
      // migrated from legacy, etc). Show them separately so the user still has
      // a way to archive them.
      const catalogIds = new Set(this._catalog.map(c => c.id));
      this._extraActive = (cards.active || []).filter(c => !catalogIds.has(c.id));

      // Initial selection = currently installed
      this._selected = new Set(this._active);
    } catch (e) {
      this._error = e.message;
    } finally {
      this._loading = false;
    }
  }

  _toggle(id) {
    if (this._selected.has(id)) this._selected.delete(id);
    else this._selected.add(id);
    this._saved = false;
    this.requestUpdate();
  }

  _hasChanges() {
    if (this._selected.size !== this._active.size) return true;
    for (const id of this._selected) if (!this._active.has(id)) return true;
    return false;
  }

  _diff() {
    const toInstall = [];
    const toArchive = [];
    for (const id of this._selected) if (!this._active.has(id)) toInstall.push(id);
    for (const id of this._active) if (!this._selected.has(id)) toArchive.push(id);
    return { toInstall, toArchive };
  }

  async _save() {
    const { toInstall, toArchive } = this._diff();
    if (toInstall.length === 0 && toArchive.length === 0) return;
    this._saving = true;
    this._error = null;
    this._saved = false;
    try {
      if (toInstall.length > 0) {
        const r = await fetch('/api/setup/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: toInstall }),
        });
        if (!r.ok) throw new Error(`install HTTP ${r.status}`);
      }
      for (const id of toArchive) {
        const r = await fetch(`/api/settings/cards/${encodeURIComponent(id)}/archive`, { method: 'POST' });
        if (!r.ok) throw new Error(`archive ${id}: HTTP ${r.status}`);
      }
      this._saved = true;
      await this._load();
    } catch (e) {
      this._error = e.message;
    } finally {
      this._saving = false;
    }
  }

  async _archiveExtra(id) {
    if (!confirm(`Archive "${id}"?`)) return;
    try {
      const r = await fetch(`/api/settings/cards/${encodeURIComponent(id)}/archive`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._load();
    } catch (e) {
      this._error = e.message;
    }
  }

  async _restore(file) {
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
    :host { display: block; max-width: 560px; margin: 0 auto; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 20px 0 6px;
    }
    .lede {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 16px;
    }
    .option {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .option:hover { border-color: var(--accent); }
    .option.selected {
      border-color: var(--accent);
      background: var(--accent-bg, rgba(14,165,233,0.06));
    }
    .check {
      width: 18px;
      height: 18px;
      border: 2px solid var(--border);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
      color: var(--bg-card);
      font-size: 12px;
      font-weight: 700;
    }
    .option.selected .check {
      background: var(--accent);
      border-color: var(--accent);
    }
    .option.selected .check::before { content: '✓'; }
    .option-label {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .option-blurb {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 8px;
      margin-left: 6px;
      vertical-align: middle;
    }
    .badge.installed {
      background: var(--accent-bg, rgba(14,165,233,0.15));
      color: var(--accent);
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 18px;
    }
    button {
      background: var(--accent);
      color: var(--bg-card);
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    button.ghost {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border);
    }
    button.ghost:hover { border-color: var(--accent); color: var(--accent); }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    .saved-msg { color: var(--accent); font-size: 12px; }
    .error { color: #ff4466; font-size: 12px; padding: 8px 0; }
    .extra-row, .archived-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 6px;
    }
    .extra-label { font-size: 13px; color: var(--text-primary); }
    .archived-file { font-family: monospace; font-size: 11px; color: var(--text-muted, var(--text-secondary)); }
    .subtle {
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      margin-top: 4px;
    }
  `;

  render() {
    if (this._loading) return html`<div class="lede">Loading…</div>`;
    const hasChanges = this._hasChanges();
    const { toInstall, toArchive } = this._diff();

    return html`
      <h2>Cards</h2>
      <div class="lede">
        Tick the cards you want on your dashboard. Untick to archive; archived
        cards can be restored below without losing data.
      </div>

      ${this._catalog.map(opt => {
        const selected = this._selected.has(opt.id);
        const installed = this._active.has(opt.id);
        return html`
          <div
            class="option ${selected ? 'selected' : ''}"
            @click=${() => this._toggle(opt.id)}
          >
            <div class="check"></div>
            <div style="flex:1; min-width:0;">
              <div class="option-label">
                ${opt.label}
                ${installed ? html`<span class="badge installed">Installed</span>` : ''}
              </div>
              <div class="option-blurb">${opt.blurb}</div>
            </div>
          </div>
        `;
      })}

      <div class="actions">
        ${this._saved && !hasChanges ? html`<span class="saved-msg">✓ Saved</span>` : ''}
        <button
          class="ghost"
          @click=${() => { this._selected = new Set(this._active); this._saved = false; this.requestUpdate(); }}
          ?disabled=${!hasChanges || this._saving}
        >Reset</button>
        <button
          @click=${this._save}
          ?disabled=${!hasChanges || this._saving}
          title="${toInstall.length} to add, ${toArchive.length} to archive"
        >${this._saving
          ? 'Saving…'
          : hasChanges
            ? `Save (${toInstall.length} add, ${toArchive.length} archive)`
            : 'No changes'}</button>
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : ''}

      ${this._extraActive.length > 0 ? html`
        <h2>Other installed cards</h2>
        <div class="lede">Cards not in the standard catalog (added manually or by an AI integration).</div>
        ${this._extraActive.map(c => html`
          <div class="extra-row">
            <div class="extra-label">${c.emoji || ''} ${c.label || c.id}</div>
            <button class="ghost" @click=${() => this._archiveExtra(c.id)}>Archive</button>
          </div>
        `)}
      ` : ''}

      ${this._archived.length > 0 ? html`
        <h2>Archived</h2>
        ${this._archived.map(a => html`
          <div class="archived-row">
            <div class="archived-file">${a.file}</div>
            <button class="ghost" @click=${() => this._restore(a.file)}>Restore</button>
          </div>
        `)}
      ` : ''}
    `;
  }
}
customElements.define('eh-settings-view', EhSettingsView);
