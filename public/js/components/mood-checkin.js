import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { api, today } from '../api.js';

class MoodCheckin extends LitElement {
  static properties = {
    _show: { state: true },
    _selected: { state: true },
    _notes: { state: true },
    _wakeUps: { state: true },
    _saving: { state: true },
  };

  static styles = css`
    :host { display: block; }

    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 20px;
      padding: 32px 28px;
      max-width: 380px;
      width: 100%;
      text-align: center;
      animation: slideUp 0.3s ease;
    }

    @keyframes slideUp {
      from { transform: translateY(30px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .greeting {
      font-size: 14px;
      color: #64748b;
      margin-bottom: 6px;
    }

    .question {
      font-size: 20px;
      font-weight: 700;
      color: #1e293b;
      margin-bottom: 24px;
    }

    .moods {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-bottom: 20px;
    }

    .mood-btn {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: 2px solid #e2e8f0;
      background: transparent;
      font-size: 28px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .mood-btn:hover {
      border-color: #94a3b8;
      transform: scale(1.1);
    }

    .mood-btn.selected {
      border-color: #0ea5e9;
      background: rgba(0, 212, 170, 0.1);
      transform: scale(1.15);
      box-shadow: 0 0 16px rgba(14, 165, 233, 0.15);
    }

    .mood-label {
      font-size: 10px;
      color: #94a3b8;
      margin-top: 4px;
    }

    .mood-col {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .notes-input {
      width: 100%;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px 14px;
      color: #1e293b;
      font-size: 16px;
      font-family: inherit;
      outline: none;
      resize: none;
      height: 60px;
      margin-bottom: 20px;
      box-sizing: border-box;
    }

    .notes-input:focus { border-color: #0ea5e9; }
    .notes-input::placeholder { color: #94a3b8; }

    .actions {
      display: flex;
      gap: 10px;
      justify-content: center;
    }

    .save-btn {
      background: #0ea5e9;
      color: #f5f7fa;
      border: none;
      border-radius: 10px;
      padding: 10px 28px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }

    .save-btn:hover { background: #38bdf8; }
    .save-btn:disabled { background: #e2e8f0; color: #94a3b8; cursor: not-allowed; }

    .skip-btn {
      background: transparent;
      color: #94a3b8;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px 20px;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .skip-btn:hover { border-color: #94a3b8; color: #aaa; }

    .wakeup-section {
      margin-bottom: 20px;
    }

    .wakeup-label {
      font-size: 14px;
      color: #475569;
      margin-bottom: 10px;
    }

    .wakeup-counter {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
    }

    .wakeup-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 2px solid #e2e8f0;
      background: transparent;
      color: #475569;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .wakeup-btn:hover { border-color: #0ea5e9; color: #0ea5e9; }
    .wakeup-btn:disabled { opacity: 0.3; cursor: not-allowed; }

    .wakeup-value {
      font-size: 28px;
      font-weight: 700;
      min-width: 40px;
      text-align: center;
    }

    .wakeup-value.good { color: #22c55e; }
    .wakeup-value.ok { color: #f59e0b; }
    .wakeup-value.bad { color: #ef4444; }
    .wakeup-value.none { color: #94a3b8; }

    .wakeup-skip {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 6px;
      cursor: pointer;
    }

    .wakeup-skip:hover { color: #888; }
  `;

  static MOODS = [
    { value: 1, emoji: '\u{1F629}', label: 'Awful' },
    { value: 2, emoji: '\u{1F634}', label: 'Tired' },
    { value: 3, emoji: '\u{1F610}', label: 'Meh' },
    { value: 4, emoji: '\u{1F642}', label: 'Good' },
    { value: 5, emoji: '\u{1F604}', label: 'Great' },
  ];

  constructor() {
    super();
    this._show = false;
    this._selected = null;
    this._notes = '';
    this._wakeUps = null;
    this._saving = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._checkIfNeeded();
  }

  async _checkIfNeeded() {
    const todayStr = today();

    // Check localStorage for dismissed today
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('resetmood') === '1') {
      localStorage.removeItem('mood-checkin-date');
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    }
    const dismissed = localStorage.getItem('mood-checkin-date');
    if (dismissed === todayStr) return;

    // Check if already submitted today
    try {
      const existing = await api.mood(todayStr);
      if (existing && existing.mood) {
        localStorage.setItem('mood-checkin-date', todayStr);
        return;
      }
    } catch {}

    // Show after a short delay for smooth UX
    setTimeout(() => { this._show = true; }, 500);
  }

  async _save() {
    if (!this._selected || this._saving) return;
    this._saving = true;
    try {
      await api.saveMood(today(), this._selected, this._notes, this._wakeUps);
      localStorage.setItem('mood-checkin-date', today());
      this._show = false;
      // Dispatch event so sleep card can pick up the mood
      window.dispatchEvent(new CustomEvent('mood-updated'));
    } catch (e) {
      console.error('Mood save error:', e);
    }
    this._saving = false;
  }

  _skip() {
    localStorage.setItem('mood-checkin-date', today());
    this._show = false;
  }

  _getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  render() {
    if (!this._show) return html``;

    return html`
      <div class="overlay">
        <div class="modal">
          <div class="greeting">${this._getGreeting()}, Eddy</div>
          <div class="question">How are you feeling?</div>
          <div class="moods">
            ${MoodCheckin.MOODS.map(m => html`
              <div class="mood-col">
                <button
                  class="mood-btn ${this._selected === m.value ? 'selected' : ''}"
                  @click=${() => this._selected = m.value}
                >${m.emoji}</button>
                <span class="mood-label">${m.label}</span>
              </div>
            `)}
          </div>
          <textarea
            class="notes-input"
            placeholder="Any notes? (optional)"
            .value=${this._notes}
            @input=${(e) => this._notes = e.target.value}
          ></textarea>
          <div class="wakeup-section">
            <div class="wakeup-label">How many times did you wake up?</div>
            <div class="wakeup-counter">
              <button class="wakeup-btn" ?disabled=${this._wakeUps === null || this._wakeUps <= 0} @click=${(e) => { e.stopPropagation(); if (this._wakeUps > 0) this._wakeUps--; }}>−</button>
              <span class="wakeup-value ${this._wakeUps === null ? 'none' : this._wakeUps <= 1 ? 'good' : this._wakeUps <= 3 ? 'ok' : 'bad'}">
                ${this._wakeUps === null ? '–' : this._wakeUps}
              </span>
              <button class="wakeup-btn" @click=${(e) => { e.stopPropagation(); this._wakeUps = (this._wakeUps === null ? 0 : this._wakeUps) + 1; }}>+</button>
            </div>
            ${this._wakeUps === null ? html`<div class="wakeup-skip" @click=${(e) => { e.stopPropagation(); this._wakeUps = 0; }}>Tap + to start counting</div>` : ''}
          </div>
          <div class="actions">
            <button class="skip-btn" @click=${this._skip}>Skip</button>
            <button class="save-btn" ?disabled=${!this._selected || this._saving} @click=${this._save}>
              ${this._saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('mood-checkin', MoodCheckin);
