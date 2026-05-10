// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-cc-suggestion-card.js
//
// Pinned suggestion surface for combination cards. Fires when the user
// has >=3 enabled atomic cards sharing a meta.category value (e.g.
// sleep + HRV + resting HR all categorised as 'recovery'). Each
// suggestion names the specific cards and offers a single "Ask
// klebbius" action that seeds a tailored chat prompt; the agent then
// negotiates the CC manifest with the user.
//
// Server-side clustering in meta/cc-suggestions.js. This component
// only renders + drives dismissal; no heuristic lives in the client.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

const CATEGORY_META = {
  sleep:       { label: 'Sleep',        emoji: '😴' },
  recovery:    { label: 'Recovery',     emoji: '💓' },
  activity:    { label: 'Activity',     emoji: '🏃' },
  vitals:      { label: 'Vitals',       emoji: '🩺' },
  body:        { label: 'Body',         emoji: '⚖️' },
  mindfulness: { label: 'Mindfulness',  emoji: '🧘' },
  lifestyle:   { label: 'Lifestyle',    emoji: '🌿' },
  supplements: { label: 'Supplements',  emoji: '💊' },
  medication:  { label: 'Medication',   emoji: '🧪' },
};

function buildPrompt(category, cards) {
  const label = CATEGORY_META[category]?.label || category;
  const names = cards.map(c => `"${c.label || c.id}"`).join(', ');
  return `I'd like to combine my ${label.toLowerCase()} cards into a single combination card. I have ${cards.length} relevant cards: ${names}. Which combination-card layout would work best (rings, stack, etc.), which card should be the primary, and what embellishments could we add? Please propose a plan before writing the manifest.`;
}

export class EhCcSuggestionCard extends LitElement {
  static properties = {
    _suggestions: { state: true },
    _loading: { state: true },
    _busyKey: { state: true },
    _cardLabels: { state: true },   // { [id]: {label, emoji} }
  };

  constructor() {
    super();
    this._suggestions = [];
    this._loading = true;
    this._busyKey = null;
    this._cardLabels = {};
    this._onManifestChanged = this._onManifestChanged.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadAll();
    window.addEventListener('manifest-data-changed', this._onManifestChanged);
    window.addEventListener('klebb-cards-changed', this._onManifestChanged);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('manifest-data-changed', this._onManifestChanged);
    window.removeEventListener('klebb-cards-changed', this._onManifestChanged);
  }

  _onManifestChanged() {
    this._loadAll();
  }

  async _loadAll() {
    this._loading = true;
    try {
      const [suggRes, cardsRes] = await Promise.all([
        fetch('/api/cc-suggestions'),
        fetch('/api/settings/cards'),
      ]);
      if (!suggRes.ok) { this._suggestions = []; return; }
      const suggBody = await suggRes.json();
      this._suggestions = Array.isArray(suggBody.suggestions) ? suggBody.suggestions : [];

      const labels = {};
      if (cardsRes.ok) {
        const cardsBody = await cardsRes.json();
        for (const c of (cardsBody.cards || [])) {
          labels[c.id] = { label: c.label || c.id, emoji: c.emoji || '' };
        }
      }
      this._cardLabels = labels;
    } catch {
      this._suggestions = [];
    } finally {
      this._loading = false;
    }
  }

  _cardsFor(cardIds) {
    return cardIds.map(id => ({
      id,
      label: this._cardLabels[id]?.label,
      emoji: this._cardLabels[id]?.emoji || '',
    }));
  }

  _keyFor(s) {
    return `${s.category}::${[...s.cardIds].sort().join(',')}`;
  }

  async _ask(suggestion) {
    const cards = this._cardsFor(suggestion.cardIds);
    window.dispatchEvent(new CustomEvent('klebb-paste-into-chat', {
      detail: { text: buildPrompt(suggestion.category, cards) },
    }));
  }

  async _dismiss(suggestion) {
    const key = this._keyFor(suggestion);
    this._busyKey = key;
    try {
      const r = await fetch(
        `/api/cc-suggestions/${encodeURIComponent(suggestion.category)}/dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardIds: suggestion.cardIds }),
        });
      if (r.ok) {
        this._suggestions = this._suggestions.filter(s => this._keyFor(s) !== key);
      }
    } finally {
      this._busyKey = null;
    }
  }

  render() {
    if (this._loading || this._suggestions.length === 0) return html``;

    return html`
      <div class="wrap">
        ${this._suggestions.map(s => this._renderSuggestion(s))}
      </div>
    `;
  }

  _renderSuggestion(suggestion) {
    const meta = CATEGORY_META[suggestion.category] || {
      label: suggestion.category,
      emoji: '✨',
    };
    const cards = this._cardsFor(suggestion.cardIds);
    const key = this._keyFor(suggestion);
    const busy = this._busyKey === key;

    return html`
      <div class="card">
        <div class="header">
          <span class="emoji">${meta.emoji}</span>
          <span class="title">Combine into a ${meta.label} card?</span>
        </div>
        <p class="intro">
          You have ${cards.length} ${meta.label.toLowerCase()} cards that could
          work well together as a single combination card.
        </p>
        <ul class="cards">
          ${cards.map(c => html`
            <li class="card-chip">
              ${c.emoji ? html`<span class="chip-emoji">${c.emoji}</span>` : ''}
              <span class="chip-label">${c.label || c.id}</span>
            </li>
          `)}
        </ul>
        <div class="actions">
          <button
            class="btn primary"
            @click=${() => this._ask(suggestion)}
            ?disabled=${busy}
          >Ask klebbius</button>
          <button
            class="btn"
            @click=${() => this._dismiss(suggestion)}
            ?disabled=${busy}
          >Dismiss</button>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      margin-bottom: 16px;
    }
    .wrap {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--accent-amber, #ffaa33);
      border-radius: 12px;
      padding: 14px 16px 12px;
      box-shadow: 0 2px 10px rgba(255, 170, 51, 0.08);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--accent-amber, #ffaa33);
    }
    .emoji { font-size: 16px; }
    .intro {
      margin: 8px 0 10px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--text-primary);
    }
    .cards {
      list-style: none;
      padding: 0;
      margin: 0 0 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .card-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 14px;
      background: var(--bg-input, rgba(0, 0, 0, 0.04));
      border: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-primary);
    }
    .chip-emoji { font-size: 12px; }
    .chip-label { font-weight: 500; }

    .actions {
      display: inline-flex;
      gap: 8px;
    }
    .btn {
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s, color 0.12s;
    }
    .btn:hover:not(:disabled) {
      border-color: var(--accent-amber, #ffaa33);
      background: var(--bg-hover, rgba(255, 255, 255, 0.04));
    }
    .btn.primary {
      border-color: var(--accent-amber, #ffaa33);
      background: var(--accent-amber, #ffaa33);
      color: var(--bg-card);
    }
    .btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn:focus-visible {
      outline: 2px solid var(--accent-amber, #ffaa33);
      outline-offset: 2px;
    }
  `;
}

customElements.define('eh-cc-suggestion-card', EhCcSuggestionCard);
