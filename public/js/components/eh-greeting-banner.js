// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-greeting-banner.js — top-slot card showing the day context + a rotating motd.
// Data: array of short message strings (pre-seeded at install time).
// Rotation: once per day, on the first today-view render, pop messages[0], push it
//           to the end, and POST the new order back. A bare YYYY-MM-DD stamp in
//           localStorage guards it to at most one rotation per day. Rotation only
//           happens when the card is writeable (meta.writeable.fromWebapp); a
//           read-only greeting shows the message but never writes.
//
// When rendered on a non-today date, shows just the date context (no message rotation).

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard, invalidateManifestCache } from './eh-base-card.js';
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

  _rotationStampKey() {
    return `eh:${this.card.id}:lastRot`;
  }

  // Claim today's rotation atomically. localStorage is synchronous, so the
  // read-then-write here runs to completion before any other greeting
  // instance can interleave — the view renderer recreates the element on
  // every view re-render, so two instances can both reach _maybeRotate in
  // the same tick before the first POST resolves. The stamp is the
  // cross-instance guard; the bare YYYY-MM-DD clears itself at day rollover.
  _claimRotationToday() {
    try {
      if (localStorage.getItem(this._rotationStampKey()) === _today()) return false;
      localStorage.setItem(this._rotationStampKey(), _today());
      return true;
    } catch {
      // No localStorage (private mode / disabled) — fall back to the
      // per-instance guard only, accepting a possible extra POST.
      return true;
    }
  }

  async _maybeRotate() {
    if (this._rotating || !Array.isArray(this.data) || this.data.length < 2) return;
    // Read-only greeting cards render the message but never write it back.
    if (!this._meta.writeable?.fromWebapp) return;
    if (!this._claimRotationToday()) return;
    this._rotating = true;
    // Rotate: shift first -> push at end
    const rotated = this.data.slice();
    const first = rotated.shift();
    rotated.push(first);
    try {
      const r = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: rotated }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      invalidateManifestCache(this.card.id);
      this.data = rotated;
    } catch (e) {
      console.warn('[greeting] rotation failed:', e.message);
    } finally {
      this._rotating = false;
    }
  }
}
customElements.define('eh-greeting-banner', EhGreetingBanner);
registerRenderer('greeting-banner', 'eh-greeting-banner');
