// eh-chart-base.js — shared ECharts integration for chart renderers.
// Loads ECharts lazily from CDN and caches the module so multiple charts
// don't re-fetch. Provides theme-aware defaults that respect the existing
// klebb light/dark CSS variables.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';

let _echartsPromise = null;

export function loadECharts() {
  if (_echartsPromise) return _echartsPromise;
  _echartsPromise = import('https://esm.sh/echarts@5.5.1').then(m => m.default || m);
  return _echartsPromise;
}

export function chartTheme() {
  // Use live-resolved CSS variables so it matches whatever theme is active.
  const cs = getComputedStyle(document.documentElement);
  const get = name => cs.getPropertyValue(name).trim();
  return {
    backgroundColor: 'transparent',
    textStyle: { color: get('--text-primary') || '#e0e0e0' },
    title: { textStyle: { color: get('--text-primary') || '#e0e0e0' } },
    legend: { textStyle: { color: get('--text-secondary') || '#8888aa' } },
    grid: { left: 40, right: 20, top: 30, bottom: 30, containLabel: true },
    xAxis: {
      axisLine: { lineStyle: { color: get('--border') || '#2a2a4a' } },
      axisLabel: { color: get('--text-secondary') || '#8888aa' },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisLabel: { color: get('--text-secondary') || '#8888aa' },
      splitLine: { lineStyle: { color: get('--border') || '#2a2a4a', type: 'dashed' } },
    },
    color: [
      get('--accent') || '#00d4aa',
      get('--accent-amber') || '#ffaa00',
      get('--accent-red') || '#ff4444',
      get('--accent-green') || '#44ff88',
      '#8a7cff',
      '#4682b4',
    ],
  };
}

export class EhChartBase extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .chart {
        width: 100%;
        height: 240px;
      }
    `,
  ];

  firstUpdated() {
    this._maybeInit();
  }

  updated(changed) {
    if (changed.has('data') && !this.loading) {
      this._maybeInit();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._chart) { try { this._chart.dispose(); } catch {} this._chart = null; }
    if (this._themeObserver) { this._themeObserver.disconnect(); this._themeObserver = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
  }

  async _maybeInit() {
    const el = this.renderRoot.querySelector('.chart');
    if (!el) return;
    const echarts = await loadECharts();
    if (!this._chart) {
      this._chart = echarts.init(el);
      // React to theme changes (data-theme attribute on <html>)
      this._themeObserver = new MutationObserver(() => this._applyOptions());
      this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(() => { try { this._chart.resize(); } catch {} });
        this._resizeObserver.observe(el);
      }
    }
    this._applyOptions();
  }

  _applyOptions() {
    if (!this._chart) return;
    const base = chartTheme();
    const series = this.buildOptions();
    this._chart.setOption({ ...base, ...series }, true);
  }

  // Subclasses must override
  buildOptions() {
    return { series: [] };
  }

  renderCard() {
    return html`<div class="chart"></div>`;
  }
}
