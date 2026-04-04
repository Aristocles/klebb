import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today } from '../api.js';

class GoalsCard extends LitElement {
  static properties = {
    currentWeight: { type: Number, attribute: 'current-weight' },
    _goals: { state: true },
    loading: { state: true },
  };

  static styles = css`
    :host { display: block; min-width: 0; }

    .card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 16px 20px;
    }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #8888aa;
      margin: 0 0 12px 0;
    }

    .goals-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .goal {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .goal-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
    }

    .goal-description {
      font-size: 13px;
      color: #eeeeff;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .goal-values {
      font-size: 12px;
      color: #8888aa;
    }

    .bar-track {
      height: 8px;
      background: #2a2a4a;
      border-radius: 4px;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.4s ease;
    }

    .bar-fill.active {
      background: #2dd4bf;
    }

    .bar-fill.muted {
      background: #3a3a5a;
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
    this.currentWeight = null;
    this._goals = null;
    this.loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  async _fetchData() {
    this.loading = true;
    try {
      this._goals = await api.goals();
    } catch {
      this._goals = null;
    }
    this.loading = false;
  }

  _computeWeightProgress(goal) {
    const start = goal.startValue;
    const target = goal.target;
    const current = this.currentWeight;

    if (current == null || start == null || target == null) return null;

    // Weight loss: start > target, progress as weight decreases
    const totalRange = Math.abs(start - target);
    if (totalRange === 0) return 100;

    const traveled = Math.abs(start - current);
    // Clamp between 0 and 100
    const pct = Math.min(100, Math.max(0, (traveled / totalRange) * 100));

    // If going the wrong direction, progress is 0
    if (start > target && current > start) return 0;
    if (start < target && current < start) return 0;

    return Math.round(pct);
  }

  _renderGoal(goal) {
    const isWeight = goal.metric === 'weight';
    const hasData = isWeight && this.currentWeight != null;

    let pct = 0;
    let valuesText = '';

    if (isWeight && hasData) {
      pct = this._computeWeightProgress(goal);
      valuesText = `${this.currentWeight} / ${goal.target} ${goal.unit}`;
    } else if (isWeight) {
      valuesText = `-- / ${goal.target} ${goal.unit}`;
    } else {
      // Informational targets (protein, water) — no current tracking
      valuesText = `-- / ${goal.target} ${goal.unit}`;
    }

    const barClass = hasData ? 'active' : 'muted';

    return html`
      <div class="goal">
        <div class="goal-header">
          <span class="goal-description">${goal.description}</span>
          <span class="goal-values">${valuesText}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill ${barClass}" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`
        <div class="card">
          <div class="title">Goals</div>
          <div class="loading-text">Loading...</div>
        </div>
      `;
    }

    const active = Array.isArray(this._goals)
      ? this._goals.filter(g => g.status === 'active')
      : [];

    if (active.length === 0) {
      return html`
        <div class="card">
          <div class="title">Goals</div>
          <div class="empty-text">No active goals</div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <div class="title">Goals</div>
        <div class="goals-list">
          ${active.map(g => this._renderGoal(g))}
        </div>
      </div>
    `;
  }
}

customElements.define('goals-card', GoalsCard);
