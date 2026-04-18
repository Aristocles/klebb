import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api } from '../api.js';

/**
 * 💉 Pepi Report
 * Full dump of peptides.json — active + completed cycles, compliance, inventory.
 * Appears at the top of Reports view.
 */
class PepiReport extends LitElement {
  static properties = {
    _pepisData: { state: true },
    _injectionLog: { state: true },
    _expanded: { state: true },
    _loading: { state: true },
  };

  static styles = css`
    :host { display: block; margin-bottom: 24px; }

    .pepi-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      box-shadow: var(--shadow-md);
    }

    .pepi-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      cursor: pointer;
      user-select: none;
    }

    .pepi-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .pepi-toggle {
      color: var(--accent);
      font-size: 14px;
      transition: transform 0.2s;
    }

    .pepi-toggle.expanded { transform: rotate(180deg); }

    .summary-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }

    .stat {
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      text-align: center;
    }

    .stat-value {
      font-size: 22px;
      font-weight: 700;
      color: var(--accent);
      line-height: 1;
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 6px;
    }

    .pepi-section {
      margin-top: 20px;
    }

    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--accent);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }

    .pepi-item {
      background: var(--bg-nav);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 10px;
    }

    .pepi-item.completed {
      opacity: 0.75;
      border-left: 3px solid var(--text-muted);
    }

    .pepi-item.active {
      border-left: 3px solid var(--success);
    }

    .pepi-item.scheduled {
      border-left: 3px solid var(--warning);
    }

    .pepi-item.abandoned {
      opacity: 0.6;
      border-left: 3px solid var(--danger);
    }

    .pepi-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      flex-wrap: wrap;
      gap: 8px;
    }

    .pepi-name {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .pepi-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge-active { background: var(--success); color: var(--text-inverse, #fff); }
    .badge-completed { background: var(--text-muted); color: var(--text-inverse, #fff); }
    .badge-scheduled { background: var(--warning); color: var(--text-inverse, #fff); }
    .badge-abandoned { background: var(--danger); color: var(--text-inverse, #fff); }

    .pepi-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px 16px;
      font-size: 12px;
      color: var(--text-secondary);
      margin: 10px 0;
    }

    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .meta-label {
      color: var(--text-muted);
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
    }

    .meta-value {
      font-weight: 600;
      color: var(--text-primary);
    }

    .compliance-bar {
      margin-top: 10px;
      background: var(--bg-input);
      border-radius: 6px;
      height: 6px;
      overflow: hidden;
    }

    .compliance-fill {
      height: 100%;
      transition: width 0.5s ease;
      border-radius: 6px;
    }

    .compliance-excellent { background: linear-gradient(to right, var(--success), var(--success)); }
    .compliance-good { background: linear-gradient(to right, var(--success), var(--warning)); }
    .compliance-okay { background: linear-gradient(to right, var(--warning), var(--warning)); }
    .compliance-poor { background: linear-gradient(to right, var(--danger), var(--danger)); }

    .compliance-label {
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 6px;
      display: flex;
      justify-content: space-between;
    }

    .pepi-notes {
      font-size: 12px;
      color: var(--text-secondary);
      font-style: italic;
      margin-top: 8px;
      line-height: 1.5;
      border-top: 1px dashed var(--border);
      padding-top: 8px;
    }

    .cycle-timeline {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 11px;
      color: var(--text-secondary);
      flex-wrap: wrap;
    }

    .cycle-num {
      background: var(--accent-bg, var(--bg-input));
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 11px;
    }

    .empty-state {
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
      padding: 20px;
    }
  `;

  constructor() {
    super();
    this._pepisData = null;
    this._injectionLog = {};
    this._expanded = true;
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  async _fetchData() {
    this._loading = true;
    try {
      const [pepis, log] = await Promise.all([
        api.peptides(),
        api.injectionLogAll().catch(() => ({})),
      ]);
      this._pepisData = pepis;
      this._injectionLog = log || {};
    } catch (e) {
      console.error('[PepiReport] fetch failed', e);
    }
    this._loading = false;
  }

  _toggle() {
    this._expanded = !this._expanded;
  }

  _dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  _expectedDosesForCycle(pep, cycle) {
    // Count scheduled dose days between start_date and min(end_date, today)
    if (!cycle.start_date) return 0;
    const start = new Date(cycle.start_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cycleEnd = new Date(cycle.end_date + 'T00:00:00');
    const end = cycleEnd < today ? cycleEnd : today;
    if (end < start) return 0;

    const sched = pep.schedule;
    if (!sched) return 0;

    let count = 0;
    const d = new Date(start);
    while (d <= end) {
      const dayName = this._dayNames[d.getDay()];
      const dateStr = d.toISOString().slice(0, 10);
      let isDoseDay = false;

      if (sched.type === 'daily_straight') {
        isDoseDay = true;
      } else if (sched.type === 'on_off') {
        isDoseDay = sched.on_days?.includes(dayName);
      } else if (sched.type === 'phased') {
        const loadEnd = cycle.phases?.loading_end;
        if (loadEnd && dateStr <= loadEnd) {
          isDoseDay = sched.loading?.days?.includes(dayName);
        } else {
          isDoseDay = sched.maintenance?.days?.includes(dayName);
        }
      }
      if (isDoseDay) count++;
      d.setDate(d.getDate() + 1);
    }
    return count;
  }

  _takenDosesForCycle(pep, cycle) {
    if (!cycle.start_date || !cycle.end_date) return 0;
    const pepKey = pep.name;
    const shortKey = pep.short_name;
    let count = 0;
    for (const [dateStr, entries] of Object.entries(this._injectionLog)) {
      if (dateStr < cycle.start_date || dateStr > cycle.end_date) continue;
      const a = entries[pepKey];
      const b = shortKey ? entries[shortKey] : null;
      const isTaken = (v) => v === true || (v && typeof v === 'object' && v.taken === true);
      if (isTaken(a) || isTaken(b)) count++;
    }
    return count;
  }

  _complianceClass(pct) {
    if (pct >= 90) return 'compliance-excellent';
    if (pct >= 75) return 'compliance-good';
    if (pct >= 50) return 'compliance-okay';
    return 'compliance-poor';
  }

  _formatDate(d) {
    if (!d) return '—';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', {
      day: 'numeric', month: 'short', year: '2-digit'
    });
  }

  _renderPepiCycle(pep, cycle) {
    const expected = this._expectedDosesForCycle(pep, cycle);
    const taken = this._takenDosesForCycle(pep, cycle);
    const pct = expected > 0 ? Math.min(100, Math.round((taken / expected) * 100)) : 0;
    const status = cycle.status || 'active';

    return html`
      <div class="pepi-item ${status}">
        <div class="pepi-item-header">
          <div class="pepi-name">
            ${pep.short_name || pep.name}
            <span class="cycle-num">Cycle ${cycle.cycle_number}</span>
          </div>
          <div class="pepi-badge badge-${status}">${status}</div>
        </div>

        <div class="pepi-meta">
          <div class="meta-item">
            <div class="meta-label">Cycle</div>
            <div class="meta-value">${this._formatDate(cycle.start_date)} → ${this._formatDate(cycle.end_date)}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Dose</div>
            <div class="meta-value">${pep.dose_mg ?? '—'}mg · ${pep.dose_units ?? '—'}u</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Schedule</div>
            <div class="meta-value">${this._scheduleLabel(pep.schedule)}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Route / Timing</div>
            <div class="meta-value">${pep.route ?? '—'} · ${pep.timing ?? '—'}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Vials (used / needed)</div>
            <div class="meta-value">${cycle.vials_used ?? 0} / ${cycle.vials_needed ?? '—'}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Recon</div>
            <div class="meta-value">${pep.reconstitution_ml ?? '—'}ml BAC · ${pep.concentration_mg_ml ?? '—'}mg/ml</div>
          </div>
        </div>

        ${expected > 0 ? html`
          <div class="compliance-bar">
            <div class="compliance-fill ${this._complianceClass(pct)}" style="width:${pct}%"></div>
          </div>
          <div class="compliance-label">
            <span>Compliance: ${taken} / ${expected} doses</span>
            <span>${pct}%</span>
          </div>
        ` : ''}

        ${cycle.notes ? html`<div class="pepi-notes">📝 ${cycle.notes}</div>` : ''}
        ${!cycle.notes && pep.notes ? html`<div class="pepi-notes">💡 ${pep.notes}</div>` : ''}
      </div>
    `;
  }

  _scheduleLabel(s) {
    if (!s) return '—';
    if (s.type === 'daily_straight') return `daily × ${s.duration_days}d`;
    if (s.type === 'on_off') return s.on_days?.join('/') || 'on/off';
    if (s.type === 'phased') {
      const load = s.loading?.days?.join('/') || '';
      const maint = s.maintenance?.days?.join('/') || '';
      return `${load} → ${maint}`;
    }
    return s.type;
  }

  _summaryStats() {
    if (!this._pepisData?.peptides) return { active: 0, completed: 0, totalDoses: 0, avgCompliance: 0 };

    let active = 0, completed = 0, totalDoses = 0;
    let compSum = 0, compCount = 0;

    for (const pep of this._pepisData.peptides) {
      if (!pep.cycles) continue;
      for (const c of pep.cycles) {
        if (c.status === 'active' || c.status === 'scheduled') active++;
        if (c.status === 'completed') completed++;

        const taken = this._takenDosesForCycle(pep, c);
        totalDoses += taken;

        const expected = this._expectedDosesForCycle(pep, c);
        if (expected > 0) {
          compSum += (taken / expected) * 100;
          compCount++;
        }
      }
    }
    return {
      active,
      completed,
      totalDoses,
      avgCompliance: compCount > 0 ? Math.round(compSum / compCount) : 0,
    };
  }

  render() {
    if (this._loading) {
      return html`<div class="pepi-card"><div class="empty-state">Loading pepi data...</div></div>`;
    }
    if (!this._pepisData?.peptides || this._pepisData.peptides.length === 0) {
      return html`<div class="pepi-card"><div class="empty-state">No pepi data available</div></div>`;
    }

    const stats = this._summaryStats();
    const allCycles = [];
    for (const pep of this._pepisData.peptides) {
      if (!pep.cycles) continue;
      for (const c of pep.cycles) {
        allCycles.push({ pep, cycle: c });
      }
    }

    // Sort: active first, then scheduled, then completed (most recent first), then abandoned
    // Within each status group, newest cycle (by start_date) first
    const statusOrder = { active: 0, scheduled: 1, completed: 2, abandoned: 3 };
    allCycles.sort((a, b) => {
      const aOrd = statusOrder[a.cycle.status] ?? 99;
      const bOrd = statusOrder[b.cycle.status] ?? 99;
      if (aOrd !== bOrd) return aOrd - bOrd;
      // Newest first (descending start_date)
      return (b.cycle.start_date || '').localeCompare(a.cycle.start_date || '');
    });

    const activeOrScheduled = allCycles.filter(x => x.cycle.status === 'active' || x.cycle.status === 'scheduled');
    const completedOrAbandoned = allCycles.filter(x => x.cycle.status === 'completed' || x.cycle.status === 'abandoned');

    return html`
      <div class="pepi-card">
        <div class="pepi-header" @click=${this._toggle}>
          <div class="pepi-title">💉 Peptide Cycles</div>
          <div class="pepi-toggle ${this._expanded ? 'expanded' : ''}">▼</div>
        </div>

        <div class="summary-row">
          <div class="stat">
            <div class="stat-value">${stats.active}</div>
            <div class="stat-label">Active</div>
          </div>
          <div class="stat">
            <div class="stat-value">${stats.completed}</div>
            <div class="stat-label">Completed</div>
          </div>
          <div class="stat">
            <div class="stat-value">${stats.totalDoses}</div>
            <div class="stat-label">Total Doses</div>
          </div>
          <div class="stat">
            <div class="stat-value">${stats.avgCompliance}%</div>
            <div class="stat-label">Avg Compliance</div>
          </div>
        </div>

        ${this._expanded ? html`
          ${activeOrScheduled.length > 0 ? html`
            <div class="pepi-section">
              <div class="section-title">🟢 Active & Upcoming</div>
              ${activeOrScheduled.map(({ pep, cycle }) => this._renderPepiCycle(pep, cycle))}
            </div>
          ` : ''}

          ${completedOrAbandoned.length > 0 ? html`
            <div class="pepi-section">
              <div class="section-title">📚 Past Cycles</div>
              ${completedOrAbandoned.map(({ pep, cycle }) => this._renderPepiCycle(pep, cycle))}
            </div>
          ` : ''}
        ` : ''}
      </div>
    `;
  }
}

customElements.define('pepi-report', PepiReport);
