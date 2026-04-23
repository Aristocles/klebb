// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-reports-view.js
// v2 Reports view — combines:
//   1. Manifest-driven cards with meta.reports.enabled: true (e.g. snps, peptides adherence)
//   2. Raw markdown reports discovered via /api/reports (bloods, debriefs, genome prose)

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './eh-view-renderer.js';

export class EhReportsView extends LitElement {
  static properties = {
    _markdownReports: { state: true },
    _loading: { state: true },
  };

  constructor() {
    super();
    this._markdownReports = [];
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchMarkdownReports();
  }

  async _fetchMarkdownReports() {
    this._loading = true;
    try {
      const r = await fetch('/api/reports');
      if (r.ok) {
        const list = await r.json();
        this._markdownReports = Array.isArray(list) ? list : [];
      }
    } catch {
      this._markdownReports = [];
    } finally {
      this._loading = false;
    }
  }

  _formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return dateStr; }
  }

  _typeFor(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('blood')) return 'Bloods';
    if (n.includes('debrief')) return 'Debrief';
    if (n.includes('genome') || n.includes('dna')) return 'Genome';
    if (n.includes('profile')) return 'Profile';
    return 'Report';
  }

  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 0 0 16px;
    }
    h3 {
      font-size: 0.85rem;
      color: var(--text-muted, var(--text-secondary));
      margin: 24px 0 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .md-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .md-item {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      text-decoration: none;
      color: inherit;
      transition: all 0.15s;
      display: block;
    }
    .md-item:hover {
      border-color: var(--accent);
      background: var(--bg-hover, rgba(0,0,0,0.02));
    }
    .md-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .md-meta {
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      margin-top: 3px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .md-type {
      background: var(--accent-bg, rgba(0,212,170,0.1));
      color: var(--accent);
      padding: 1px 7px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
    }
    .empty { color: var(--text-muted, var(--text-secondary)); font-size: 13px; padding: 12px; }
  `;

  render() {
    return html`
      <h2>📋 Reports</h2>
      <eh-view-renderer view="reports"></eh-view-renderer>

      <h3>Documents</h3>
      ${this._loading
        ? html`<div class="empty">Loading…</div>`
        : this._markdownReports.length === 0
          ? html`<div class="empty">No markdown reports available.</div>`
          : html`
              <div class="md-list">
                ${this._markdownReports.map(r => html`
                  <a class="md-item" href="${r.url}" target="_blank">
                    <div class="md-title">${r.title}</div>
                    <div class="md-meta">
                      <span class="md-type">${this._typeFor(r.name)}</span>
                      ${r.date ? html`<span>${this._formatDate(r.date)}</span>` : ''}
                    </div>
                  </a>
                `)}
              </div>
            `}
    `;
  }
}
customElements.define('eh-reports-view', EhReportsView);
