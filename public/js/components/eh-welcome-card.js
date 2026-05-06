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
        line-height: 1.5;
        color: var(--text-primary);
        margin: 0 0 12px;
      }
      .paths {
        display: grid;
        gap: 10px;
      }
      .path {
        display: flex;
        gap: 10px;
        padding: 10px 12px;
        background: var(--bg-input, rgba(255, 255, 255, 0.03));
        border: 1px solid var(--border);
        border-radius: 8px;
        text-align: left;
        width: 100%;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      button.path { appearance: none; }
      button.path:hover { border-color: var(--accent, #00d4aa); }
      button.path:focus {
        outline: none;
        border-color: var(--accent, #00d4aa);
      }
      button.path:disabled {
        cursor: default;
        opacity: 0.7;
      }
      button.path:disabled:hover { border-color: var(--border); }
      .path-emoji {
        font-size: 20px;
        line-height: 1.2;
        flex-shrink: 0;
      }
      .path-body {
        flex: 1;
        min-width: 0;
      }
      .path-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
        margin: 0 0 2px;
      }
      .path-copy {
        font-size: 12px;
        line-height: 1.45;
        color: var(--text-secondary);
        margin: 0;
      }
      .foot {
        margin-top: 12px;
        font-size: 11px;
        color: var(--text-muted, var(--text-secondary));
        line-height: 1.4;
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

  renderCard() {
    return html`
      <p class="intro">
        Klebb is a file-driven dashboard: every card is a JSON file on disk.
        Drop one in, it appears. Here are three ways to get started.
      </p>
      <div class="paths">
        <button type="button" class="path" @click=${this._openAddCard}>
          <div class="path-emoji">➕</div>
          <div class="path-body">
            <p class="path-title">Add a card</p>
            <p class="path-copy">
              Pick from a gallery of starter cards (weight, blood pressure,
              injections, supplements, and more) and fill in a few fields.
            </p>
          </div>
        </button>
        <div class="path">
          <div class="path-emoji">💬</div>
          <div class="path-body">
            <p class="path-title">Describe what you want to track</p>
            <p class="path-copy">
              Open the chat widget and tell the agent what you're tracking;
              it will propose a card and create it once you approve.
              Requires an LLM gateway (see docs).
            </p>
          </div>
        </div>
        <div class="path">
          <div class="path-emoji">📚</div>
          <div class="path-body">
            <p class="path-title">Browse starter prompts</p>
            <p class="path-copy">
              Curated prompts for common protocols (GLP-1 cycle, supplement
              stack, post-op recovery). Loads into the chat widget so you
              can tweak before sending. <em>Coming soon.</em>
            </p>
          </div>
        </div>
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
