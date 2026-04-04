import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api } from '../api.js';

class ReportsView extends LitElement {
  static properties = {
    _reports: { state: true },
    _loading: { state: true },
  };

  static styles = css`
    :host { display: block; }

    h2 {
      font-size: 1.4rem;
      font-weight: 700;
      color: #1e293b;
      margin: 0 0 20px 0;
    }

    .reports-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .report-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px 20px;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: block;
    }

    .report-card:hover {
      background: #1e1e38;
      border-color: #0ea5e9;
    }

    .report-title {
      font-size: 15px;
      font-weight: 600;
      color: #1e293b;
      margin-bottom: 4px;
    }

    .report-meta {
      font-size: 12px;
      color: #64748b;
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .report-date {
      color: #0ea5e9;
    }

    .report-type {
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }

    .empty-text {
      color: #94a3b8;
      font-size: 14px;
    }

    .loading-text {
      color: #64748b;
      font-size: 14px;
    }
  `;

  constructor() {
    super();
    this._reports = [];
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchReports();
  }

  async _fetchReports() {
    this._loading = true;
    try {
      const reports = await api.reports();
      this._reports = Array.isArray(reports) ? reports : [];
    } catch {
      this._reports = [];
    }
    this._loading = false;
  }

  _getTypeFromName(name) {
    if (name.includes('bloods') || name.includes('blood')) return 'Bloods';
    if (name.includes('DEBRIEF') || name.includes('debrief')) return 'Debrief';
    if (name.includes('PROFILE') || name.includes('profile')) return 'Profile';
    return 'Report';
  }

  _formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  render() {
    if (this._loading) {
      return html`
        <h2>📋 Reports</h2>
        <div class="loading-text">Loading...</div>
      `;
    }

    if (this._reports.length === 0) {
      return html`
        <h2>📋 Reports</h2>
        <div class="empty-text">No reports available</div>
      `;
    }

    return html`
      <h2>📋 Reports</h2>
      <div class="reports-grid">
        ${this._reports.map(r => html`
          <a class="report-card" href="${r.url}" target="_blank">
            <div class="report-title">${r.title}</div>
            <div class="report-meta">
              <span class="report-type">${this._getTypeFromName(r.name)}</span>
              ${r.date ? html`<span class="report-date">${this._formatDate(r.date)}</span>` : ''}
            </div>
          </a>
        `)}
      </div>
    `;
  }
}

customElements.define('reports-view', ReportsView);
