// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-table-list.js — generic table renderer. Reports view uses this for SNPs.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';

export class EhTableList extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .summary { font-size: 12px; color: var(--text-secondary); padding: 4px 0 10px; }
      .kv-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 16px;
        font-size: 12px;
      }
      .kv-key { color: var(--text-muted, var(--text-secondary)); }
      .kv-val { color: var(--text-primary); font-variant-numeric: tabular-nums; }
      .cat-header {
        grid-column: 1 / -1;
        font-size: 11px;
        font-weight: 700;
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: 10px;
      }
    `,
  ];

  renderCard() {
    const d = this.data;
    if (!d) return html`<div>No data.</div>`;
    // SNP-like shape: { apoe, total_snps, found_count, categories: [...] }
    if (d.categories && typeof d === 'object') {
      return html`
        <div class="summary">
          APOE: <strong>${d.apoe || '?'}</strong> · ${d.found_count ?? '?'} / ${d.searched_count ?? '?'} SNPs found
        </div>
        <div class="kv-grid">
          ${Array.isArray(d.categories) ? d.categories.slice(0, 8).map(cat => html`
            <div class="cat-header">${cat.name || cat.category || '—'}</div>
            ${Array.isArray(cat.findings) ? cat.findings.slice(0, 6).map(f => html`
              <span class="kv-key">${f.gene || f.rsid || '?'}</span>
              <span class="kv-val">${f.genotype || f.value || '—'}</span>
            `) : ''}
          `) : ''}
        </div>
      `;
    }
    // Array of objects
    if (Array.isArray(d) && d.length > 0) {
      const sample = d[0];
      return html`
        <div class="summary">${d.length} entries</div>
        <div class="kv-grid">
          ${Object.entries(sample).slice(0, 8).map(([k, v]) => html`
            <span class="kv-key">${k}</span><span class="kv-val">${String(v).slice(0, 40)}</span>
          `)}
        </div>
      `;
    }
    // Plain object
    return html`
      <div class="kv-grid">
        ${Object.entries(d).slice(0, 12).map(([k, v]) => {
          const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 50) : String(v);
          return html`<span class="kv-key">${k}</span><span class="kv-val">${val}</span>`;
        })}
      </div>
    `;
  }
}
customElements.define('eh-table-list', EhTableList);
registerRenderer('table-list', 'eh-table-list');
