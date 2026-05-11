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
// Supported metrics are grouped by catalogue category (sleep, recovery,
// activity, vitals, body, mindfulness). Unsupported-but-received metrics
// (those HAE sends but the catalogue doesn't know about) collapse into
// a footer so the actionable surface stays focused on what klebb can
// actually produce cards for.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

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

const CATEGORY_META = {
  sleep:       { label: 'Sleep',        emoji: '😴', order: 10 },
  recovery:    { label: 'Recovery',     emoji: '💓', order: 20 },
  activity:    { label: 'Activity',     emoji: '🏃', order: 30 },
  vitals:      { label: 'Vitals',       emoji: '🩺', order: 40 },
  body:        { label: 'Body',         emoji: '⚖️', order: 50 },
  mindfulness: { label: 'Mindfulness',  emoji: '🧘', order: 60 },
};

function labelFor(metric) {
  return METRIC_LABELS[metric] || metric;
}

function buildPrompt(metric) {
  return `Create a new Health Auto Export-backed card for the "${metric}" metric. See docs/HEALTH-AUTO-EXPORT.md for the catalogue row shape. The manifest should set meta.ingest to { source: "hae", metric: "${metric}" } and writeable.fromWebapp to false.`;
}

export class EhHaeDiscoveryCard extends LitElement {
  static properties = {
    _data: { state: true },
    _loading: { state: true },
    _busyMetric: { state: true },
    _unsupportedOpen: { state: true },
  };

  constructor() {
    super();
    this._data = null;
    this._loading = true;
    this._busyMetric = null;
    this._unsupportedOpen = false;
    this._onManifestChanged = this._onManifestChanged.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
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
      if (!r.ok) { this._data = null; return; }
      this._data = await r.json();
    } catch {
      this._data = null;
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
      if (r.ok) this._removeLocally(metric);
    } finally {
      this._busyMetric = null;
    }
  }

  // Fan-out: dismiss every metric in a category in one click. No new
  // endpoint needed — we just call the existing dismiss endpoint once
  // per metric and update local state.
  async _dismissCategory(category) {
    const supported = this._data?.undismissed?.supported || {};
    const metrics = (supported[category] || []).map(e => e.metric);
    if (metrics.length === 0) return;
    this._busyMetric = `::${category}`;
    try {
      await Promise.all(metrics.map(m =>
        fetch(`/api/health-auto-export/discoveries/${encodeURIComponent(m)}/dismiss`,
          { method: 'POST' })));
      for (const m of metrics) this._removeLocally(m);
    } finally {
      this._busyMetric = null;
    }
  }

  _removeLocally(metric) {
    if (!this._data) return;
    const d = this._data;
    const supported = { ...(d.undismissed?.supported || {}) };
    for (const cat of Object.keys(supported)) {
      supported[cat] = supported[cat].filter(e => e.metric !== metric);
      if (supported[cat].length === 0) delete supported[cat];
    }
    const unsupported = (d.undismissed?.unsupported || []).filter(e => e.metric !== metric);
    this._data = {
      ...d,
      undismissed: { supported, unsupported },
    };
  }

  _totalUndismissed() {
    const supported = this._data?.undismissed?.supported || {};
    const unsupported = this._data?.undismissed?.unsupported || [];
    const supportedCount = Object.values(supported)
      .reduce((acc, arr) => acc + arr.length, 0);
    return { supportedCount, unsupportedCount: unsupported.length };
  }

  render() {
    if (this._loading || !this._data) return html``;
    const { supportedCount, unsupportedCount } = this._totalUndismissed();
    // Hide the card entirely only when there's nothing at all to
    // show. When the operator has subscribers for every supported
    // metric (steady state after setup) but still has undismissed
    // unsupported metrics, render a compact footer-only surface so
    // they retain a path to dismiss those metrics from Today. See
    // #192 (formerly #170's overcorrection).
    if (supportedCount === 0 && unsupportedCount === 0) return html``;

    const supported = this._data.undismissed.supported || {};
    const unsupported = this._data.undismissed.unsupported || [];
    const categories = Object.keys(supported)
      .sort((a, b) => (CATEGORY_META[a]?.order ?? 999) - (CATEGORY_META[b]?.order ?? 999));

    if (supportedCount === 0) {
      // Footer-only mode — no headline, no intro, no category list.
      return html`
        <div class="card footer-only">
          ${this._renderUnsupportedFooter(unsupported)}
        </div>
      `;
    }

    const headline = supportedCount === 1
      ? 'New Apple Health data spotted'
      : `${supportedCount} new Apple Health metrics spotted`;

    return html`
      <div class="card">
        <div class="header">
          <span class="emoji">✨</span>
          <span class="title">${headline}</span>
        </div>
        <p class="intro">
          Recent pushes from Health Auto Export include data your dashboard
          isn't tracking yet. Build a card for what you want; dismiss what
          you don't.
        </p>
        ${categories.map(cat => this._renderCategory(cat, supported[cat]))}
        ${unsupported.length > 0 ? this._renderUnsupportedFooter(unsupported) : ''}
      </div>
    `;
  }

  _renderCategory(category, entries) {
    const meta = CATEGORY_META[category] || { label: category, emoji: '•', order: 999 };
    const busy = this._busyMetric === `::${category}`;
    return html`
      <div class="group">
        <div class="group-header">
          <span class="group-label">
            <span class="group-emoji">${meta.emoji}</span>
            ${meta.label}
          </span>
          ${entries.length > 1 ? html`
            <button
              class="group-dismiss"
              ?disabled=${busy}
              @click=${() => this._dismissCategory(category)}
            >Dismiss all</button>
          ` : ''}
        </div>
        <ul class="rows">
          ${entries.map(e => this._renderRow(e))}
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

  _renderUnsupportedFooter(entries) {
    const open = this._unsupportedOpen;
    const n = entries.length;
    return html`
      <div class="unsupported">
        <button
          class="unsupported-toggle"
          @click=${() => { this._unsupportedOpen = !this._unsupportedOpen; }}
          aria-expanded=${open}
        >
          ${n} more ${n === 1 ? 'metric' : 'metrics'} received but not supported yet
          <span class="chev">${open ? '▴' : '▾'}</span>
        </button>
        ${open ? html`
          <p class="unsupported-hint">
            Klebb doesn't have a catalogue entry for these yet. They're archived
            in the raw push data but not ingested into any card.
            <a href="https://github.com/Aristocles/klebb/issues/new" target="_blank" rel="noopener">Request support →</a>
          </p>
          <ul class="rows compact">
            ${entries.map(e => html`
              <li class="row muted-row">
                <span class="row-label">
                  <span class="metric-key">${e.metric}</span>
                </span>
                <span class="row-actions">
                  <button
                    class="btn"
                    ?disabled=${this._busyMetric === e.metric}
                    @click=${() => this._dismiss(e.metric)}
                  >Dismiss</button>
                </span>
              </li>
            `)}
          </ul>
        ` : ''}
      </div>
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
      margin: 8px 0 12px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--text-primary);
    }
    .intro.muted { color: var(--text-muted, var(--text-secondary)); font-style: italic; }

    .group { margin-bottom: 12px; }
    .group:last-child { margin-bottom: 0; }
    .group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
      padding: 0 2px;
    }
    .group-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted, var(--text-secondary));
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .group-emoji { font-size: 13px; }
    .group-dismiss {
      font: inherit;
      font-size: 11px;
      font-weight: 500;
      background: transparent;
      border: none;
      color: var(--text-muted, var(--text-secondary));
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .group-dismiss:hover:not(:disabled) {
      color: var(--text-primary);
      background: var(--bg-hover, rgba(0, 0, 0, 0.03));
    }
    .group-dismiss:disabled { opacity: 0.4; cursor: not-allowed; }

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

    .unsupported {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }
    .unsupported-toggle {
      font: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 4px 6px;
      border-radius: 6px;
      border: none;
      background: transparent;
      color: var(--text-muted, var(--text-secondary));
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .unsupported-toggle:hover {
      color: var(--text-primary);
      background: var(--bg-hover, rgba(0, 0, 0, 0.03));
    }
    .chev { font-size: 10px; }
    .unsupported-hint {
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      margin: 6px 0 8px;
    }
    .unsupported-hint a {
      color: var(--accent, #00d4aa);
      text-decoration: underline;
    }
    .rows.compact { gap: 4px; }
    .muted-row { opacity: 0.75; }
    .muted-row .metric-key { font-size: 12px; }

    @media (max-width: 480px) {
      .row {
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
      }
      .row-actions { justify-content: flex-end; }
    }
  `;
}

customElements.define('eh-hae-discovery-card', EhHaeDiscoveryCard);
