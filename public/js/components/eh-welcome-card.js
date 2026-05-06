// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-welcome-card.js — onboarding card shown on a fresh install. Explains
// the three ways to add cards. Hides itself when the user creates their
// first card (server-side, in registry.createManifest). Visibility can be
// restored from Settings.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';
import './eh-add-card-modal.js';

export class EhWelcomeCard extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .intro {
        font-size: 14px;
        line-height: 1.55;
        color: var(--text-primary);
        margin: 0 0 16px;
      }
      .paths {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
      }
      @media (min-width: 560px) {
        .paths {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      .path {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px 14px 14px;
        background: var(--bg-input, rgba(0, 0, 0, 0.02));
        border: 1px solid var(--border);
        border-radius: 12px;
        text-align: left;
        width: 100%;
        color: inherit;
        font: inherit;
        cursor: pointer;
        appearance: none;
        transition: transform 0.12s ease, border-color 0.12s ease,
                    box-shadow 0.12s ease, background 0.12s ease;
        position: relative;
        min-height: 170px;
      }
      button.path:hover {
        border-color: var(--accent, #00d4aa);
        background: var(--bg-card, #fff);
        transform: translateY(-1px);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
      }
      button.path:focus-visible {
        outline: 2px solid var(--accent, #00d4aa);
        outline-offset: 2px;
      }
      button.path:active {
        transform: translateY(0);
      }
      button.path:disabled {
        cursor: default;
        opacity: 0.6;
      }
      button.path:disabled:hover {
        border-color: var(--border);
        background: var(--bg-input, rgba(0, 0, 0, 0.02));
        transform: none;
        box-shadow: none;
      }
      .path-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .path-emoji {
        font-size: 28px;
        line-height: 1;
        flex-shrink: 0;
      }
      .path-title {
        font-size: 15px;
        font-weight: 700;
        color: var(--text-primary);
        margin: 0;
        letter-spacing: -0.01em;
      }
      .path-copy {
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--text-secondary);
        margin: 0;
        flex: 1;
      }
      .path-cta {
        margin-top: auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        font-weight: 600;
        color: var(--accent, #00d4aa);
        padding: 6px 10px;
        background: rgba(0, 212, 170, 0.1);
        border-radius: 6px;
        align-self: flex-start;
      }
      .path-cta.muted {
        color: var(--text-muted, var(--text-secondary));
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }
      .path-cta-arrow {
        font-size: 13px;
        line-height: 1;
      }
      .foot {
        margin-top: 14px;
        font-size: 11.5px;
        color: var(--text-muted, var(--text-secondary));
        line-height: 1.45;
      }
    `,
  ];

  _openAddCard() {
    const m = document.createElement('eh-add-card-modal');
    m.addEventListener('eh-add-card-done', () => {
      window.dispatchEvent(new CustomEvent('klebb-cards-changed'));
    });
    document.body.appendChild(m);
    requestAnimationFrame(() => m.open());
  }

  _openChat() {
    window.dispatchEvent(new CustomEvent('klebb-open-chat'));
  }

  renderCard() {
    return html`
      <p class="intro">
        Klebb is a file-driven dashboard: every card is a JSON file on disk.
        Drop one in, it appears. Pick one of the three ways below to add
        your first card.
      </p>
      <div class="paths">
        <button type="button" class="path" @click=${this._openAddCard}>
          <div class="path-head">
            <div class="path-emoji">➕</div>
            <h3 class="path-title">Add a card</h3>
          </div>
          <p class="path-copy">
            Pick from a gallery of starter cards (weight, blood pressure,
            injections, supplements, and more) and fill in a few fields.
          </p>
          <span class="path-cta">Open gallery <span class="path-cta-arrow">→</span></span>
        </button>
        <button type="button" class="path" @click=${this._openChat}>
          <div class="path-head">
            <div class="path-emoji">💬</div>
            <h3 class="path-title">Describe it</h3>
          </div>
          <p class="path-copy">
            Tell the chat agent what you want to track. It proposes a
            card and creates it once you approve. Requires an LLM
            gateway (see docs).
          </p>
          <span class="path-cta">Open chat <span class="path-cta-arrow">→</span></span>
        </button>
        <button type="button" class="path" disabled aria-disabled="true">
          <div class="path-head">
            <div class="path-emoji">📚</div>
            <h3 class="path-title">Starter prompts</h3>
          </div>
          <p class="path-copy">
            Curated prompts for common protocols (GLP-1 cycle, supplement
            stack, post-op recovery). Loads into the chat so you can
            tweak before sending.
          </p>
          <span class="path-cta muted">Coming soon</span>
        </button>
      </div>
      <p class="foot">
        This card hides itself the first time you add any other card. You can
        restore it from Settings, or delete it entirely if you prefer.
      </p>
    `;
  }
}
customElements.define('eh-welcome-card', EhWelcomeCard);
registerRenderer('welcome-card', 'eh-welcome-card');
