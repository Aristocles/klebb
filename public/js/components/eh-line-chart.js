// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-line-chart.js — generic time-series line chart using ECharts.
// Reads data as an array of entries; x-axis field defaults to "date".
// Series declared in viewConfig.series: [{ field, label, colour? }, ...]

import { EhChartBase } from './eh-chart-base.js';
import { registerRenderer } from '../renderer-registry.js';

export class EhLineChart extends EhChartBase {
  buildOptions() {
    const cfg = this._config;
    const xField = cfg.xAxis || 'date';
    const series = cfg.series || [{ field: this._detectYField(), label: cfg.title || this._meta.label }];
    const entries = Array.isArray(this.data) ? this.data : [];
    const sorted = entries.slice().sort((a, b) => String(a[xField] || '').localeCompare(String(b[xField] || '')));
    const xValues = sorted.map(e => e[xField]);
    const echSeries = series.map(s => ({
      name: s.label || s.field,
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 2 },
      ...(s.colour ? { itemStyle: { color: s.colour }, lineStyle: { width: 2, color: s.colour } } : {}),
      data: sorted.map(e => {
        const v = e[s.field];
        return v === undefined || v === null ? null : Number(v);
      }),
    }));
    return {
      title: cfg.title ? { text: cfg.title, left: 'left', textStyle: { fontSize: 12 } } : undefined,
      tooltip: { trigger: 'axis' },
      legend: series.length > 1 ? { top: 0, right: 0 } : undefined,
      xAxis: { type: 'category', data: xValues, boundaryGap: false },
      yAxis: { type: 'value', name: cfg.yAxisLabel },
      series: echSeries,
    };
  }

  _detectYField() {
    const d = Array.isArray(this.data) && this.data.length ? this.data[0] : null;
    if (!d) return 'value';
    const candidates = ['value', 'kg', 'ml', 'count', 'minutes', 'systolic'];
    for (const c of candidates) if (c in d) return c;
    // First non-date numeric key
    for (const k of Object.keys(d)) {
      if (k === 'date' || k === 'time' || k === 'notes') continue;
      if (typeof d[k] === 'number') return k;
    }
    return 'value';
  }
}
customElements.define('eh-line-chart', EhLineChart);
registerRenderer('line-chart', 'eh-line-chart');
registerRenderer('area-chart', 'eh-line-chart');
registerRenderer('bar-chart', 'eh-line-chart');
