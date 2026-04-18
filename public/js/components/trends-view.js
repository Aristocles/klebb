import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today, daysAgo } from '../api.js';

function loadChartJs() {
  return new Promise((resolve, reject) => {
    if (window.Chart) {
      resolve(window.Chart);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => reject(new Error('Failed to load Chart.js'));
    document.head.appendChild(script);
  });
}

class TrendsView extends LitElement {
  _themeColors() {
    const s = getComputedStyle(document.documentElement);
    const get = (v, fb) => s.getPropertyValue(v).trim() || fb;
    return {
      text: get('--text-secondary', '#64748b'),
      grid: get('--chart-grid', '#e2e8f0'),
      bg: get('--bg-card', '#ffffff'),
      title: get('--text-primary', '#1e293b'),
      body: get('--text-secondary', '#64748b'),
      accent: get('--accent', '#00d4aa'),
      danger: get('--danger', '#ff4444'),
      success: get('--success', '#44ff88'),
      warning: get('--warning', '#ffaa00'),
      accentDark: get('--accent-dark', '#0284c7'),
    };
  }

  static properties = {
    period: { state: true },
    loading: { state: true },
    _sleepData: { state: true },
    _vitalsData: { state: true },
    _activityData: { state: true },
    _weightData: { state: true },
    _workoutsData: { state: true },
    _moodData: { state: true },
  };

  static styles = css`
    :host { display: block; }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 24px;
    }

    .title {
      font-size: 1.4rem;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .period-selector {
      display: flex;
      gap: 6px;
    }

    .period-btn {
      background: var(--bg-nav);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 16px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }

    .period-btn:hover {
      border-color: var(--accent);
      color: var(--text-primary);
    }

    .period-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #0a0a1a;
    }

    .charts-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }

    @media (min-width: 769px) {
      .charts-grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    .chart-card {
      background: var(--bg-nav);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }

    .chart-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin: 0 0 4px 0;
    }

    .chart-avg {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 12px 0;
    }

    .chart-avg span {
      color: var(--accent);
    }

    .chart-container {
      position: relative;
      width: 100%;
      height: 220px;
    }

    .chart-container canvas {
      width: 100% !important;
      height: 100% !important;
    }

    .loading-text {
      color: var(--text-secondary);
      font-size: 14px;
      text-align: center;
      padding: 40px 0;
    }

    .no-data {
      color: var(--text-muted);
      font-size: 13px;
      text-align: center;
      padding: 40px 0;
    }

    /* Peptide Timeline */
    .pep-group {
      margin-bottom: 20px;
    }
    .pep-group:last-child { margin-bottom: 0; }

    .pep-group-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }

    .pep-group-name {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .pep-group-timing {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .pep-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .pep-label {
      width: 80px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      flex-shrink: 0;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pep-timeline {
      display: flex;
      gap: 2px;
      flex: 1;
      align-items: flex-end;
      height: 24px;
    }

    .pep-dot {
      flex: 1;
      min-width: 3px;
      max-width: 12px;
      border-radius: 2px;
      transition: height 0.2s, opacity 0.2s;
    }

    .pep-dot.taken {
      height: 100%;
      opacity: 1;
    }

    .pep-dot.missed {
      height: 100%;
      opacity: 1;
      background: transparent !important;
      border: 1.5px solid;
      box-sizing: border-box;
    }

    .pep-dot.off-schedule {
      height: 100%;
      opacity: 0.45;
    }

    .pep-dot.inactive {
      height: 30%;
      background: var(--border) !important;
      opacity: 0.4;
    }

    .pep-cycle-info {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .pep-cycle-badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
      background: var(--bg-input);
      color: var(--text-secondary);
    }

    .pep-cycle-badge.active {
      color: var(--success);
      background: rgba(34, 197, 94, 0.1);
    }

    .pep-cycle-badge.off-cycle {
      color: var(--warning);
      background: rgba(245, 158, 11, 0.1);
    }

    .pep-dose-info {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .pep-legend {
      display: flex;
      gap: 12px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }

    .pep-legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--text-muted);
    }

    .pep-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }

    .pep-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }

    .pep-stat {
      text-align: center;
      padding: 8px;
      background: var(--bg-input);
      border-radius: 8px;
    }

    .pep-stat-value {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
    }

    .pep-stat-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  `;

  constructor() {
    super();
    this.period = '30d';
    this.loading = true;
    this._sleepData = null;
    this._vitalsData = null;
    this._activityData = null;
    this._weightData = null;
    this._workoutsData = null;
    this._moodData = null;
    this._moodData = null;
    this._charts = {};
  }

  connectedCallback() {
    super.connectedCallback();
    this._init();
    // Re-render charts when theme changes
    this._themeObserver = new MutationObserver(() => {
      if (this._chartsReady) {
        this._destroyAllCharts();
        this.updateComplete.then(() => this._renderAllCharts());
      }
    });
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyAllCharts();
    if (this._themeObserver) this._themeObserver.disconnect();
  }

  async _init() {
    await loadChartJs();
    await this._fetchData();
  }

  _getStartDate() {
    switch (this.period) {
      case '30d': return daysAgo(30);
      case '90d': return daysAgo(90);
      case '1y': return daysAgo(365);
      case 'all': return '2000-01-01';
      default: return daysAgo(30);
    }
  }

  _rangeToArray(data, mapper) {
    if (!data || typeof data !== 'object') return [];
    return Object.keys(data).sort().map(date => mapper(date, data[date]));
  }

  async _fetchData() {
    this.loading = true;
    const start = this._getStartDate();
    const end = today();

    try {
      const [sleepData, vitalsData, activityData, weightData, workoutsData, moodData, peptidesData, injectionLogData] = await Promise.all([
        api.sleepRange(start, end),
        api.vitalsRange(start, end),
        api.activityRange(start, end),
        api.weightRange(start, end),
        api.workoutsRange(start, end),
        api.moodRange(start, end),
        api.peptides(),
        api.injectionLogAll(),
      ]);

      // Range APIs return { "YYYY-MM-DD": data } objects — convert to sorted arrays
      this._sleepData = this._rangeToArray(sleepData, (date, entries) => {
        const e = Array.isArray(entries) ? entries[0] : entries;
        return { ...e, date };
      });
      this._vitalsData = this._rangeToArray(vitalsData, (date, metrics) => ({ date, ...metrics }));
      this._activityData = this._rangeToArray(activityData, (date, metrics) => ({ date, ...metrics }));
      this._weightData = Array.isArray(weightData) ? weightData : this._rangeToArray(weightData, (date, entries) => {
        const e = Array.isArray(entries) ? entries[0] : entries;
        return { date, ...e };
      });
      this._workoutsData = this._rangeToArray(workoutsData, (date, entries) => {
        const arr = Array.isArray(entries) ? entries : [entries];
        return arr.map(w => ({ date, ...w }));
      }).flat();
      this._moodData = moodData || {};
      this._moodData = this._rangeToArray(moodData, (date, entry) => ({ date, ...entry }));
      this._peptidesData = peptidesData;
      this._injectionLog = injectionLogData || {};
    } catch {
      this._sleepData = [];
      this._vitalsData = [];
      this._activityData = [];
      this._weightData = [];
      this._workoutsData = [];
      this._moodData = {};
      this._moodData = [];
      this._peptidesData = null;
      this._injectionLog = {};
    }

    this.loading = false;

    await this.updateComplete;
    this._renderAllCharts();
    this._chartsReady = true;
  }

  _renderMoodSleepChart() {
    const canvas = this._getCanvas('moodSleepChart');
    if (!canvas) return;

    // Build correlated data: mood + sleep on same date
    const points = [];
    const moodLabels = { 1: 'Awful', 2: 'Tired', 3: 'Meh', 4: 'Good', 5: 'Great' };
    const tc = this._themeColors();
    const moodColors = { 1: tc.danger, 2: '#ff8844', 3: tc.warning, 4: tc.success, 5: tc.accent };

    for (const sleep of (this._sleepData || [])) {
      const date = (sleep.date || '').substring(0, 10);
      const moodEntry = this._moodData[date];
      if (!moodEntry || !moodEntry.mood) continue;
      const totalSleep = sleep.totalSleep || (sleep.core || 0) + (sleep.rem || 0) + (sleep.deep || 0);
      if (totalSleep <= 0) continue;
      points.push({ x: totalSleep, y: moodEntry.mood, date, color: moodColors[moodEntry.mood] });
    }

    if (points.length < 3) return; // Need at least 3 data points

    this._destroyChart('moodSleepChart');
    this._charts['moodSleepChart'] = new Chart(canvas.getContext('2d'), {
      type: 'scatter',
      data: {
        datasets: [{
          data: points,
          backgroundColor: points.map(p => p.color),
          pointRadius: 6,
          pointHoverRadius: 8,
        }],
      },
      options: {
        ...this._baseChartOptions(false),
        scales: {
          x: {
            ...this._baseChartOptions(false).scales.x,
            title: { display: true, text: 'Sleep (hours)', color: this._themeColors().text, font: { size: 10 } },
            min: 0,
          },
          y: {
            ...this._baseChartOptions(false).scales.y,
            title: { display: true, text: 'Mood', color: this._themeColors().text, font: { size: 10 } },
            min: 0.5, max: 5.5,
            ticks: {
              ...this._baseChartOptions(false).scales.y.ticks,
              stepSize: 1,
              callback: (v) => moodLabels[v] || '',
            },
          },
        },
        plugins: {
          ...this._baseChartOptions(false).plugins,
          tooltip: {
            ...this._baseChartOptions(false).plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const p = ctx.raw;
                return `${p.date}: ${p.x.toFixed(1)}h sleep, ${moodLabels[p.y]}`;
              },
            },
          },
        },
      },
    });
  }

  _setPeriod(p) {
    if (this.period === p) return;
    this.period = p;
    this._fetchData();
  }

  _destroyAllCharts() {
    Object.values(this._charts).forEach(c => {
      if (c) c.destroy();
    });
    this._charts = {};
  }

  _destroyChart(id) {
    if (this._charts[id]) {
      this._charts[id].destroy();
      delete this._charts[id];
    }
  }

  _getCanvas(id) {
    return this.shadowRoot?.querySelector(`#${id}`);
  }

  _formatDateLabel(dateStr) {
    // Handle both "YYYY-MM-DD" and "YYYY-MM-DD HH:mm:ss +ZZZZ" formats
    const clean = (dateStr || '').substring(0, 10);
    const d = new Date(clean + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    const day = d.getDate();
    const mon = d.toLocaleDateString('en-AU', { month: 'short' });
    return `${day} ${mon}`;
  }

  _baseChartOptions(showLegend = false) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: {
          display: showLegend,
          labels: {
            color: this._themeColors().text,
            font: { size: 11 },
            boxWidth: 12,
            padding: 8,
          },
        },
        tooltip: {
          backgroundColor: this._themeColors().bg,
          titleColor: this._themeColors().title,
          bodyColor: this._themeColors().body,
          borderColor: this._themeColors().grid,
          borderWidth: 1,
          padding: 8,
          cornerRadius: 8,
        },
      },
      scales: {
        x: {
          ticks: {
            color: this._themeColors().text,
            font: { size: 10 },
            maxRotation: 45,
            maxTicksLimit: 12,
          },
          grid: {
            color: this._themeColors().grid,
          },
          border: {
            color: this._themeColors().grid,
          },
        },
        y: {
          ticks: {
            color: this._themeColors().text,
            font: { size: 10 },
          },
          grid: {
            color: this._themeColors().grid,
          },
          border: {
            color: this._themeColors().grid,
          },
        },
      },
    };
  }

  _renderAllCharts() {
    this._destroyAllCharts();
    this._renderWeightChart();
    this._renderSleepChart();
    this._renderHRChart();
    this._renderHRVChart();
    this._renderStepsChart();
    this._renderExerciseChart();
    this._renderMoodSleepChart();
    this._renderMoodChart();
    this._renderWakeUpsChart();
  }

  _renderWeightChart() {
    const canvas = this._getCanvas('weightChart');
    if (!canvas || !this._weightData || this._weightData.length === 0) return;

    const ctx = canvas.getContext('2d');
    const tc = this._themeColors();
    const labels = this._weightData.map(d => this._formatDateLabel(d.date));
    const values = this._weightData.map(d => d.kg);

    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, tc.accent + '33');
    gradient.addColorStop(1, tc.accent + '00');

    this._destroyChart('weightChart');
    this._charts['weightChart'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: tc.accent,
          backgroundColor: gradient,
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: tc.accent,
          pointBorderColor: tc.accent,
          pointHoverRadius: 4,
          borderWidth: 2,
        }],
      },
      options: this._baseChartOptions(false),
    });
  }

  _renderSleepChart() {
    const canvas = this._getCanvas('sleepChart');
    if (!canvas || !this._sleepData || this._sleepData.length === 0) return;

    const ctx = canvas.getContext('2d');
    const labels = this._sleepData.map(d => this._formatDateLabel(d.date));
    const coreValues = this._sleepData.map(d => d.core || 0);
    const remValues = this._sleepData.map(d => d.rem || 0);
    const deepValues = this._sleepData.map(d => d.deep || 0);

    this._destroyChart('sleepChart');
    this._charts['sleepChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Core',
            data: coreValues,
            backgroundColor: '#6366f1',
            borderRadius: 2,
          },
          {
            label: 'REM',
            data: remValues,
            backgroundColor: '#a855f7',
            borderRadius: 2,
          },
          {
            label: 'Deep',
            data: deepValues,
            backgroundColor: '#3b82f6',
            borderRadius: 2,
          },
        ],
      },
      options: {
        ...this._baseChartOptions(true),
        scales: {
          ...this._baseChartOptions(true).scales,
          x: {
            ...this._baseChartOptions(true).scales.x,
            stacked: true,
          },
          y: {
            ...this._baseChartOptions(true).scales.y,
            stacked: true,
            title: {
              display: true,
              text: 'hours',
              color: this._themeColors().text,
              font: { size: 10 },
            },
          },
        },
      },
    });
  }

  _renderHRChart() {
    const canvas = this._getCanvas('hrChart');
    if (!canvas || !this._vitalsData || this._vitalsData.length === 0) return;

    const ctx = canvas.getContext('2d');
    const tc = this._themeColors();
    const filtered = this._vitalsData.filter(d =>
      (d.heart_rate?.avg) || (d.walking_heart_rate_average?.avg)
    );
    if (filtered.length === 0) return;

    const labels = filtered.map(d => this._formatDateLabel(d.date));
    const values = filtered.map(d =>
      d.heart_rate?.avg || d.walking_heart_rate_average?.avg || null
    );

    this._destroyChart('hrChart');
    this._charts['hrChart'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: tc.danger,
          backgroundColor: 'rgba(255, 68, 68, 0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: tc.danger,
          pointBorderColor: tc.danger,
          pointHoverRadius: 4,
          borderWidth: 2,
          spanGaps: true,
        }],
      },
      options: this._baseChartOptions(false),
    });
  }

  _renderHRVChart() {
    const canvas = this._getCanvas('hrvChart');
    if (!canvas || !this._vitalsData || this._vitalsData.length === 0) return;

    const ctx = canvas.getContext('2d');
    const tc = this._themeColors();
    const filtered = this._vitalsData.filter(d => d.heart_rate_variability?.avg);
    if (filtered.length === 0) return;

    const labels = filtered.map(d => this._formatDateLabel(d.date));
    const values = filtered.map(d => d.heart_rate_variability.avg);

    this._destroyChart('hrvChart');
    this._charts['hrvChart'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: tc.success,
          backgroundColor: 'rgba(68, 255, 136, 0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: tc.success,
          pointBorderColor: tc.success,
          pointHoverRadius: 4,
          borderWidth: 2,
          spanGaps: true,
        }],
      },
      options: this._baseChartOptions(false),
    });
  }

  _renderStepsChart() {
    const canvas = this._getCanvas('stepsChart');
    if (!canvas || !this._activityData || this._activityData.length === 0) return;

    const ctx = canvas.getContext('2d');
    const tc = this._themeColors();
    const labels = this._activityData.map(d => this._formatDateLabel(d.date));
    const values = this._activityData.map(d => d.step_count?.total || 0);

    // 7-day moving average
    const movingAvg = values.map((_, i) => {
      const start = Math.max(0, i - 6);
      const window = values.slice(start, i + 1);
      return Math.round(window.reduce((a, b) => a + b, 0) / window.length);
    });

    this._destroyChart('stepsChart');
    this._charts['stepsChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            data: values,
            backgroundColor: tc.accent + '80',
            borderRadius: 2,
            order: 2,
          },
          {
            type: 'line',
            data: movingAvg,
            borderColor: tc.accent,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.4,
            order: 1,
          },
        ],
      },
      options: this._baseChartOptions(false),
    });
  }

  _renderExerciseChart() {
    const canvas = this._getCanvas('exerciseChart');
    if (!canvas || !this._workoutsData) return;

    const ctx = canvas.getContext('2d');
    const tc = this._themeColors();

    // Aggregate workouts per week
    const weekMap = {};
    this._workoutsData.forEach(w => {
      const dateStr = w.date || w.startDate;
      if (!dateStr) return;
      const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
      // Get Monday of that week
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      const weekKey = monday.toLocaleDateString('en-CA');
      if (!weekMap[weekKey]) weekMap[weekKey] = 0;
      weekMap[weekKey]++;
    });

    const sortedWeeks = Object.keys(weekMap).sort();
    if (sortedWeeks.length === 0) return;

    const labels = sortedWeeks.map(w => {
      const d = new Date(w + 'T00:00:00');
      const day = d.getDate();
      const mon = d.toLocaleDateString('en-AU', { month: 'short' });
      return `${day} ${mon}`;
    });
    const values = sortedWeeks.map(w => weekMap[w]);

    this._destroyChart('exerciseChart');
    this._charts['exerciseChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: tc.warning,
          borderRadius: 4,
        }],
      },
      options: {
        ...this._baseChartOptions(false),
        scales: {
          ...this._baseChartOptions(false).scales,
          y: {
            ...this._baseChartOptions(false).scales.y,
            beginAtZero: true,
            ticks: {
              ...this._baseChartOptions(false).scales.y.ticks,
              stepSize: 1,
            },
          },
        },
      },
    });
  }

  _renderMoodChart() {
    const canvas = this._getCanvas('moodChart');
    if (!canvas || !this._moodData || this._moodData.length === 0) return;

    const ctx = canvas.getContext('2d');
    const tc = this._themeColors();
    const labels = this._moodData.map(d => this._formatDateLabel(d.date));
    const values = this._moodData.map(d => d.mood || null);

    const moodColors = { 1: tc.danger, 2: '#ff8844', 3: tc.warning, 4: '#88cc44', 5: tc.success };
    const pointColors = values.map(v => moodColors[v] || '#64748b');

    this._destroyChart('moodChart');
    this._charts['moodChart'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 5,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointHoverRadius: 7,
          borderWidth: 2,
          spanGaps: true,
        }],
      },
      options: {
        ...this._baseChartOptions(false),
        scales: {
          ...this._baseChartOptions(false).scales,
          y: {
            ...this._baseChartOptions(false).scales.y,
            min: 0.5,
            max: 5.5,
            ticks: {
              ...this._baseChartOptions(false).scales.y.ticks,
              stepSize: 1,
              callback: (v) => {
                const labels = { 1: '😩', 2: '😴', 3: '😐', 4: '🙂', 5: '😄' };
                return labels[v] || '';
              },
            },
          },
        },
      },
    });
  }

  _renderWakeUpsChart() {
    const canvas = this._getCanvas('wakeUpsChart');
    if (!canvas || !this._moodData || this._moodData.length === 0) return;

    const filtered = this._moodData.filter(d => d.wakeUps !== null && d.wakeUps !== undefined);
    if (filtered.length === 0) return;

    const ctx = canvas.getContext('2d');
    const tc = this._themeColors();
    const labels = filtered.map(d => this._formatDateLabel(d.date));
    const values = filtered.map(d => d.wakeUps);
    const barColors = values.map(v => v <= 1 ? tc.success : v <= 3 ? tc.warning : tc.danger);

    // 7-day moving average
    const movingAvg = values.map((_, i) => {
      const start = Math.max(0, i - 6);
      const window = values.slice(start, i + 1);
      return +(window.reduce((a, b) => a + b, 0) / window.length).toFixed(1);
    });

    this._destroyChart('wakeUpsChart');
    this._charts['wakeUpsChart'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            data: values,
            backgroundColor: barColors,
            borderRadius: 3,
            order: 2,
          },
          {
            type: 'line',
            data: movingAvg,
            borderColor: '#ff6b6b',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.4,
            order: 1,
          },
        ],
      },
      options: {
        ...this._baseChartOptions(false),
        scales: {
          ...this._baseChartOptions(false).scales,
          y: {
            ...this._baseChartOptions(false).scales.y,
            beginAtZero: true,
            ticks: {
              ...this._baseChartOptions(false).scales.y.ticks,
              stepSize: 1,
            },
          },
        },
      },
    });
  }

  _getAverages() {
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    // Weight
    const weightVals = (this._weightData || []).map(d => d.kg).filter(v => v > 0);
    const weightAvg = avg(weightVals);

    // Sleep (total hours)
    const sleepVals = (this._sleepData || []).map(d => d.totalSleep || (d.core || 0) + (d.rem || 0) + (d.deep || 0) + (d.awake || 0)).filter(v => v > 0);
    const sleepAvg = avg(sleepVals);

    // HR
    const hrVals = (this._vitalsData || []).map(d => d.heart_rate?.avg || d.walking_heart_rate_average?.avg).filter(v => v > 0);
    const hrAvg = avg(hrVals);

    // HRV
    const hrvVals = (this._vitalsData || []).map(d => d.heart_rate_variability?.avg).filter(v => v > 0);
    const hrvAvg = avg(hrvVals);

    // Steps
    const stepVals = (this._activityData || []).map(d => d.step_count?.total || 0).filter(v => v > 0);
    const stepsAvg = avg(stepVals);

    // Workouts per week
    const weekSet = new Set();
    (this._workoutsData || []).forEach(w => {
      const dateStr = w.date || w.startDate;
      if (!dateStr) return;
      const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      weekSet.add(monday.toLocaleDateString('en-CA'));
    });
    const totalWorkouts = (this._workoutsData || []).length;
    const numWeeks = weekSet.size || 1;
    const workoutsPerWeek = totalWorkouts / numWeeks;

    // Mood/Sleep correlation
    let moodSleepCorr = null;
    let moodSleepPoints = 0;
    const moodSleepPairs = [];
    for (const sleep of (this._sleepData || [])) {
      const date = (sleep.date || '').substring(0, 10);
      const moodEntry = (this._moodData || {})[date];
      if (!moodEntry || !moodEntry.mood) continue;
      const totalSleep = sleep.totalSleep || (sleep.core || 0) + (sleep.rem || 0) + (sleep.deep || 0);
      if (totalSleep <= 0) continue;
      moodSleepPairs.push({ sleep: totalSleep, mood: moodEntry.mood });
    }
    moodSleepPoints = moodSleepPairs.length;
    if (moodSleepPairs.length >= 3) {
      // Pearson correlation
      const n = moodSleepPairs.length;
      const sumX = moodSleepPairs.reduce((a, p) => a + p.sleep, 0);
      const sumY = moodSleepPairs.reduce((a, p) => a + p.mood, 0);
      const sumXY = moodSleepPairs.reduce((a, p) => a + p.sleep * p.mood, 0);
      const sumX2 = moodSleepPairs.reduce((a, p) => a + p.sleep * p.sleep, 0);
      const sumY2 = moodSleepPairs.reduce((a, p) => a + p.mood * p.mood, 0);
      const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      moodSleepCorr = denom > 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    }

    return { weightAvg, sleepAvg, hrAvg, hrvAvg, stepsAvg, workoutsPerWeek, totalWorkouts, moodSleepCorr, moodSleepPoints };
  }

  _getPeptideColors() {
    return {
      'BPC-157': '#2e8b57',
      'TB-500': '#4682b4',
      'CJC-1295/Ipamorelin Blend': '#9467bd',
      'Epithalon': '#d68910',
      'Tesamorelin': '#e74c3c',

      'NAD+': '#f39c12',
      'Mounjaro': '#e74c3c',
    };
  }

  _getDaysInRange(start, end) {
    const days = [];
    const d = new Date(start + 'T00:00:00');
    const endDate = new Date(end + 'T00:00:00');
    while (d <= endDate) {
      days.push(d.toLocaleDateString('en-CA'));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  _isPeptideScheduledOnDate(pep, dateStr) {
    const dayName = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' });
    const sched = pep.schedule;
    if (!sched) return false;

    // Check if date is within any cycle
    const cycle = (pep.cycles || []).find(c => dateStr >= c.start_date && dateStr <= (c.off_end || c.end_date));
    if (!cycle) return false;

    const inOnCycle = dateStr >= cycle.start_date && dateStr <= cycle.end_date;
    const inOffCycle = cycle.off_start && cycle.off_end && dateStr >= cycle.off_start && dateStr <= cycle.off_end;

    if (inOffCycle) return 'off';
    if (!inOnCycle) return false;

    if (sched.type === 'daily_straight') return 'scheduled';
    if (sched.type === 'on_off') return sched.on_days?.includes(dayName) ? 'scheduled' : 'rest';
    if (sched.type === 'phased') {
      const cycleStart = new Date(cycle.start_date + 'T00:00:00');
      const current = new Date(dateStr + 'T00:00:00');
      const weekNum = Math.floor((current - cycleStart) / (7 * 86400000)) + 1;
      const loadingWeeks = sched.loading?.duration_weeks || 4;
      if (weekNum <= loadingWeeks) {
        return sched.loading?.days?.includes(dayName) ? 'scheduled' : 'rest';
      } else {
        return sched.maintenance?.days?.includes(dayName) ? 'scheduled' : 'rest';
      }
    }
    return false;
  }

  _renderPeptideTimeline() {
    if (!this._peptidesData?.peptides) return '';

    const peptides = this._peptidesData.peptides;
    const groups = this._peptidesData.injection_groups || [];
    const log = this._injectionLog || {};
    const colors = this._getPeptideColors();
    const start = this._getStartDate();
    const end = today();
    const days = this._getDaysInRange(start, end);

    // Build group cards
    const groupCards = groups.map(group => {
      const groupPeptides = group.peptides.map(name => peptides.find(p => p.name === name)).filter(Boolean);
      if (groupPeptides.length === 0) return '';

      // Calculate stats for this group
      let totalTaken = 0;
      let totalMissed = 0;

      const pepRows = groupPeptides.map(pep => {
        const color = colors[pep.name] || 'var(--accent)';
        let taken = 0;
        let missed = 0;
        let offSchedule = 0;

        const dots = days.map(d => {
          const wasTaken = log[d]?.[pep.name]?.taken;
          const status = this._isPeptideScheduledOnDate(pep, d);
          const isScheduledDay = status === 'scheduled';
          const isInactive = status === 'off' || status === 'rest' || status === false;

          if (wasTaken && isScheduledDay) {
            taken++;
            totalTaken++;
            return { status: 'taken', color };
          }
          if (wasTaken && !isScheduledDay) {
            offSchedule++;
            return { status: 'off-schedule', color };
          }
          if (isScheduledDay && !wasTaken) {
            missed++;
            totalMissed++;
            return { status: 'missed', color };
          }
          // Off-cycle, rest day, or outside any cycle
          return { status: 'inactive', color };
        });

        // Current cycle info
        const todayStr = today();
        const currentCycle = (pep.cycles || []).find(c =>
          todayStr >= c.start_date && todayStr <= (c.off_end || c.end_date)
        );

        let cycleStatus = null;
        if (currentCycle) {
          const inOn = todayStr >= currentCycle.start_date && todayStr <= currentCycle.end_date;
          const startD = new Date((inOn ? currentCycle.start_date : currentCycle.off_start) + 'T00:00:00');
          const endD = new Date((inOn ? currentCycle.end_date : currentCycle.off_end) + 'T00:00:00');
          const todayD = new Date(todayStr + 'T00:00:00');
          const dayNum = Math.floor((todayD - startD) / 86400000) + 1;
          const totalDays = Math.floor((endD - startD) / 86400000) + 1;
          cycleStatus = {
            inOn,
            cycleNumber: currentCycle.cycle_number,
            dayNum,
            totalDays,
          };
        }

        return { pep, dots, taken, missed, offSchedule, color, cycleStatus };
      });

      const compliance = totalMissed + totalTaken > 0
        ? Math.round((totalTaken / (totalMissed + totalTaken)) * 100)
        : 0;

      return html`
        <div class="chart-card">
          <div class="pep-group">
            <div class="pep-group-header">
              <div class="pep-group-name">${group.name}</div>
              <div class="pep-group-timing">${group.timing}</div>
            </div>

            ${pepRows.map(row => html`
              <div class="pep-row">
                <div class="pep-label" style="color:${row.color}">${row.pep.name}</div>
                <div class="pep-timeline">
                  ${row.dots.map(d => html`
                    <div class="pep-dot ${d.status}" style="${d.status === 'missed' ? `border-color:${d.color}` : `background:${d.color}`}"></div>
                  `)}
                </div>
              </div>
              <div class="pep-dose-info">
                ${row.pep.dose_mg}mg (${row.pep.dose_units}u) ${row.pep.route}
                ${row.cycleStatus ? html`
                  <span class="pep-cycle-badge ${row.cycleStatus.inOn ? 'active' : 'off-cycle'}">
                    ${row.cycleStatus.inOn ? 'On' : 'Off'} cycle ${row.cycleStatus.cycleNumber}
                    \u2022 Day ${row.cycleStatus.dayNum}/${row.cycleStatus.totalDays}
                  </span>
                ` : ''}
              </div>
            `)}

            <div class="pep-stats">
              <div class="pep-stat">
                <div class="pep-stat-value">${totalTaken}</div>
                <div class="pep-stat-label">Taken</div>
              </div>
              <div class="pep-stat">
                <div class="pep-stat-value">${totalMissed}</div>
                <div class="pep-stat-label">Missed</div>
              </div>
              <div class="pep-stat">
                <div class="pep-stat-value">${compliance}%</div>
                <div class="pep-stat-label">Compliance</div>
              </div>
            </div>
          </div>

          <div class="pep-legend">
            <div class="pep-legend-item">
              <div class="pep-legend-dot" style="background:var(--accent)"></div> Taken
            </div>
            <div class="pep-legend-item">
              <div class="pep-legend-dot" style="background:transparent;border:1.5px solid var(--accent)"></div> Missed
            </div>
            <div class="pep-legend-item">
              <div class="pep-legend-dot" style="background:var(--accent);opacity:0.45"></div> Off-schedule
            </div>
            <div class="pep-legend-item">
              <div class="pep-legend-dot" style="background:var(--border);opacity:0.4;height:6px;align-self:flex-end"></div> No injection
            </div>
          </div>
        </div>
      `;
    });

    return groupCards;
  }

  render() {
    const avgs = this._getAverages();
    return html`
      <div class="header">
        <h2 class="title">Trends</h2>
        <div class="period-selector">
          ${['30d', '90d', '1y', 'all'].map(p => html`
            <button
              class="period-btn ${this.period === p ? 'active' : ''}"
              @click=${() => this._setPeriod(p)}
            >${p === 'all' ? 'All' : p}</button>
          `)}
        </div>
      </div>

      ${this.loading ? html`
        <div class="loading-text">Loading trend data...</div>
      ` : html`
        <div class="charts-grid">
          <div class="chart-card">
            <div class="chart-title">Mood</div>
            <div class="chart-container">
              ${this._moodData && this._moodData.length > 0
                ? html`<canvas id="moodChart"></canvas>`
                : html`<div class="no-data">No mood data yet</div>`}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-title">Night Wake-Ups</div>
            <div class="chart-container">
              ${this._moodData && this._moodData.some(d => d.wakeUps !== null && d.wakeUps !== undefined)
                ? html`<canvas id="wakeUpsChart"></canvas>`
                : html`<div class="no-data">No wake-up data yet</div>`}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-title">Sleep Duration</div>
            ${avgs.sleepAvg ? html`<div class="chart-avg">Avg: <span>${avgs.sleepAvg.toFixed(1)}h</span> per night</div>` : ''}
            <div class="chart-container">
              ${this._sleepData && this._sleepData.length > 0
                ? html`<canvas id="sleepChart"></canvas>`
                : html`<div class="no-data">No sleep data</div>`}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-title">Resting Heart Rate</div>
            ${avgs.hrAvg ? html`<div class="chart-avg">Avg: <span>${Math.round(avgs.hrAvg)} bpm</span></div>` : ''}
            <div class="chart-container">
              ${this._vitalsData && this._vitalsData.length > 0
                ? html`<canvas id="hrChart"></canvas>`
                : html`<div class="no-data">No heart rate data</div>`}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-title">HRV</div>
            ${avgs.hrvAvg ? html`<div class="chart-avg">Avg: <span>${Math.round(avgs.hrvAvg)} ms</span></div>` : ''}
            <div class="chart-container">
              ${this._vitalsData && this._vitalsData.length > 0
                ? html`<canvas id="hrvChart"></canvas>`
                : html`<div class="no-data">No HRV data</div>`}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-title">Steps per Day</div>
            ${avgs.stepsAvg ? html`<div class="chart-avg">Avg: <span>${Math.round(avgs.stepsAvg).toLocaleString()}</span> steps/day</div>` : ''}
            <div class="chart-container">
              ${this._activityData && this._activityData.length > 0
                ? html`<canvas id="stepsChart"></canvas>`
                : html`<div class="no-data">No step data</div>`}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-title">Exercise Frequency</div>
            <div class="chart-avg">Avg: <span>${avgs.workoutsPerWeek.toFixed(1)}</span> sessions/week (${avgs.totalWorkouts} total)</div>
            <div class="chart-container">
              ${this._workoutsData && this._workoutsData.length > 0
                ? html`<canvas id="exerciseChart"></canvas>`
                : html`<div class="no-data">No workout data</div>`}
            </div>
          </div>

          ${avgs.moodSleepPoints >= 3 ? html`
            <div class="chart-card">
              <div class="chart-title">Mood vs Sleep</div>
              <div class="chart-avg">Correlation: <span>${avgs.moodSleepCorr > 0.3 ? 'Positive' : avgs.moodSleepCorr < -0.3 ? 'Negative' : 'Weak'}</span> (r=${avgs.moodSleepCorr.toFixed(2)}, ${avgs.moodSleepPoints} days)</div>
              <div class="chart-container">
                <canvas id="moodSleepChart"></canvas>
              </div>
            </div>
          ` : ''}

          <div class="chart-card">
            <div class="chart-title">Weight Trend</div>
            ${avgs.weightAvg ? html`<div class="chart-avg">Avg: <span>${avgs.weightAvg.toFixed(1)} kg</span></div>` : ''}
            <div class="chart-container">
              ${this._weightData && this._weightData.length > 0
                ? html`<canvas id="weightChart"></canvas>`
                : html`<div class="no-data">No weight data</div>`}
            </div>
          </div>

          ${this._renderPeptideTimeline()}
        </div>
      `}
    `;
  }
}

customElements.define('trends-view', TrendsView);
