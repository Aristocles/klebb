// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-greeting-banner.js — top-slot card showing the day context + a rotating motd.
// Data: array of short message strings (pre-seeded at install time).
// Rotation: the shown message is a pure function of the viewed date
//           (days-since-epoch modulo message count), so it advances once per
//           calendar day, is identical on every device, and never writes
//           anything back. Rotation used to be a data write gated on
//           meta.writeable.fromWebapp, which froze every read-only greeting
//           on messages[0] forever (#704); docs/CARDS.md has always
//           documented this renderer as "Writes: None".

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

  // The viewed date picks the message deterministically. UTC-anchored so
  // the day index is an exact integer regardless of the browser timezone
  // or DST; the date string itself is already the user's local calendar
  // date, supplied by the view.
  _currentMessage() {
    if (!Array.isArray(this.data) || this.data.length === 0) return null;
    const dayIndex = Math.floor(new Date(`${this.date || _today()}T00:00:00Z`).getTime() / 86400000);
    return this.data[dayIndex % this.data.length];
  }
}
customElements.define('eh-greeting-banner', EhGreetingBanner);
registerRenderer('greeting-banner', 'eh-greeting-banner');
