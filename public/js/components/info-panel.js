import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api } from '../api.js';

class InfoPanel extends LitElement {
  static properties = {
    date: { type: String },
    _items: { state: true },
    _loading: { state: true },
    _open: { state: true },
  };

  static styles = css`
    :host { display: block; }

    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .panel {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 20px 24px;
      max-width: 520px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      position: relative;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #8888aa;
      margin: 0;
    }

    .close-btn {
      background: none;
      border: none;
      color: #8888aa;
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      line-height: 1;
      font-family: inherit;
    }

    .close-btn:hover {
      color: #e0e0e0;
    }

    .info-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .info-item {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }

    .info-icon {
      font-size: 22px;
      flex-shrink: 0;
      line-height: 1;
    }

    .info-body {
      flex: 1;
      min-width: 0;
    }

    .info-title {
      font-size: 15px;
      font-weight: 600;
      color: #e0e0e0;
      margin-bottom: 4px;
    }

    .info-title a {
      color: #00d4aa;
      text-decoration: none;
    }

    .info-title a:hover {
      text-decoration: underline;
    }

    .info-summary {
      font-size: 13px;
      color: #8888aa;
      line-height: 1.5;
    }

    .loading-text {
      color: #8888aa;
      font-size: 14px;
    }

    .empty-text {
      color: #666688;
      font-size: 13px;
    }
  `;

  constructor() {
    super();
    this.date = '';
    this._items = null;
    this._loading = false;
    this._open = false;
  }

  updated(changed) {
    if (changed.has('date') && this.date) {
      this._fetchData();
    }
  }

  open() {
    this._open = true;
    if (this.date) this._fetchData();
  }

  close() {
    this._open = false;
    this.dispatchEvent(new CustomEvent('panel-closed', { bubbles: true, composed: true }));
  }

  async _fetchData() {
    if (!this.date) return;
    this._loading = true;
    try {
      const data = await api.info(this.date);
      this._items = Array.isArray(data) ? data : null;
    } catch {
      this._items = null;
    }
    this._loading = false;
  }

  _handleOverlayClick(e) {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  render() {
    if (!this._open) return html``;

    return html`
      <div class="overlay" @click=${this._handleOverlayClick}>
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Info \u2014 ${this.date}</div>
            <button class="close-btn" @click=${() => this.close()}>\u2715</button>
          </div>
          ${this._loading ? html`
            <div class="loading-text">Loading...</div>
          ` : !this._items || this._items.length === 0 ? html`
            <div class="empty-text">No info for this date</div>
          ` : html`
            <div class="info-list">
              ${this._items.map(item => html`
                <div class="info-item">
                  ${item.icon ? html`<span class="info-icon">${item.icon}</span>` : ''}
                  <div class="info-body">
                    <div class="info-title">
                      ${item.url
                        ? html`<a href="${item.url}" target="_blank" rel="noopener">${item.title}</a>`
                        : item.title}
                    </div>
                    ${item.summary ? html`
                      <div class="info-summary">${item.summary}</div>
                    ` : ''}
                  </div>
                </div>
              `)}
            </div>
          `}
        </div>
      </div>
    `;
  }
}

customElements.define('info-panel', InfoPanel);
