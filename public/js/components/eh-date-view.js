// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-date-view.js
// Unified DateView: renders all cards opted into view='view' for a given date.
// Handles past/today/future mode derivation, navigation (arrows, swipe, date picker),
// and the "Today" button when not on today.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './eh-view-renderer.js';
import './eh-hae-discovery-card.js';
import { isEditableTarget } from '../lib/event-target.js';

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((da - db) / (24 * 3600 * 1000));
}

export class EhDateView extends LitElement {
  static properties = {
    date: { type: String },
    _dateMode: { state: true },
    _today: { state: true },
  };

  static styles = css`
    :host { display: block; }
    .date-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 8px 0 16px;
      position: relative;
    }
    .arrow-btn {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-primary);
      width: 36px;
      height: 36px;
      border-radius: 50%;
      font-size: 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .arrow-btn:hover:not([disabled]) {
      border-color: var(--accent);
      color: var(--accent);
    }
    .arrow-btn[disabled] { opacity: 0.3; cursor: not-allowed; }
    .date-display {
      min-width: 140px;
      text-align: center;
      cursor: pointer;
      padding: 8px 14px;
      border-radius: 8px;
      user-select: none;
      transition: background 0.15s;
    }
    .date-display:hover { background: var(--bg-hover, rgba(255,255,255,0.04)); }
    .today-btn {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      background: var(--accent-bg, rgba(0,212,170,0.15));
      color: var(--accent, #00d4aa);
      border: 1px solid var(--accent, #00d4aa);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .today-btn:hover { background: var(--accent, #00d4aa); color: var(--bg-card); }
    input[type="date"] {
      background: var(--bg-card);
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      font-family: inherit;
      font-size: 13px;
    }
    .rel {
      display: inline-block;
      margin-right: 8px;
      color: var(--accent, #00d4aa);
      font-weight: 700;
    }
    @media (max-width: 500px) {
      .date-nav { gap: 8px; }
      .today-btn { position: static; transform: none; margin-left: 8px; }
    }
  `;

  constructor() {
    super();
    this._today = todayStr();
    this.date = this._today;
    this._dateMode = 'today';
    this._onKeydown = this._onKeydown.bind(this);
    this._touchStart = null;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeydown);
    this._updateMode();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeydown);
  }

  updated(changed) {
    if (changed.has('date')) this._updateMode();
  }

  _updateMode() {
    if (!this.date) { this.date = this._today; return; }
    if (this.date === this._today) this._dateMode = 'today';
    else if (this.date < this._today) this._dateMode = 'past';
    else this._dateMode = 'future';
  }

  _onKeydown(e) {
    if (isEditableTarget(e)) return;
    if (e.key === 'ArrowLeft') { this._shift(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { this._shift(+1); e.preventDefault(); }
  }

  _onTouchStart(e) {
    if (e.touches && e.touches.length === 1) this._touchStart = e.touches[0].clientX;
  }

  _onTouchEnd(e) {
    if (this._touchStart == null || !e.changedTouches || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - this._touchStart;
    this._touchStart = null;
    if (Math.abs(dx) < 60) return;
    if (dx > 0) this._shift(-1); // swipe right = previous day
    else this._shift(+1);          // swipe left = next day
  }

  _shift(delta) {
    const next = shiftDate(this.date, delta);
    // Forward-swipe cap: max 30 days from today
    if (delta > 0 && next > this._today && dayDiff(next, this._today) > 30) {
      return;
    }
    this._navigate(next);
  }

  _navigate(dateStr) {
    // Push new URL
    const path = (dateStr === this._today) ? '/' : `/day/${dateStr}`;
    window.dispatchEvent(new CustomEvent('navigate', { detail: { path } }));
  }

  _onDatePick(e) {
    const v = e.target.value;
    if (!v) return;
    // Cap 2 years future via picker
    const maxDate = shiftDate(this._today, 365 * 2);
    const minDate = '1970-01-01';
    const clamped = v > maxDate ? maxDate : (v < minDate ? minDate : v);
    this._navigate(clamped);
  }

  _formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  _relative(dateStr) {
    const diff = dayDiff(dateStr, this._today);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    return null;
  }

  render() {
    const canForwardSwipe = dayDiff(this.date, this._today) < 30;
    const maxDate = shiftDate(this._today, 365 * 2);
    const rel = this._relative(this.date);
    return html`
      <div class="date-nav" @touchstart=${this._onTouchStart} @touchend=${this._onTouchEnd}>
        <button class="arrow-btn" @click=${() => this._shift(-1)} aria-label="previous day">‹</button>
        <div class="date-display">
          <input
            type="date"
            .value=${this.date}
            max=${maxDate}
            @change=${this._onDatePick}
          />
        </div>
        <button
          class="arrow-btn"
          @click=${() => this._shift(+1)}
          ?disabled=${!canForwardSwipe}
          aria-label="next day"
        >›</button>
        ${this._dateMode !== 'today' ? html`
          <button class="today-btn" @click=${() => this._navigate(this._today)}>Today</button>
        ` : ''}
      </div>
      <eh-view-renderer
        view="view"
        .date=${this.date}
        .dateMode=${this._dateMode}
      ></eh-view-renderer>
      ${this._dateMode === 'today'
        ? html`<eh-hae-discovery-card></eh-hae-discovery-card>`
        : ''}
    `;
  }
}
customElements.define('eh-date-view', EhDateView);
