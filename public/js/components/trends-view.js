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
    return {
      text: s.getPropertyValue('--text-secondary').trim() || '#64748b',
      grid: s.getPropertyValue('--chart-grid').trim() || '#e2e8f0',
      bg: s.getPropertyValue('--bg-card').trim() || '#ffffff',
      title: s.getPropertyValue('--text-primary').trim() || '#1e293b',
      body: s.getPropertyValue('--text-secondary').trim() || '#64748b',
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyAllCharts();
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
      const [sleepData, vitalsData, activityData, weightData, workoutsData, moodData] = await Promise.all([
        api.sleepRange(start, end),
        api.vitalsRange(start, end),
        api.activityRange(start, end),
        api.weightRange(start, end),
        api.workoutsRange(start, end),
        api.moodRange(start, end),
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
    } catch {
      this._sleepData = [];
      this._vitalsData = [];
      this._activityData = [];
      this._weightData = [];
      this._workoutsData = [];
      this._moodData = {};
      this._moodData = [];
    }

    this.loading = false;

    await this.updateComplete;
    this._renderAllCharts();
  }

  _renderMoodSleepChart() {
    const canvas = this._getCanvas('moodSleepChart');
    if (!canvas) return;

    // Build correlated data: mood + sleep on same date
    const points = [];
    const moodLabels = { 1: 'Awful', 2: 'Tired', 3: 'Meh', 4: 'Good', 5: 'Great' };
    const moodColors = { 1: 'var(--danger)', 2: '#ff8844', 3: 'var(--warning)', 4: 'var(--success)', 5: 'var(--accent)' };

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
    const labels = this._weightData.map(d => this._formatDateLabel(d.date));
    const values = this._weightData.map(d => d.kg);

    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, 'rgba(14, 165, 233, 0.2)');
    gradient.addColorStop(1, 'rgba(0, 212, 170, 0.0)');

    this._destroyChart('weightChart');
    this._charts['weightChart'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: 'var(--accent)',
          backgroundColor: gradient,
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: 'var(--accent)',
          pointBorderColor: 'var(--accent)',
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
            backgroundColor: '#1e3a5f',
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
          borderColor: 'var(--danger)',
          backgroundColor: 'rgba(255, 68, 68, 0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: 'var(--danger)',
          pointBorderColor: 'var(--danger)',
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
          borderColor: 'var(--success)',
          backgroundColor: 'rgba(68, 255, 136, 0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: 'var(--success)',
          pointBorderColor: 'var(--success)',
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
            backgroundColor: 'rgba(0, 212, 170, 0.5)',
            borderRadius: 2,
            order: 2,
          },
          {
            type: 'line',
            data: movingAvg,
            borderColor: 'var(--accent)',
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
          backgroundColor: 'var(--warning)',
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
    const labels = this._moodData.map(d => this._formatDateLabel(d.date));
    const values = this._moodData.map(d => d.mood || null);

    const moodColors = { 1: 'var(--danger)', 2: '#ff8844', 3: 'var(--warning)', 4: '#88cc44', 5: 'var(--success)' };
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
    const labels = filtered.map(d => this._formatDateLabel(d.date));
    const values = filtered.map(d => d.wakeUps);
    const barColors = values.map(v => v <= 1 ? 'var(--success)' : v <= 3 ? 'var(--warning)' : 'var(--danger)');

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
        </div>
      `}
    `;
  }
}

customElements.define('trends-view', TrendsView);
