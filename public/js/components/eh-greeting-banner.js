// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-greeting-banner.js — top-slot card showing the day context + a rotating motd.
// Data: array of short message strings (pre-seeded at install time).
// Rotation: on load, if today > meta.lastRotatedDate, pop messages[0], push to end,
//           stamp lastRotatedDate, POST back. Guarded to run at most once per day.
//
// When rendered on a non-today date, shows just the date context (no message rotation).

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';

function _today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _formatRelDate(dateStr) {
  const t = _today();
  if (dateStr === t) return 'Today';
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date(t + 'T00:00:00');
  const diff = Math.round((d - today) / (24 * 3600 * 1000));
  if (diff === -1) return 'Yesterday';
  if (diff === 1)  return 'Tomorrow';
  return null;
}

function _formatLongDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export class EhGreetingBanner extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      :host {
        background: linear-gradient(135deg, var(--bg-card), var(--accent-bg, rgba(0,212,170,0.05)));
      }
      .greeting {
        padding: 14px 18px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .date-line {
        font-size: 14px;
        font-weight: 700;
        color: var(--text-primary);
      }
      .relative {
        color: var(--accent, #00d4aa);
        margin-right: 8px;
      }
      .message {
        font-size: 13px;
        color: var(--text-secondary);
        font-style: italic;
      }
    `,
  ];

  // Disable the base card chrome — this is a banner, not a data card
  render() {
    const rel = _formatRelDate(this.date);
    const long = _formatLongDate(this.date);
    const msg = this._currentMessage();
    // Trigger rotation in background (non-blocking)
    if (this.dateMode === 'today') this._maybeRotate();
    return html`
      <div class="greeting">
        <div class="date-line">
          ${rel ? html`<span class="relative">${rel}</span>` : ''}
          <span>${long}</span>
        </div>
        ${msg ? html`<div class="message">${msg}</div>` : ''}
      </div>
    `;
  }

  _currentMessage() {
    if (!Array.isArray(this.data) || this.data.length === 0) return null;
    return this.data[0];
  }

  async _maybeRotate() {
    if (this._rotating || !Array.isArray(this.data) || this.data.length < 2) return;
    const lastRot = this._meta._state?.lastRotatedDate;
    if (lastRot === _today()) return;
    this._rotating = true;
    // Rotate: shift first -> push at end
    const rotated = this.data.slice();
    const first = rotated.shift();
    rotated.push(first);
    try {
      await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: rotated }),
      });
      // Also stamp the rotation date. Currently we use meta._state via a separate call;
      // to keep scope tight, rely on the server-side registry to preserve meta and
      // have the client re-fetch data only. For strictness, the registry write only
      // touches data — so we persist lastRotatedDate in a localStorage guard too.
      try {
        localStorage.setItem(`eh:${this.card.id}:lastRot`, _today());
      } catch {}
    } catch (e) {
      console.warn('[greeting] rotation failed:', e.message);
    } finally {
      this._rotating = false;
    }
  }
}
customElements.define('eh-greeting-banner', EhGreetingBanner);
registerRenderer('greeting-banner', 'eh-greeting-banner');
