// eh-adherence-report.js — placeholder v2 renderer showing compliance stats
// for any scheduled protocol. Full inventory math lands in M3b.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { isScheduledOnDate, enumerateDates } from '../lib/schedule.js';
import { registerRenderer } from '../renderer-registry.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function startOfActiveCycle(item) {
  if (!Array.isArray(item.cycles)) return null;
  const c = item.cycles.find(cc => cc.type !== 'off' && cc.start);
  return c ? (c.start || c.start_date) : null;
}

export class EhAdherenceReport extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .stat {
        background: var(--bg-input, rgba(0,0,0,0.04));
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px;
        text-align: center;
      }
      .stat-value {
        font-size: 20px;
        font-weight: 700;
        color: var(--accent);
      }
      .stat-label {
        font-size: 10px;
        color: var(--text-muted, var(--text-secondary));
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .items {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 10px;
      }
      .item {
        display: flex;
        gap: 8px;
        padding: 4px 0;
        font-size: 12px;
        border-bottom: 1px solid var(--border);
      }
      .item:last-child { border-bottom: none; }
      .name { flex: 1; color: var(--text-primary); }
      .pct { font-weight: 600; font-variant-numeric: tabular-nums; }
      .pct.good { color: #44ff88; }
      .pct.okay { color: #ffaa00; }
      .pct.poor { color: #ff4466; }
    `,
  ];

  _compliance(item) {
    const doses = Array.isArray(item.doses) ? item.doses : [];
    const taken = doses.filter(d => d.takenAt).length;
    // Estimate expected from schedule across active cycle up to today
    const start = startOfActiveCycle(item);
    if (!start) return { taken, expected: doses.length || null, pct: null };
    const today = todayStr();
    let expected = 0;
    try {
      const dates = enumerateDates(start, today);
      for (const d of dates) {
        if (isScheduledOnDate(item, d) === 'scheduled') expected++;
      }
    } catch { expected = null; }
    const pct = (expected && expected > 0) ? Math.round((taken / expected) * 100) : null;
    return { taken, expected, pct };
  }

  renderCard() {
    const d = this.data;
    const items = (d && Array.isArray(d.items)) ? d.items : [];
    if (items.length === 0) return html`<div>No items tracked.</div>`;

    const perItem = items.map(it => ({ name: it.name, ...this._compliance(it) }));
    const overall = {
      taken: perItem.reduce((s, x) => s + (x.taken || 0), 0),
      expected: perItem.reduce((s, x) => s + (x.expected || 0), 0),
    };
    const overallPct = overall.expected > 0 ? Math.round(overall.taken / overall.expected * 100) : null;

    return html`
      <div class="grid">
        <div class="stat">
          <div class="stat-value">${items.length}</div>
          <div class="stat-label">Items</div>
        </div>
        <div class="stat">
          <div class="stat-value">${overall.taken}</div>
          <div class="stat-label">Doses taken</div>
        </div>
        <div class="stat">
          <div class="stat-value">${overallPct !== null ? overallPct + '%' : '—'}</div>
          <div class="stat-label">Adherence</div>
        </div>
      </div>
      <div class="items">
        ${perItem.map(i => {
          const klass = i.pct === null ? '' : (i.pct >= 85 ? 'good' : i.pct >= 60 ? 'okay' : 'poor');
          return html`
            <div class="item">
              <span class="name">${i.name}</span>
              <span class="pct ${klass}">${i.pct !== null ? i.pct + '%' : '—'}</span>
              <span style="color: var(--text-muted, var(--text-secondary)); font-size: 11px;">${i.taken}/${i.expected ?? '?'}</span>
            </div>
          `;
        })}
      </div>
    `;
  }
}
customElements.define('eh-adherence-report', EhAdherenceReport);
registerRenderer('adherence-report', 'eh-adherence-report');
