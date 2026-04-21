// public/js/components/eh-settings-view.js
// Settings view (v2, post-Phase-0).
//
// Shows every card discovered in $HEALTH_HOME/data/ with a master enable/disable
// toggle. Toggling flips meta.enabled inside the file — no moving files, no
// archive dir. To remove a card entirely, delete the file (via chat/shell).
// To add a card, drop a valid manifest file into $HEALTH_HOME/data/ — see CARDS.md.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhSettingsView extends LitElement {
  static properties = {
    _cards: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _busyId: { state: true },
  };

  constructor() {
    super();
    this._cards = [];
    this._loading = true;
    this._error = null;
    this._busyId = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  async _load() {
    this._loading = true;
    this._error = null;
    try {
      const r = await fetch('/api/settings/cards');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { cards } = await r.json();
      this._cards = Array.isArray(cards) ? cards : [];
    } catch (e) {
      this._error = e.message;
    } finally {
      this._loading = false;
    }
  }

  async _toggle(card) {
    this._busyId = card.id;
    this._error = null;
    try {
      const action = card.enabled ? 'disable' : 'enable';
      const r = await fetch(`/api/settings/cards/${encodeURIComponent(card.id)}/${action}`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._load();
    } catch (e) {
      this._error = e.message;
    } finally {
      this._busyId = null;
    }
  }

  static styles = css`
    :host { display: block; max-width: 640px; margin: 0 auto; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 20px 0 6px;
    }
    .lede {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .lede a {
      color: var(--accent);
      text-decoration: underline;
    }
    .card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      background: var(--bg-card);
    }
    .card.disabled { opacity: 0.55; }
    .card-main { flex: 1; min-width: 0; }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .card-sub {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .id {
      font-family: ui-monospace, monospace;
      font-size: 10px;
      color: var(--text-muted, var(--text-secondary));
      opacity: 0.6;
      margin-left: 6px;
    }
    .toggle {
      appearance: none;
      width: 44px;
      height: 24px;
      border-radius: 12px;
      background: var(--border);
      position: relative;
      cursor: pointer;
      border: none;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    .toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--bg-card);
      transition: transform 0.15s;
    }
    .toggle[aria-pressed="true"] {
      background: var(--accent);
    }
    .toggle[aria-pressed="true"]::after {
      transform: translateX(20px);
    }
    .toggle[disabled] { opacity: 0.5; cursor: wait; }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--text-secondary);
      font-size: 13px;
      border: 1px dashed var(--border);
      border-radius: 10px;
    }
    .empty code {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      background: var(--bg-muted, rgba(255,255,255,0.04));
      padding: 1px 6px;
      border-radius: 4px;
    }
    .error { color: #ff4466; font-size: 12px; padding: 8px 0; }
    .docs-link {
      display: inline-block;
      margin-top: 18px;
      font-size: 12px;
      color: var(--text-secondary);
    }
  `;

  render() {
    if (this._loading) return html`<div class="lede">Loading…</div>`;

    return html`
      <h2>Cards</h2>
      <div class="lede">
        Every card is a file in <code>$HEALTH_HOME/data/</code>. Toggle off to
        hide a card (keeps the data); delete the file to remove it entirely.
        <a href="https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md" target="_blank" rel="noopener">How to add a card →</a>
      </div>

      ${this._cards.length === 0 ? html`
        <div class="empty">
          No cards yet. Drop a manifest file into <code>$HEALTH_HOME/data/</code>
          or ask the chat agent to create one.
        </div>
      ` : this._cards.map(c => html`
        <div class="card ${c.enabled ? '' : 'disabled'}">
          <div class="card-main">
            <div class="card-title">
              ${c.emoji || ''} ${c.label || c.id}
              <span class="id">${c.id}</span>
            </div>
            ${c.description ? html`<div class="card-sub">${c.description}</div>` : ''}
          </div>
          <button
            class="toggle"
            aria-pressed="${c.enabled}"
            aria-label="${c.enabled ? 'Disable' : 'Enable'} ${c.label || c.id}"
            ?disabled=${this._busyId === c.id}
            @click=${() => this._toggle(c)}
          ></button>
        </div>
      `)}

      ${this._error ? html`<div class="error">${this._error}</div>` : ''}
    `;
  }
}
customElements.define('eh-settings-view', EhSettingsView);
