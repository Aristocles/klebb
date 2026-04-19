// public/js/components/eh-setup-wizard.js
// First-run setup wizard. Shown when /api/setup returns firstRun=true.
// Lets the user pick which cards to seed, POSTs to /api/setup/install,
// then reloads the app.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhSetupWizard extends LitElement {
  static properties = {
    _options: { state: true },
    _selected: { state: true },
    _loading: { state: true },
    _installing: { state: true },
    _error: { state: true },
    _done: { state: true },
  };

  constructor() {
    super();
    this._options = [];
    this._selected = new Set();
    this._loading = true;
    this._installing = false;
    this._error = null;
    this._done = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  async _load() {
    this._loading = true;
    try {
      const r = await fetch('/api/setup');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      this._options = body.options || [];
      this._selected = new Set(this._options.filter(o => o.defaultChecked).map(o => o.id));
    } catch (e) {
      this._error = e.message;
    } finally {
      this._loading = false;
    }
  }

  _toggle(id) {
    if (this._selected.has(id)) this._selected.delete(id);
    else this._selected.add(id);
    this.requestUpdate();
  }

  async _install() {
    this._installing = true;
    this._error = null;
    try {
      const r = await fetch('/api/setup/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...this._selected] }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.json();
      this._done = true;
      // Navigate to dashboard after a short pause
      setTimeout(() => {
        window.location.href = '/?v2=1';
      }, 900);
    } catch (e) {
      this._error = e.message;
    } finally {
      this._installing = false;
    }
  }

  static styles = css`
    :host { display: block; max-width: 560px; margin: 40px auto; padding: 24px; }
    h1 {
      font-size: 1.4rem;
      color: var(--text-primary);
      margin: 0 0 8px;
    }
    .lede {
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: 20px;
    }
    .option {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .option:hover { border-color: var(--accent); }
    .option.selected {
      border-color: var(--accent);
      background: var(--accent-bg, rgba(0,212,170,0.06));
    }
    .check {
      width: 18px; height: 18px;
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
    .option-body { flex: 1; }
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
    .actions {
      margin-top: 20px;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
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
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    .error { color: var(--accent-red, #ff4444); font-size: 13px; margin-top: 8px; }
    .done { text-align: center; padding: 40px 0; color: var(--accent); font-weight: 700; }
    .note { color: var(--text-muted, var(--text-secondary)); font-size: 12px; margin-top: 12px; }
  `;

  render() {
    if (this._loading) return html`<div class="lede">Loading…</div>`;
    if (this._done) return html`<div class="done">✓ Setup complete. Redirecting…</div>`;
    return html`
      <h1>Welcome — let's set up your dashboard</h1>
      <div class="lede">
        Pick the cards you'd like to start with. You can always add or
        remove more later from Settings.
      </div>
      ${this._options.map(o => html`
        <div
          class="option ${this._selected.has(o.id) ? 'selected' : ''}"
          @click=${() => this._toggle(o.id)}
        >
          <div class="check"></div>
          <div class="option-body">
            <div class="option-label">${o.label}</div>
            <div class="option-blurb">${o.blurb}</div>
          </div>
        </div>
      `)}
      <div class="actions">
        <button
          @click=${this._install}
          ?disabled=${this._installing || this._selected.size === 0}
        >
          ${this._installing ? 'Setting up…' : `Add ${this._selected.size} card${this._selected.size === 1 ? '' : 's'}`}
        </button>
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : ''}
      <div class="note">Tip: cards with no data stay hidden on the dashboard. You'll only see cards once you start logging to them.</div>
    `;
  }
}
customElements.define('eh-setup-wizard', EhSetupWizard);
