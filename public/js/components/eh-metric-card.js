// eh-metric-card.js — single big number + optional secondary + subtitle
// Config (meta.view.display):
//   primary:   "latest.field" | "count" | "sum.field" | "literal:X"
//   secondary: same pattern (optional)
//   format:    "{systolic}/{diastolic}"  — optional; when set, substitutes fields
//   unit:      "mmHg" etc.
//   subtitle:  "Last reading: {date}"    — optional; supports {field} tokens
//   thresholds: [{ max, colour, label }] — applied to primary value

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';

export class EhMetricCard extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .primary {
        font-size: 2rem;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.1;
      }
      .secondary {
        font-size: 1rem;
        color: var(--text-secondary);
        margin-left: 6px;
      }
      .unit {
        font-size: 0.9rem;
        color: var(--text-muted, var(--text-secondary));
        margin-left: 3px;
      }
      .subtitle {
        font-size: 11px;
        color: var(--text-muted, var(--text-secondary));
        margin-top: 4px;
      }
      .threshold-chip {
        display: inline-block;
        margin-left: 8px;
        padding: 1px 7px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 600;
      }
    `,
  ];

  renderCard() {
    const cfg = this._config;
    const disp = cfg.display || {};

    const primary = this._resolve(disp.primary);
    const secondary = disp.secondary ? this._resolve(disp.secondary) : null;
    const unit = disp.unit || '';

    // format: template string with {field} tokens from the source record
    let primaryStr = primary;
    if (disp.format && this._latestRecord()) {
      primaryStr = disp.format.replace(/\{(\w+)\}/g, (_, k) => {
        const v = this._latestRecord()[k];
        return v === undefined || v === null ? '—' : v;
      });
    }

    // threshold lookup
    const thresh = this._findThreshold(Number(primary), disp.thresholds || []);

    const subtitle = disp.subtitle ? this._interpolate(disp.subtitle) : null;

    return html`
      <div>
        <span class="primary">${primaryStr ?? '—'}</span>
        ${unit ? html`<span class="unit">${unit}</span>` : ''}
        ${secondary !== null ? html`<span class="secondary">${secondary}</span>` : ''}
        ${thresh ? html`<span class="threshold-chip" style="background:${thresh.colour}22;color:${thresh.colour}">${thresh.label}</span>` : ''}
      </div>
      ${subtitle ? html`<div class="subtitle">${subtitle}</div>` : ''}
    `;
  }

  _latestRecord() {
    const d = this.data;
    if (!Array.isArray(d) || d.length === 0) return null;
    // If entries have a date field, return the max by date
    if (d[0]?.date) {
      return d.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    }
    return d[d.length - 1];
  }

  _resolve(spec) {
    if (!spec) return null;
    if (typeof spec !== 'string') return spec;
    if (spec.startsWith('literal:')) return spec.slice(8);
    if (spec === 'count') return Array.isArray(this.data) ? this.data.length : 0;
    if (spec.startsWith('latest.')) {
      const field = spec.slice(7);
      const r = this._latestRecord();
      return r ? r[field] : null;
    }
    if (spec.startsWith('sum.')) {
      const field = spec.slice(4);
      if (!Array.isArray(this.data)) return null;
      return this.data.reduce((s, e) => s + (Number(e[field]) || 0), 0);
    }
    return null;
  }

  _interpolate(str) {
    const r = this._latestRecord() || {};
    return String(str).replace(/\{(\w+)\}/g, (_, k) => r[k] ?? '');
  }

  _findThreshold(val, list) {
    if (!Array.isArray(list) || list.length === 0 || !Number.isFinite(val)) return null;
    for (const t of list) {
      if (t.max === undefined || val <= t.max) return t;
    }
    return list[list.length - 1];
  }
}
customElements.define('eh-metric-card', EhMetricCard);
registerRenderer('metric-card', 'eh-metric-card');
// metric-card-with-input is a superset; register an alias for now (input form lands in M3b).
registerRenderer('metric-card-with-input', 'eh-metric-card');
registerRenderer('metric-card-with-sparkline', 'eh-metric-card');
