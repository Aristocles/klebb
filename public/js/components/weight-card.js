import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today, calculateIntensity, formatHours } from '../api.js';

class WeightCard extends LitElement {
  static properties = {
    _entries: { state: true },
    loading: { state: true },
  };

  static styles = css`
    :host { display: block; min-width: 0; }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
    }

    .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin: 0 0 8px 0;
    }

    .current-weight {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0 0 4px 0;
    }

    .unit {
      font-size: 16px;
      font-weight: 400;
      color: var(--text-secondary);
    }

    .change {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 12px;
    }

    .change.down { color: var(--success); }
    .change.up { color: var(--danger); }
    .change.same { color: var(--warning); }

    .sparkline-container {
      width: 100%;
      height: 40px;
      margin-top: 8px;
    }

    .sparkline-container svg {
      width: 100%;
      height: 100%;
    }

    .loading-text {
      color: var(--text-secondary);
      font-size: 14px;
    }

    .no-data {
      color: var(--text-muted);
      font-size: 14px;
    }
  `;

  constructor() {
    super();
    this._entries = null;
    this.loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this._fetchData();
  }

  async _fetchData() {
    this.loading = true;
    try {
      const result = await api.weight();
      this._entries = Array.isArray(result) ? result : [];
    } catch {
      this._entries = [];
    }
    this.loading = false;
  }

  _buildSparkline(entries) {
    if (!entries || entries.length < 2) return '';

    const recent = entries.slice(-30);
    const weights = recent.map(e => e.kg);
    const min = Math.min(...weights);
    const max = Math.max(...weights);
    const range = max - min || 1;

    const padding = 2;
    const height = 40;
    const width = 100;

    const points = recent.map((e, i) => {
      const x = recent.length === 1 ? width / 2 : (i / (recent.length - 1)) * (width - padding * 2) + padding;
      const y = height - padding - ((e.kg - min) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    return points;
  }

  render() {
    if (this.loading) {
      return html`
        <div class="card">
          <div class="title">Weight</div>
          <div class="loading-text">Loading...</div>
        </div>
      `;
    }

    if (!this._entries || this._entries.length === 0) {
      return html`
        <div class="card">
          <div class="title">Weight</div>
          <div class="no-data">No weight data</div>
        </div>
      `;
    }

    const latest = this._entries[this._entries.length - 1];
    const hasMultiple = this._entries.length > 1;
    const previous = hasMultiple ? this._entries[this._entries.length - 2] : null;

    let changeVal = 0;
    let changeClass = 'same';
    let changeText = '';

    if (previous) {
      changeVal = latest.kg - previous.kg;
      if (changeVal < 0) {
        changeClass = 'down';
        changeText = `${changeVal.toFixed(1)} kg`;
      } else if (changeVal > 0) {
        changeClass = 'up';
        changeText = `+${changeVal.toFixed(1)} kg`;
      } else {
        changeClass = 'same';
        changeText = '0.0 kg';
      }
    }

    const sparklinePoints = this._buildSparkline(this._entries);

    return html`
      <div class="card">
        <div class="title">Weight</div>
        <div class="current-weight">
          ${latest.kg.toFixed(1)} <span class="unit">kg</span>
        </div>
        ${hasMultiple ? html`
          <div class="change ${changeClass}">${changeText}</div>
        ` : ''}
        ${hasMultiple && sparklinePoints ? html`
          <div class="sparkline-container">
            <svg viewBox="0 0 100 40" preserveAspectRatio="none">
              <polyline
                points="${sparklinePoints}"
                fill="none"
                stroke="var(--accent)"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        ` : ''}
      </div>
    `;
  }
}

customElements.define('weight-card', WeightCard);
