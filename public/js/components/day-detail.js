import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, formatDate, formatHours, calculateIntensity, classifyWorkout } from '../api.js';
import './info-panel.js';

class DayDetail extends LitElement {
  static properties = {
    date: { type: String },
    _sleep: { state: true },
    _workouts: { state: true },
    _activity: { state: true },
    _vitals: { state: true },
    _info: { state: true },
    _config: { state: true },
    _supplements: { state: true },
    _peptides: { state: true },
    _weight: { state: true },
    _injectionLog: { state: true },
    _mood: { state: true },
    _notes: { state: true },
    _notesSaving: { state: true },
    _slideClass: { state: true },
    _editingMood: { state: true },
    _moodSelected: { state: true },
    _moodNotes: { state: true },
    _moodWakeUps: { state: true },
    _moodSaving: { state: true },
    _loading: { state: true },
  };

  static styles = css`
    :host { display: block; overflow-x: hidden; }

    .content-wrapper {
      transition: transform 0.25s ease, opacity 0.25s ease;
    }

    .content-wrapper.slide-left {
      transform: translateX(-100%);
      opacity: 0;
    }

    .content-wrapper.slide-right {
      transform: translateX(100%);
      opacity: 0;
    }

    .content-wrapper.slide-in-from-left {
      animation: slideInFromLeft 0.25s ease forwards;
    }

    .content-wrapper.slide-in-from-right {
      animation: slideInFromRight 0.25s ease forwards;
    }

    @keyframes slideInFromLeft {
      from { transform: translateX(-60px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    @keyframes slideInFromRight {
      from { transform: translateX(60px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .top-bar {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      margin: 0 0 20px 0;
    }

    .top-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .calendar-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 13px;
      padding: 6px 14px;
      cursor: pointer;
      transition: color 0.2s, border-color 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .calendar-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    .today-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 13px;
      padding: 6px 14px;
      cursor: pointer;
      transition: color 0.2s, border-color 0.2s;
    }

    .today-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    .date-header {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
      text-align: center;
      flex: 1;
    }

    .nav-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 18px;
      padding: 6px 12px;
      cursor: pointer;
      transition: color 0.2s, border-color 0.2s;
      flex-shrink: 0;
    }

    .nav-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    .cards {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
    }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin: 0 0 12px 0;
    }

    .loading-text {
      color: var(--text-secondary);
      font-size: 14px;
    }

    /* Sleep */
    .sleep-total {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0 0 12px 0;
    }

    .bar-container {
      display: flex;
      height: 10px;
      border-radius: 5px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .bar-segment {
      height: 100%;
      transition: width 0.4s ease;
    }

    .sleep-times {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }

    .sleep-stages {
      font-size: 12px;
      color: var(--text-secondary);
    }

    /* Workouts */
    .workout-item {
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }

    .workout-item:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .workout-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }

    .workout-icon {
      font-size: 20px;
      flex-shrink: 0;
    }

    .workout-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      flex: 1;
    }

    .workout-intensity {
      font-size: 20px;
      flex-shrink: 0;
    }

    .workout-meta {
      font-size: 13px;
      color: var(--text-secondary);
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 4px;
      padding-left: 30px;
    }

    .workout-meta span {
      white-space: nowrap;
    }

    .workout-time {
      color: var(--text-secondary);
    }

    .workout-duration {
      color: var(--accent);
      font-weight: 600;
    }

    .workout-hr {
      color: #ff6b6b;
    }

    .workout-cal {
      color: var(--warning);
    }

    /* Activity */
    .stats-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    .stat {
      flex: 1;
      text-align: center;
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 22px;
      font-weight: 700;
    }

    .stat-unit {
      font-size: 13px;
      font-weight: 400;
      opacity: 0.7;
    }

    .steps-color { color: var(--accent); }
    .distance-color { color: var(--warning); }
    .energy-color { color: #6366f1; }

    /* Vitals */
    .vitals-grid {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    .vital-item {
      flex: 1;
      text-align: center;
    }

    .vital-label {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .vital-value {
      font-size: 22px;
      font-weight: 700;
      color: #a78bfa;
    }

    .vital-unit {
      font-size: 12px;
      font-weight: 400;
      opacity: 0.7;
    }

    /* Supplements */
    .supplement-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .supplement-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .supplement-icon {
      font-size: 16px;
      width: 24px;
      text-align: center;
      flex-shrink: 0;
    }

    .supplement-name {
      font-size: 14px;
      color: var(--text-primary);
    }

    .supplement-dose {
      font-size: 12px;
      color: var(--text-secondary);
      margin-left: auto;
      white-space: nowrap;
    }

    /* Info */
    .info-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .info-item {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }

    .info-icon {
      font-size: 20px;
      flex-shrink: 0;
    }

    .info-body {
      flex: 1;
      min-width: 0;
    }

    .info-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 2px;
    }

    .info-title a {
      color: var(--accent);
      text-decoration: none;
    }

    .info-title a:hover {
      text-decoration: underline;
    }

    .info-summary {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    /* Weight */
    .weight-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .weight-unit {
      font-size: 14px;
      font-weight: 400;
      color: var(--text-secondary);
    }

    .empty-text {
      color: var(--text-muted);
      font-size: 13px;
    }

    .edit-mood-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text-secondary);
      font-size: 18px;
      cursor: pointer;
      padding: 6px 10px;
      transition: all 0.2s;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .edit-mood-btn:hover { border-color: var(--accent); color: var(--accent); }

    .edit-mood-btn .btn-label {
      font-size: 11px;
      font-weight: 600;
    }

    /* Mood card */
    .mood-display {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .mood-display-emoji {
      font-size: 28px;
    }

    .mood-display-info {
      flex: 1;
    }

    .mood-display-label {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .mood-display-notes {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 2px;
    }

    .mood-display-wakeups {
      font-size: 13px;
      margin-top: 4px;
    }

    /* Mood editor */
    .mood-editor {
      padding: 8px 0;
    }

    .mood-editor-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 16px;
    }

    .mood-editor .moods {
      display: flex;
      justify-content: center;
      gap: 10px;
      margin-bottom: 16px;
    }

    .mood-editor .mood-col {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .mood-editor .mood-btn {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 2px solid var(--border);
      background: transparent;
      font-size: 24px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .mood-editor .mood-btn:hover { border-color: var(--text-muted); transform: scale(1.1); }
    .mood-editor .mood-btn.selected { border-color: var(--accent); background: rgba(14,165,233,0.1); transform: scale(1.15); }
    .mood-editor .mood-label { font-size: 9px; color: var(--text-muted); margin-top: 3px; }

    .mood-editor .notes-input {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      color: var(--text-primary);
      font-size: 16px;
      font-family: inherit;
      outline: none;
      resize: none;
      height: 50px;
      margin-bottom: 12px;
      box-sizing: border-box;
    }

    .mood-editor .notes-input:focus { border-color: var(--accent); }
    .mood-editor .notes-input::placeholder { color: var(--text-muted); }

    .mood-editor .wakeup-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      margin-bottom: 16px;
    }

    .mood-editor .wakeup-label {
      font-size: 13px;
      color: var(--text-secondary);
    }

    .mood-editor .wakeup-btn {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 2px solid var(--border);
      background: transparent;
      color: var(--text-secondary);
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .mood-editor .wakeup-btn:hover { border-color: var(--accent); color: var(--accent); }

    .mood-editor .wakeup-value {
      font-size: 22px;
      font-weight: 700;
      min-width: 30px;
      text-align: center;
    }

    .mood-editor .wakeup-value.good { color: var(--success); }
    .mood-editor .wakeup-value.ok { color: var(--warning); }
    .mood-editor .wakeup-value.bad { color: var(--danger); }
    .mood-editor .wakeup-value.none { color: var(--text-muted); }

    .mood-editor .editor-actions {
      display: flex;
      gap: 10px;
      justify-content: center;
    }

    .mood-editor .save-btn {
      background: var(--accent);
      color: var(--text-inverse);
      border: none;
      border-radius: 10px;
      padding: 8px 24px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .mood-editor .save-btn:disabled { background: var(--bg-disabled); color: var(--text-disabled); cursor: not-allowed; }
    .mood-editor .save-btn:hover:not(:disabled) { background: var(--accent-hover); }

    .mood-editor .cancel-btn {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 18px;
      font-size: 13px;
      cursor: pointer;
    }

    .mood-editor .cancel-btn:hover { border-color: var(--text-muted); color: #aaa; }

    .mood-editor .clear-btn {
      background: transparent;
      color: var(--danger);
      border: 1px solid #442222;
      border-radius: 10px;
      padding: 8px 18px;
      font-size: 13px;
      cursor: pointer;
    }

    .mood-editor .clear-btn:hover { border-color: var(--danger); }

    /* Notes card */
    .notes-textarea {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      color: var(--text-primary);
      font-size: 16px;
      font-family: inherit;
      outline: none;
      resize: vertical;
      min-height: 80px;
      box-sizing: border-box;
      line-height: 1.5;
    }

    .notes-textarea:focus { border-color: var(--accent); }
    .notes-textarea::placeholder { color: var(--text-muted); }

    .notes-status {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 6px;
      text-align: right;
      transition: color 0.2s;
    }

    .notes-status.saving { color: var(--warning); }
    .notes-status.saved { color: var(--success); }

    /* Peptides / Injections */
    .peptide-grid {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .peptide-item {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .cycle-ring {
      position: relative;
      width: 48px;
      height: 48px;
      flex-shrink: 0;
    }

    .cycle-ring svg {
      width: 48px;
      height: 48px;
      transform: rotate(-90deg);
    }

    .cycle-ring-bg {
      fill: none;
      stroke: var(--border);
      stroke-width: 4;
    }

    .cycle-ring-progress {
      fill: none;
      stroke-width: 4;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.5s ease;
    }

    .cycle-ring-label {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .peptide-info {
      flex: 1;
      min-width: 0;
    }

    .peptide-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 2px;
    }

    .peptide-dose {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 2px;
    }

    .peptide-cycle-text {
      font-size: 11px;
      color: var(--text-muted);
    }

    .peptide-status {
      font-size: 12px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      flex-shrink: 0;
    }

    .status-active {
      background: rgba(0, 212, 170, 0.15);
      color: var(--accent);
    }

    .status-off {
      background: rgba(136, 136, 170, 0.15);
      color: var(--text-secondary);
    }

    .status-loading {
      background: rgba(255, 170, 0, 0.15);
      color: var(--warning);
    }

    .status-maint {
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
    }

    .mounjaro-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-top: 1px solid var(--border);
      margin-top: 4px;
    }

    .mounjaro-icon {
      font-size: 20px;
    }

    .mounjaro-text {
      font-size: 14px;
      color: var(--text-primary);
    }

    .mounjaro-dose {
      font-size: 12px;
      color: var(--text-secondary);
      margin-left: auto;
    }

    /* Weekly schedule dots */
    .week-schedule {
      display: flex;
      gap: 4px;
      align-items: center;
      margin-top: 6px;
    }

    .week-dot {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      transition: all 0.2s;
    }

    .week-dot.inactive {
      background: var(--bg-card);
      color: var(--text-secondary);
      border: 1px solid var(--border);
    }

    .week-dot.active {
      border: 2px solid var(--dot-color, var(--accent));
      color: var(--dot-color, var(--accent));
      background: transparent;
    }

    .week-dot.today-dot {
      box-shadow: 0 0 0 2px #f5f7fa, 0 0 0 3px var(--accent);
    }

    .week-dot.active.today-dot {
      background: var(--dot-color, var(--accent));
      color: var(--text-inverse);
    }

    /* Injection checkbox */
    .injection-check {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.08);
      cursor: pointer;
      user-select: none;
      transition: background 0.2s;
    }

    .injection-check:hover {
      background: rgba(0, 0, 0, 0.15);
    }

    .injection-checkbox {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      border: 2px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s;
    }

    .injection-checkbox.checked {
      background: var(--accent);
      border-color: var(--accent);
    }

    .injection-checkbox .check-icon {
      display: none;
      color: var(--text-inverse);
      font-size: 14px;
      font-weight: 700;
    }

    .injection-checkbox.checked .check-icon {
      display: block;
    }

    .injection-check-label {
      font-size: 13px;
      color: var(--text-secondary);
    }

    .injection-check-time {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: auto;
    }
  `;

  constructor() {
    super();
    this.date = '';
    this._sleep = null;
    this._workouts = null;
    this._activity = null;
    this._vitals = null;
    this._info = null;
    this._config = null;
    this._supplements = null;
    this._peptides = null;
    this._weight = null;
    this._injectionLog = {};
    this._mood = null;
    this._notes = '';
    this._notesSaving = false;
    this._notesTimer = null;
    this._slideClass = '';
    this._editingMood = false;
    this._moodSelected = null;
    this._moodNotes = '';
    this._moodWakeUps = null;
    this._moodSaving = false;
    this._loading = true;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.date) {
      this._fetchData();
      this._dispatchDate(this.date);
    }
    this._swipeStartX = 0;
    this._swipeStartY = 0;
    this._boundTouchStart = (e) => this._onTouchStart(e);
    this._boundTouchEnd = (e) => this._onTouchEnd(e);
    this.addEventListener('touchstart', this._boundTouchStart, { passive: true });
    this.addEventListener('touchend', this._boundTouchEnd, { passive: true });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('touchstart', this._boundTouchStart);
    this.removeEventListener('touchend', this._boundTouchEnd);
  }

  _dispatchDate(date) {
    window.dispatchEvent(new CustomEvent('day-date-changed', { detail: { date } }));
  }

  _onTouchStart(e) {
    this._swipeStartX = e.changedTouches[0].screenX;
    this._swipeStartY = e.changedTouches[0].screenY;
  }

  _onTouchEnd(e) {
    const dx = e.changedTouches[0].screenX - this._swipeStartX;
    const dy = e.changedTouches[0].screenY - this._swipeStartY;
    // Only trigger if horizontal swipe > 80px and more horizontal than vertical
    if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx > 0) {
        this._navigateDay(-1); // swipe right = previous day
      } else {
        this._navigateDay(1); // swipe left = next day
      }
    }
  }

  updated(changed) {
    if (changed.has('date') && this.date && !changed.has('_loading')) {
      this._fetchData();
    }
  }

  async _fetchData() {
    this._loading = true;
    try {
      const [sleep, workouts, activity, vitals, info, config, supplements, peptides, weight, injectionLog, mood, notes] = await Promise.all([
        api.sleep(this.date),
        api.workouts(this.date),
        api.activity(this.date),
        api.vitals(this.date),
        api.info(this.date),
        api.config(),
        api.supplements(),
        api.peptides(),
        api.weight(),
        api.injectionLog(this.date),
        api.mood(this.date),
        api.notes(this.date),
      ]);
      this._sleep = sleep || null;
      this._workouts = Array.isArray(workouts) ? workouts : [];
      this._activity = activity || null;
      this._vitals = vitals || null;
      this._info = Array.isArray(info) ? info : null;
      this._config = config || null;
      this._supplements = supplements?.current ?? null;
      this._peptides = peptides || null;
      this._weight = Array.isArray(weight) ? weight : [];
      this._injectionLog = injectionLog || {};
      this._mood = (mood && mood.mood) ? mood : null;
      this._notes = notes?.text || '';
    } catch {
      this._sleep = null;
      this._workouts = [];
      this._activity = null;
      this._vitals = null;
      this._info = null;
      this._config = null;
      this._supplements = null;
      this._weight = [];
    }
    this._loading = false;
  }

  _formatHeaderDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  _formatTime(dateStr) {
    if (!dateStr) return '--:--';
    let normalized = dateStr
      .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2')
      .replace(/\s*([+-])(\d{2})(\d{2})$/, '$1$2:$3');
    let d = new Date(normalized);
    if (isNaN(d.getTime())) d = new Date(dateStr);
    if (isNaN(d.getTime())) return '--:--';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  _formatNumber(n) {
    return n != null ? n.toLocaleString() : '0';
  }

  _getDayOfWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.getDay(); // 0=Sun, 1=Mon, ...
  }

  _getSupplementsForDate(supplements, dateStr) {
    if (!supplements) return [];
    const dayOfWeek = this._getDayOfWeek(dateStr);

    return supplements.filter(s => {
      const freq = (s.frequency || '').toLowerCase();
      if (freq === 'as needed') return false;
      if (freq === 'daily') return true;
      if (freq === 'weekly') {
        if (s.day != null) {
          if (typeof s.day === 'number') return dayOfWeek === s.day;
          const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
          return dayNames[dayOfWeek] === s.day.toLowerCase();
        }
        return dayOfWeek === 1;
      }
      if (freq.startsWith('every')) {
        const match = freq.match(/every\s+(\d+)/);
        if (match && s.startDate) {
          const interval = parseInt(match[1]);
          const start = new Date(s.startDate + 'T00:00:00');
          const target = new Date(dateStr + 'T00:00:00');
          const diffDays = Math.round((target - start) / (1000 * 60 * 60 * 24));
          return diffDays >= 0 && diffDays % interval === 0;
        }
        return true;
      }
      return true;
    });
  }

  _getWeightForDate(entries, dateStr) {
    if (!entries || entries.length === 0) return null;
    return entries.find(e => e.date === dateStr) || null;
  }

  _getIntensity() {
    if (!this._config || !this._workouts || this._workouts.length === 0) return null;
    return calculateIntensity(this._workouts, this._config);
  }

  _renderSleep() {
    if (!this._sleep) return '';

    const d = this._sleep;
    const total = d.totalSleep || 0;
    const core = d.core || 0;
    const rem = d.rem || 0;
    const deep = d.deep || 0;
    const awake = d.awake || 0;
    const sleepTotal = core + rem + deep + awake;

    const corePct = sleepTotal > 0 ? (core / sleepTotal) * 100 : 0;
    const remPct = sleepTotal > 0 ? (rem / sleepTotal) * 100 : 0;
    const deepPct = sleepTotal > 0 ? (deep / sleepTotal) * 100 : 0;
    const awakePct = sleepTotal > 0 ? (awake / sleepTotal) * 100 : 0;

    return html`
      <div class="card">
        <div class="section-title">Sleep</div>
        <div class="sleep-total">${formatHours(total)}</div>
        <div class="bar-container">
          <div class="bar-segment" style="width:${corePct}%;background:#6366f1"></div>
          <div class="bar-segment" style="width:${remPct}%;background:#a855f7"></div>
          <div class="bar-segment" style="width:${deepPct}%;background:#1e3a5f"></div>
          <div class="bar-segment" style="width:${awakePct}%;background:var(--danger)"></div>
        </div>
        <div class="sleep-times">
          ${this._formatTime(d.sleepStart)} \u2192 ${this._formatTime(d.sleepEnd)}
        </div>
        <div class="sleep-stages">
          Core ${formatHours(core)} \u00b7 REM ${formatHours(rem)} \u00b7 Deep ${formatHours(deep)} \u00b7 Awake ${formatHours(awake)}
        </div>
        ${this._renderMoodInline()}
      </div>
    `;
  }

  _onNotesInput(e) {
    this._notes = e.target.value;
    this._notesSaving = false;
    if (this._notesTimer) clearTimeout(this._notesTimer);
    this._notesTimer = setTimeout(() => this._saveNotes(), 1000);
  }

  async _saveNotes() {
    this._notesSaving = true;
    this.requestUpdate();
    try {
      await api.saveNotes(this.date, this._notes);
    } catch (e) {
      console.error('Notes save error:', e);
    }
    this._notesSaving = false;
    this.requestUpdate();
    // Show "Saved" briefly
    setTimeout(() => this.requestUpdate(), 2000);
  }

  _renderNotes() {
    return html`
      <div class="card">
        <div class="section-title">\u{1F4DD} Notes</div>
        <textarea
          class="notes-textarea"
          placeholder="Add notes for this day..."
          .value=${this._notes}
          @input=${(e) => this._onNotesInput(e)}
        ></textarea>
        <div class="notes-status ${this._notesSaving ? 'saving' : this._notes ? 'saved' : ''}">
          ${this._notesSaving ? 'Saving...' : this._notes ? 'Saved' : ''}
        </div>
      </div>
    `;
  }

  _renderMoodInline() {
    const display = this._mood ? this._getMoodDisplay(this._mood.mood) : null;
    const wakeUps = this._mood?.wakeUps;
    const hasWakeUps = wakeUps !== null && wakeUps !== undefined;
    const wakeColor = !hasWakeUps ? '' : wakeUps <= 1 ? 'var(--success)' : wakeUps <= 3 ? 'var(--warning)' : 'var(--danger)';
    const canEdit = !this._isFutureDate();

    return html`
      <div class="mood-display" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        ${display ? html`
          <span class="mood-display-emoji">${display.emoji}</span>
          <div class="mood-display-info">
            <div class="mood-display-label">Feeling ${display.label.toLowerCase()}</div>
            ${this._mood.notes ? html`<div class="mood-display-notes">${this._mood.notes}</div>` : ''}
            ${hasWakeUps ? html`
              <div class="mood-display-wakeups" style="color:${wakeColor}">
                <span style="font-weight:700">Z</span> Woke up ${wakeUps} time${wakeUps !== 1 ? 's' : ''}
              </div>
            ` : ''}
          </div>
        ` : html`
          <div class="mood-display-info" style="color:var(--text-muted);font-size:13px;">No mood recorded</div>
        `}
        ${canEdit ? html`
          <button class="edit-mood-btn" @click=${this._startEditMood} title="Edit mood" style="margin-left:auto;">\u{1F4DD}</button>
        ` : ''}
      </div>
    `;
  }

  _renderWorkouts() {
    if (!this._workouts || this._workouts.length === 0) return '';

    const intensity = this._getIntensity();

    return html`
      <div class="card">
        <div class="section-title">Workouts ${intensity ? intensity : ''}</div>
        ${this._workouts.map(w => html`
          <div class="workout-item">
            <div class="workout-header">
              <span class="workout-icon">${this._workoutTypeIcon(w.name)}</span>
              <span class="workout-name">${w.name}</span>
            </div>
            <div class="workout-meta">
              ${w.startDate && w.endDate ? html`
                <span class="workout-time">${this._formatTime(w.startDate)} \u2013 ${this._formatTime(w.endDate)}</span>
              ` : ''}
              <span class="workout-duration">${w.durationMin}m</span>
              ${w.avgHeartRate ? html`
                <span class="workout-hr">Avg ${Math.round(w.avgHeartRate)} bpm</span>
              ` : ''}
              ${w.maxHeartRate ? html`
                <span class="workout-hr">Max ${Math.round(w.maxHeartRate)} bpm</span>
              ` : ''}
              ${w.totalEnergyBurned ? html`
                <span class="workout-cal">${Math.round(w.totalEnergyBurned)} kcal</span>
              ` : ''}
            </div>
          </div>
        `)}
      </div>
    `;
  }

  _renderActivity() {
    if (!this._activity) return '';

    const steps = Math.round(this._activity.step_count?.total || 0);
    const distKm = this._activity.walking_running_distance?.total || 0;
    const energyKj = this._activity.active_energy?.total || 0;
    const energyKcal = Math.round(energyKj / 4.184);

    return html`
      <div class="card">
        <div class="section-title">Activity</div>
        <div class="stats-row">
          <div class="stat">
            <div class="stat-label">Steps</div>
            <div class="stat-value steps-color">${this._formatNumber(steps)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Distance</div>
            <div class="stat-value distance-color">${distKm.toFixed(1)}<span class="stat-unit"> km</span></div>
          </div>
          <div class="stat">
            <div class="stat-label">Energy</div>
            <div class="stat-value energy-color">${this._formatNumber(energyKcal)}<span class="stat-unit"> kcal</span></div>
          </div>
        </div>
      </div>
    `;
  }

  _renderVitals() {
    if (!this._vitals) return '';

    const hrv = this._vitals.heart_rate_variability?.avg;
    const rr = this._vitals.respiratory_rate?.avg;
    const whr = this._vitals.walking_heart_rate_average?.avg;

    if (hrv == null && rr == null && whr == null) return '';

    return html`
      <div class="card">
        <div class="section-title">Vitals</div>
        <div class="vitals-grid">
          ${hrv != null ? html`
            <div class="vital-item">
              <div class="vital-label">HRV</div>
              <div class="vital-value">${Math.round(hrv)}<span class="vital-unit"> ms</span></div>
            </div>
          ` : ''}
          ${rr != null ? html`
            <div class="vital-item">
              <div class="vital-label">Resp Rate</div>
              <div class="vital-value">${Math.round(rr)}<span class="vital-unit"> brpm</span></div>
            </div>
          ` : ''}
          ${whr != null ? html`
            <div class="vital-item">
              <div class="vital-label">Walking HR</div>
              <div class="vital-value">${Math.round(whr)}<span class="vital-unit"> bpm</span></div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  _renderSupplements() {
    const due = this._getSupplementsForDate(this._supplements, this.date);

    if (due.length === 0) {
      return html`
        <div class="card">
          <div class="section-title">Supplements</div>
          <div class="empty-text">Nothing scheduled</div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <div class="section-title">Supplements</div>
        <div class="supplement-list">
          ${due.map(s => html`
            <div class="supplement-row">
              <span class="supplement-icon">${s.colour || ''}</span>
              <span class="supplement-name">${s.name}</span>
              <span class="supplement-dose">${s.dose}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  _renderInfo() {
    if (!this._info || this._info.length === 0) return '';

    return html`
      <div class="card">
        <div class="section-title">Info</div>
        <div class="info-list">
          ${this._info.map(item => html`
            <div class="info-item">
              <span class="info-icon">${item.icon || ''}</span>
              <div class="info-body">
                <div class="info-title">
                  ${item.url
                    ? html`<a href="${item.url}">${item.title}</a>`
                    : item.title}
                </div>
                ${item.summary ? html`
                  <div class="info-summary">${item.summary}</div>
                ` : ''}
              </div>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  _renderWeight() {
    const entry = this._getWeightForDate(this._weight, this.date);
    if (!entry) return '';

    return html`
      <div class="card">
        <div class="section-title">Weight</div>
        <div class="weight-value">
          ${entry.kg.toFixed(1)} <span class="weight-unit">kg</span>
        </div>
      </div>
    `;
  }


  _getPeptideColors() {
    return {
      'BPC-157': '#2e8b57',
      'TB-500': '#4682b4',
      'CJC-1295/Ipamorelin Blend': '#9467bd',
      'Epithalon': '#d68910',
      'Tesamorelin': '#e74c3c',
      'Semax': '#e67e22',
      'Selank': '#1abc9c',
    };
  }

  _getWeekDatesForDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const wd = new Date(monday);
      wd.setDate(monday.getDate() + i);
      dates.push(wd.toLocaleDateString('en-CA'));
    }
    return dates;
  }

  _getPeptideScheduleDays(pep, weekDates) {
    // Returns array of 7 booleans: is this peptide scheduled on each day of the week?
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const sched = pep.schedule;
    if (!sched) return weekDates.map(() => false);

    return weekDates.map(dateStr => {
      const d = new Date(dateStr + 'T00:00:00');
      const dayName = dayNames[d.getDay()];

      // Check if date is within any active cycle
      let inCycle = false;
      let cycle = null;
      for (const c of (pep.cycles || [])) {
        if (c.start_date && c.end_date && dateStr >= c.start_date && dateStr <= c.end_date) {
          inCycle = true;
          cycle = c;
          break;
        }
      }
      if (!inCycle) return false;

      if (sched.type === 'daily_straight') return true;
      if (sched.type === 'on_off') return sched.on_days.includes(dayName);
      if (sched.type === 'phased') {
        const loadEnd = cycle?.phases?.loading_end;
        if (loadEnd && dateStr <= loadEnd) return sched.loading.days.includes(dayName);
        return sched.maintenance.days.includes(dayName);
      }
      return false;
    });
  }

  _getMounjaroScheduleDays(weekDates) {
    if (!this._config?.mounjaro?.day) return weekDates.map(() => false);
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const configDay = this._config.mounjaro.day.toLowerCase();
    return weekDates.map(dateStr => {
      const d = new Date(dateStr + 'T00:00:00');
      return dayNames[d.getDay()] === configDay;
    });
  }

  async _toggleInjection(peptideName) {
    const currentlyTaken = !!this._injectionLog[peptideName];
    const result = await api.toggleInjection(this.date, peptideName, !currentlyTaken);
    if (result.ok) {
      // Refresh injection log
      this._injectionLog = await api.injectionLog(this.date) || {};
    }
  }

  _getPeptidesForDate() {
    if (!this._peptides?.peptides || !this.date) return [];
    const results = [];
    const d = new Date(this.date + 'T00:00:00');
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = dayNames[d.getDay()];

    for (const pep of this._peptides.peptides) {
      if (!pep.cycles || pep.cycles.length === 0) continue;

      for (const cycle of pep.cycles) {
        if (!cycle.start_date || !cycle.end_date) continue;

        const inOnCycle = this.date >= cycle.start_date && this.date <= cycle.end_date;
        const inOffCycle = cycle.off_start && cycle.off_end && this.date >= cycle.off_start && this.date <= cycle.off_end;
        if (!inOnCycle && !inOffCycle) continue;

        const sched = pep.schedule;
        let isInjectionDay = false;
        let phase = 'on';

        if (inOnCycle && sched) {
          if (sched.type === 'daily_straight') {
            isInjectionDay = true;
          } else if (sched.type === 'on_off') {
            isInjectionDay = sched.on_days.includes(dayName);
          } else if (sched.type === 'phased') {
            const loadEnd = cycle.phases?.loading_end;
            if (loadEnd && this.date <= loadEnd) {
              isInjectionDay = sched.loading.days.includes(dayName);
              phase = 'loading';
            } else {
              isInjectionDay = sched.maintenance.days.includes(dayName);
              phase = 'maintenance';
            }
          }
        }

        let cycleDay = 0, cycleTotalDays = 0, status = 'off';
        if (inOnCycle) {
          const start = new Date(cycle.start_date + 'T00:00:00');
          const end = new Date(cycle.end_date + 'T00:00:00');
          cycleDay = Math.round((d - start) / 86400000) + 1;
          cycleTotalDays = Math.round((end - start) / 86400000) + 1;
          status = isInjectionDay ? (phase === 'loading' ? 'loading' : phase === 'maintenance' ? 'maint' : 'active') : 'rest';
        } else if (inOffCycle) {
          const offStart = new Date(cycle.off_start + 'T00:00:00');
          const offEnd = new Date(cycle.off_end + 'T00:00:00');
          cycleDay = Math.round((d - offStart) / 86400000) + 1;
          cycleTotalDays = Math.round((offEnd - offStart) / 86400000) + 1;
        }

        results.push({
          name: pep.short_name || pep.name,
          fullName: pep.name,
          dose_label: pep.dose_label || pep.dose_mg + 'mg',
          dose_units: pep.dose_units,
          route: pep.route || 'subQ',
          isInjectionDay, status, phase,
          cycleDay, cycleTotalDays,
          cycleNumber: cycle.cycle_number,
          color: this._getPeptideColors()[pep.name] || 'var(--text-secondary)',
          inOnCycle,
          nextCycleStart: cycle.next_cycle_start,
        });
      }
    }
    return results;
  }

  _renderCycleRing(pep) {
    const r = 18, circ = 2 * Math.PI * r;
    const progress = pep.cycleTotalDays > 0 ? pep.cycleDay / pep.cycleTotalDays : 0;
    const offset = circ * (1 - progress);
    const color = pep.status === 'off' ? '#555' : pep.color;
    return html`
      <div class="cycle-ring">
        <svg viewBox="0 0 48 48">
          <circle class="cycle-ring-bg" cx="24" cy="24" r="${r}"></circle>
          <circle class="cycle-ring-progress" cx="24" cy="24" r="${r}"
            stroke="${color}" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"></circle>
        </svg>
        <span class="cycle-ring-label">${pep.cycleDay}/${pep.cycleTotalDays}</span>
      </div>
    `;
  }

  _isMounjaroDay() {
    if (!this.date || !this._config?.mounjaro?.day) return false;
    const d = new Date(this.date + 'T00:00:00');
    const dow = d.getDay();
    const cd = this._config.mounjaro.day;
    if (typeof cd === 'number') return dow === cd;
    const dn = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    return dn[dow] === cd.toLowerCase();
  }

  _renderWeekDots(scheduleDays, weekDates, color) {
    const selectedDate = this.date;
    const dayLabels = ['M','T','W','T','F','S','S'];
    return html`
      <div class="week-schedule">
        ${weekDates.map((wd, i) => {
          const isActive = scheduleDays[i];
          const isToday = wd === selectedDate;
          const classes = [
            'week-dot',
            isActive ? 'active' : 'inactive',
            isToday ? 'today-dot' : '',
          ].filter(Boolean).join(' ');
          return html`<span class="${classes}" style="--dot-color: ${color}">${dayLabels[i]}</span>`;
        })}
      </div>
    `;
  }

  _renderInjectionCheckbox(peptideName) {
    const logEntry = this._injectionLog[peptideName];
    const taken = !!logEntry;
    const timeStr = logEntry?.time ? new Date(logEntry.time).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' }) : '';

    return html`
      <div class="injection-check" @click=${() => this._toggleInjection(peptideName)}>
        <div class="injection-checkbox ${taken ? 'checked' : ''}">
          <span class="check-icon">\u2713</span>
        </div>
        <span class="injection-check-label">${taken ? 'Taken' : 'Mark as taken'}</span>
        ${taken ? html`<span class="injection-check-time">${timeStr}</span>` : ''}
      </div>
    `;
  }

  _renderPeptides() {
    const pepList = this._getPeptidesForDate();
    const isMounjaro = this._isMounjaroDay();
    if (pepList.length === 0 && !this._config?.mounjaro?.day) return '';

    const weekDates = this._getWeekDatesForDate(this.date);
    const colors = this._getPeptideColors();

    const statusLabel = (s, route) => {
      const actionLabel = route === 'intranasal' ? 'Spray' : 'Inject';
      const map = { active: ['status-active', actionLabel], loading: ['status-loading','Loading'],
        maint: ['status-maint','Maint'], rest: ['status-off','Rest Day'], off: ['status-off','Off Cycle'] };
      const [cls, txt] = map[s] || ['',''];
      return html`<span class="peptide-status ${cls}">${txt}</span>`;
    };

    return html`
      <div class="card">
        <div class="section-title">Peptides</div>
        <div class="peptide-grid">
          ${pepList.map(pep => {
            const fullPep = this._peptides?.peptides?.find(p => p.name === pep.fullName || p.short_name === pep.name);
            const scheduleDays = fullPep ? this._getPeptideScheduleDays(fullPep, weekDates) : weekDates.map(() => false);
            return html`
              <div class="peptide-item">
                ${this._renderCycleRing(pep)}
                <div class="peptide-info">
                  <div class="peptide-name">${pep.name}</div>
                  ${pep.isInjectionDay
                    ? html`<div class="peptide-dose">${pep.dose_label}${pep.dose_units ? ' (' + pep.dose_units + 'u)' : ''}</div>`
                    : html`<div class="peptide-dose" style="color:var(--text-muted)">${pep.status === 'off' ? 'Next: ' + (pep.nextCycleStart || 'TBD') : 'Rest day'}</div>`}
                  <div class="peptide-cycle-text">${pep.inOnCycle
                    ? 'Cycle ' + pep.cycleNumber + ' - Day ' + pep.cycleDay + ' of ' + pep.cycleTotalDays
                    : 'Off cycle - Day ' + pep.cycleDay + ' of ' + pep.cycleTotalDays}</div>
                  ${this._renderWeekDots(scheduleDays, weekDates, pep.color)}
                  ${pep.inOnCycle ? this._renderInjectionCheckbox(pep.fullName) : ''}
                </div>
                ${statusLabel(pep.status, pep.route)}
              </div>
            `;
          })}
          ${this._config?.mounjaro?.day ? html`
            <div class="mounjaro-row" style="flex-direction:column;align-items:stretch;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="mounjaro-icon">\u{1F489}</span>
                <span class="mounjaro-text">Mounjaro</span>
                <span class="mounjaro-dose">${isMounjaro ? (this._config?.mounjaro?.dose || 'Injection day') : 'Not scheduled today'}</span>
              </div>
              ${this._renderWeekDots(this._getMounjaroScheduleDays(weekDates), weekDates, '#e74c3c')}
              ${this._renderInjectionCheckbox('Mounjaro')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }


  _workoutTypeIcon(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('running') || n.includes('run')) return '\u{1F3C3}';
    if (n.includes('cycling') || n.includes('bike')) return '\u{1F6B4}';
    if (n.includes('swimming') || n.includes('swim')) return '\u{1F3CA}';
    if (n.includes('walking') || n.includes('walk')) return '\u{1F6B6}';
    if (n.includes('yoga')) return '\u{1F9D8}';
    if (n.includes('hiit') || n.includes('interval')) return '\u26A1';
    return '\u{1F3CB}\uFE0F';
  }

  static MOODS = [
    { value: 1, emoji: '\u{1F629}', label: 'Awful' },
    { value: 2, emoji: '\u{1F634}', label: 'Tired' },
    { value: 3, emoji: '\u{1F610}', label: 'Meh' },
    { value: 4, emoji: '\u{1F642}', label: 'Good' },
    { value: 5, emoji: '\u{1F604}', label: 'Great' },
  ];

  _startEditMood() {
    if (this._isFutureDate()) return;
    this._moodSelected = this._mood?.mood || null;
    this._moodNotes = this._mood?.notes || '';
    this._moodWakeUps = this._mood?.wakeUps ?? null;
    this._editingMood = true;
  }

  _isFutureDate() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    return this.date > today;
  }

  _navigateDay(offset) {
    // Slide out
    this._slideClass = offset > 0 ? 'slide-left' : 'slide-right';
    this.requestUpdate();

    setTimeout(() => {
      const d = new Date(this.date + 'T00:00:00');
      d.setDate(d.getDate() + offset);
      const newDate = d.toLocaleDateString('en-CA');
      history.pushState(null, '', `/day/${newDate}`);
      this.date = newDate;
      this._editingMood = false;
      this._dispatchDate(newDate);

      // Slide in from opposite direction
      this._slideClass = offset > 0 ? 'slide-in-from-right' : 'slide-in-from-left';
      this._fetchData();
    }, 200);
  }

  _navigateToCalendar() {
    history.pushState(null, '', '/calendar');
    // Trigger app-level re-route
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  _navigateToToday() {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    history.pushState(null, '', `/day/${todayStr}`);
    this.date = todayStr;
    this._editingMood = false;
    this._dispatchDate(todayStr);
    this._fetchData();
  }

  _isToday() {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    return this.date === todayStr;
  }

  _cancelEditMood() {
    this._editingMood = false;
  }

  async _clearMood() {
    if (!confirm('Clear mood entry for this day?')) return;
    this._moodSaving = true;
    try {
      await fetch(`/api/mood/${this.date}`, { method: 'DELETE' });
      this._mood = null;
      this._editingMood = false;
      window.dispatchEvent(new CustomEvent('mood-updated'));
    } catch (e) {
      console.error('Mood clear error:', e);
    }
    this._moodSaving = false;
  }

  async _saveMood() {
    if (!this._moodSelected || this._moodSaving) return;
    this._moodSaving = true;
    try {
      await api.saveMood(this.date, this._moodSelected, this._moodNotes, this._moodWakeUps);
      this._mood = { mood: this._moodSelected, notes: this._moodNotes, wakeUps: this._moodWakeUps };
      this._editingMood = false;
      window.dispatchEvent(new CustomEvent('mood-updated'));
    } catch (e) {
      console.error('Mood save error:', e);
    }
    this._moodSaving = false;
  }

  _getMoodDisplay(value) {
    return DayDetail.MOODS.find(m => m.value === value);
  }

  _renderMoodCard() {
    if (this._editingMood) return this._renderMoodEditor();
    if (!this._mood) return '';

    const display = this._getMoodDisplay(this._mood.mood);
    if (!display) return '';

    const wakeUps = this._mood.wakeUps;
    const hasWakeUps = wakeUps !== null && wakeUps !== undefined;
    const wakeColor = !hasWakeUps ? '' : wakeUps <= 1 ? 'var(--success)' : wakeUps <= 3 ? 'var(--warning)' : 'var(--danger)';

    return html`
      <div class="card">
        <div class="section-title">Mood</div>
        <div class="mood-display">
          <span class="mood-display-emoji">${display.emoji}</span>
          <div class="mood-display-info">
            <div class="mood-display-label">Feeling ${display.label.toLowerCase()}</div>
            ${this._mood.notes ? html`<div class="mood-display-notes">${this._mood.notes}</div>` : ''}
            ${hasWakeUps ? html`
              <div class="mood-display-wakeups" style="color:${wakeColor}">
                <span style="font-weight:700">Z</span> Woke up ${wakeUps} time${wakeUps !== 1 ? 's' : ''}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  _renderMoodEditor() {
    return html`
      <div class="card">
        <div class="section-title">Mood</div>
        <div class="mood-editor">
          <div class="mood-editor-title">How were you feeling?</div>
          <div class="moods">
            ${DayDetail.MOODS.map(m => html`
              <div class="mood-col">
                <button class="mood-btn ${this._moodSelected === m.value ? 'selected' : ''}"
                  @click=${() => this._moodSelected = m.value}>${m.emoji}</button>
                <span class="mood-label">${m.label}</span>
              </div>
            `)}
          </div>
          <textarea class="notes-input" placeholder="Any notes? (optional)"
            .value=${this._moodNotes}
            @input=${(e) => this._moodNotes = e.target.value}></textarea>
          <div class="wakeup-row">
            <span class="wakeup-label">Wake-ups:</span>
            <button class="wakeup-btn" ?disabled=${this._moodWakeUps === null || this._moodWakeUps <= 0}
              @click=${() => { if (this._moodWakeUps > 0) this._moodWakeUps--; }}>\u2212</button>
            <span class="wakeup-value ${this._moodWakeUps === null ? 'none' : this._moodWakeUps <= 1 ? 'good' : this._moodWakeUps <= 3 ? 'ok' : 'bad'}">
              ${this._moodWakeUps === null ? '\u2013' : this._moodWakeUps}
            </span>
            <button class="wakeup-btn"
              @click=${() => this._moodWakeUps = (this._moodWakeUps === null ? 0 : this._moodWakeUps) + 1}>+</button>
          </div>
          <div class="editor-actions">
            <button class="clear-btn" @click=${this._clearMood}>Clear</button>
            <button class="cancel-btn" @click=${this._cancelEditMood}>Cancel</button>
            <button class="save-btn" ?disabled=${!this._moodSelected || this._moodSaving}
              @click=${this._saveMood}>${this._moodSaving ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    if (this._loading) {
      return html`
        <div class="top-bar">
          <div class="top-row">
            <button class="nav-btn" @click=${() => this._navigateDay(-1)}>\u25C0</button>
            <button class="today-btn" @click=${this._navigateToToday}>Today</button>
            <button class="nav-btn" @click=${() => this._navigateDay(1)}>\u25B6</button>
          </div>
        </div>
        <div class="cards">
          <div class="card">
            <div class="loading-text">Loading...</div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="top-bar">
        <div class="top-row">
          <button class="nav-btn" @click=${() => this._navigateDay(-1)}>\u25C0</button>
          <button class="today-btn" @click=${this._navigateToToday}>Today</button>
          <button class="nav-btn" @click=${() => this._navigateDay(1)}>\u25B6</button>
        </div>
      </div>
      <div class="content-wrapper ${this._slideClass || ''}">
        <div class="cards">
          ${this._editingMood ? this._renderMoodEditor() : ''}
          ${this._renderSleep()}
        ${this._renderWorkouts()}
        ${this._renderActivity()}
        ${this._renderVitals()}
        ${this._renderSupplements()}
        ${this._renderPeptides()}
        ${this._renderInfo()}
        ${this._renderWeight()}
        ${this._renderNotes()}
        </div>
      </div>
    `;
  }
}

customElements.define('day-detail', DayDetail);
