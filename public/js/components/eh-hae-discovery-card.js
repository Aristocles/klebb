// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-hae-discovery-card.js
//
// Pinned-to-top information card that surfaces HAE metrics present in
// recent pushes but not yet subscribed to by any manifest. The
// server-side discoveries module records these after each push; this
// component reads them from /api/health-auto-export/discoveries and
// offers two actions per metric:
//
//   "Build a card" — seeds the chat widget with a templated prompt
//                    asking klebbius to create a subscriber manifest.
//   "Dismiss"      — permanently hides this metric (can be un-hidden
//                    from Settings).
//
// The card self-hides when no undismissed discoveries remain. It is
// not a klebb.datafile.v1 manifest — it exists only as a UI surface,
// pinned by the date view when mode === 'today'.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

// Human-readable labels for the catalogue keys we know about. Unknown
// keys fall back to the raw metric name.
const METRIC_LABELS = {
  sleep_analysis: 'Sleep',
  step_count: 'Steps',
  apple_exercise_time: 'Exercise minutes',
  workouts: 'Workouts',
  heart_rate_variability: 'Heart rate variability (HRV)',
  resting_heart_rate: 'Resting heart rate',
  walking_heart_rate_average: 'Walking heart rate average',
  blood_oxygen_saturation: 'Blood oxygen (SpO₂)',
  mindful_minutes: 'Mindful minutes',
  body_mass: 'Weight',
  body_fat_percentage: 'Body fat percentage',
  blood_pressure_systolic: 'Systolic blood pressure',
  blood_pressure_diastolic: 'Diastolic blood pressure',
};

function labelFor(metric) {
  return METRIC_LABELS[metric] || metric;
}

function buildPrompt(metric) {
  return `Create a new Health Auto Export-backed card for the "${metric}" metric. See docs/HEALTH-AUTO-EXPORT.md for the catalogue row shape. The manifest should set meta.ingest to { source: "hae", metric: "${metric}" } and writeable.fromWebapp to false.`;
}

export class EhHaeDiscoveryCard extends LitElement {
  static properties = {
    _entries: { state: true },
    _loading: { state: true },
    _busyMetric: { state: true },
  };

  constructor() {
    super();
    this._entries = [];
    this._loading = true;
    this._busyMetric = null;
    this._onManifestChanged = this._onManifestChanged.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
    // Re-fetch discoveries when a manifest is created / changed — this
    // covers the "build a card" flow where the server replays archive
    // data and graduates the metric out of discovered.json.
    window.addEventListener('manifest-data-changed', this._onManifestChanged);
    window.addEventListener('klebb-cards-changed', this._onManifestChanged);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('manifest-data-changed', this._onManifestChanged);
    window.removeEventListener('klebb-cards-changed', this._onManifestChanged);
  }

  _onManifestChanged() {
    this._load();
  }

  async _load() {
    this._loading = true;
    try {
      const r = await fetch('/api/health-auto-export/discoveries');
      if (!r.ok) { this._entries = []; return; }
      const body = await r.json();
      this._entries = Array.isArray(body.undismissed) ? body.undismissed : [];
    } catch {
      this._entries = [];
    } finally {
      this._loading = false;
    }
  }

  async _build(metric) {
    window.dispatchEvent(new CustomEvent('klebb-paste-into-chat', {
      detail: { text: buildPrompt(metric) },
    }));
  }

  async _dismiss(metric) {
    this._busyMetric = metric;
    try {
      const r = await fetch(
        `/api/health-auto-export/discoveries/${encodeURIComponent(metric)}/dismiss`,
        { method: 'POST' });
      if (r.ok) {
        this._entries = this._entries.filter(e => e.metric !== metric);
      }
    } finally {
      this._busyMetric = null;
    }
  }

  render() {
    if (this._loading) return html``;
    if (!this._entries.length) return html``;

    const n = this._entries.length;
    const headline = n === 1
      ? 'New Apple Health data spotted'
      : `${n} new Apple Health metrics spotted`;

    return html`
      <div class="card">
        <div class="header">
          <span class="emoji">✨</span>
          <span class="title">${headline}</span>
        </div>
        <p class="intro">
          Recent pushes from Health Auto Export include data nothing on your
          dashboard subscribes to yet. Build a card for what you want; dismiss
          what you don't.
        </p>
        <ul class="rows">
          ${this._entries.map(e => this._renderRow(e))}
        </ul>
      </div>
    `;
  }

  _renderRow(entry) {
    const isBusy = this._busyMetric === entry.metric;
    return html`
      <li class="row">
        <span class="row-label">
          <span class="metric-label">${labelFor(entry.metric)}</span>
          <span class="metric-key">${entry.metric}</span>
        </span>
        <span class="row-actions">
          <button
            class="btn primary"
            @click=${() => this._build(entry.metric)}
            ?disabled=${isBusy}
          >Build a card</button>
          <button
            class="btn"
            @click=${() => this._dismiss(entry.metric)}
            ?disabled=${isBusy}
          >Dismiss</button>
        </span>
      </li>
    `;
  }

  static styles = css`
    :host {
      display: block;
      margin-bottom: 16px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--accent, #00d4aa);
      border-radius: 12px;
      padding: 14px 16px 12px;
      box-shadow: 0 2px 10px rgba(0, 212, 170, 0.08);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--accent, #00d4aa);
    }
    .emoji { font-size: 16px; }
    .intro {
      margin: 8px 0 10px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--text-primary);
    }
    .rows {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--bg-input, rgba(0, 0, 0, 0.03));
      border: 1px solid var(--border);
    }
    .row-label {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    .metric-label {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .metric-key {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
    }
    .row-actions {
      display: inline-flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .btn {
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s, color 0.12s;
    }
    .btn:hover:not(:disabled) {
      border-color: var(--accent, #00d4aa);
      background: var(--bg-hover, rgba(255, 255, 255, 0.04));
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn.primary {
      border-color: var(--accent, #00d4aa);
      background: var(--accent, #00d4aa);
      color: var(--bg-card);
    }
    .btn.primary:hover:not(:disabled) {
      filter: brightness(1.08);
    }
    .btn:focus-visible {
      outline: 2px solid var(--accent, #00d4aa);
      outline-offset: 2px;
    }
    @media (max-width: 480px) {
      .row {
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
      }
      .row-actions {
        justify-content: flex-end;
      }
    }
  `;
}

customElements.define('eh-hae-discovery-card', EhHaeDiscoveryCard);
