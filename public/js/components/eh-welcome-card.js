// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-welcome-card.js: first-run empty state shown when no user cards exist.
// Teaches how cards come to exist (drop a JSON manifest, or ask Klebbius) and
// offers a primary CTA that opens the template gallery. Hides itself when the
// user creates their first card (server-side, in registry.createManifest).
// Visibility can be restored from Settings.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';
import './eh-prompts-gallery.js';

export class EhWelcomeCard extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .intro {
        margin: 0 0 16px;
      }
      .intro-lead {
        font-size: 13.5px;
        line-height: 1.5;
        color: var(--text-primary);
        margin: 0 0 14px;
      }
      .intro-lead code {
        font-size: 12.5px;
        padding: 1px 5px;
        border-radius: 5px;
        background: var(--bg-input, rgba(0, 0, 0, 0.05));
        border: 1px solid var(--border);
      }
      .cta {
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        padding: 11px 18px;
        border-radius: 10px;
        border: 1px solid var(--accent, #00d4aa);
        background: var(--accent, #00d4aa);
        color: #000;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        transition: transform 0.12s ease, box-shadow 0.12s ease,
                    filter 0.12s ease;
      }
      .cta:hover {
        filter: brightness(1.06);
        transform: translateY(-1px);
        box-shadow: 0 4px 14px rgba(0, 212, 170, 0.25);
      }
      .cta:active { transform: translateY(0); }
      .cta:focus-visible {
        outline: 2px solid var(--accent, #00d4aa);
        outline-offset: 3px;
      }
      .cta-emoji { font-size: 16px; line-height: 1; }
      .or {
        margin: 14px 0 4px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        color: var(--text-muted, var(--text-secondary));
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
        box-sizing: border-box;
        color: inherit;
        font: inherit;
        cursor: pointer;
        appearance: none;
        transition: transform 0.12s ease, border-color 0.12s ease,
                    box-shadow 0.12s ease, background 0.12s ease;
        position: relative;
        min-height: 190px;
        text-decoration: none;
      }
      a.path {
        display: flex;
      }
      button.path:hover,
      a.path:hover {
        border-color: var(--accent, #00d4aa);
        background: var(--bg-card, #fff);
        transform: translateY(-1px);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
      }
      button.path:focus-visible,
      a.path:focus-visible {
        outline: 2px solid var(--accent, #00d4aa);
        outline-offset: 2px;
      }
      button.path:active,
      a.path:active { transform: translateY(0); }

      /* Featured variant for the primary "Start here" path. */
      .path.featured {
        border-color: var(--accent, #00d4aa);
        background: rgba(0, 212, 170, 0.06);
      }
      .path.featured:hover {
        background: rgba(0, 212, 170, 0.1);
      }
      .start-chip {
        position: absolute;
        top: -9px;
        left: 14px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        padding: 3px 8px;
        background: var(--accent, #00d4aa);
        color: #000;
        border-radius: 10px;
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
        background: rgba(0, 212, 170, 0.12);
        border-radius: 6px;
        align-self: flex-start;
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

  _openPrompts() {
    const m = document.createElement('eh-prompts-gallery');
    document.body.appendChild(m);
    requestAnimationFrame(() => m.open());
  }

  _openChat() {
    window.dispatchEvent(new CustomEvent('klebb-open-chat'));
  }

  _addFirstCard() {
    window.dispatchEvent(new CustomEvent('klebb-open-card-gallery'));
  }

  renderCard() {
    return html`
      <div class="intro">
        <p class="intro-lead">
          Klebb has no cards yet. A card appears the moment you drop a
          <code>.json</code> manifest into your data folder, or ask
          Klebbius to make one for you. Each card tracks one thing:
          weight, bloods, a supplement stack, mood, sleep, whatever you
          like. Add your first one to get started.
        </p>
        <button type="button" class="cta" @click=${this._addFirstCard}>
          <span class="cta-emoji">✨</span> Add your first card
        </button>
        <p class="or">Or pick a path</p>
      </div>
      <div class="paths">
        <button type="button" class="path featured" @click=${this._openPrompts}>
          <span class="start-chip">★ Start here</span>
          <div class="path-head">
            <div class="path-emoji">📚</div>
            <h3 class="path-title">Pick a starter prompt</h3>
          </div>
          <p class="path-copy">
            Curated prompts for common protocols (GLP-1 cycle, supplement
            stack, strength training, post-op recovery, and more). The
            agent asks a few questions and builds out a whole dashboard
            for you.
          </p>
          <span class="path-cta">Browse prompts <span class="path-cta-arrow">→</span></span>
        </button>

        <button type="button" class="path" @click=${this._openChat}>
          <div class="path-head">
            <div class="path-emoji">💬</div>
            <h3 class="path-title">Describe it yourself</h3>
          </div>
          <p class="path-copy">
            Tell the chat agent what you want to track in your own words.
            It proposes a card and creates it once you approve. Works
            best when you know exactly what you want.
          </p>
          <span class="path-cta">Open chat <span class="path-cta-arrow">→</span></span>
        </button>

        <a class="path"
           href="https://github.com/Aristocles/klebb/blob/main/docs/CARDS.md"
           target="_blank" rel="noopener noreferrer">
          <div class="path-head">
            <div class="path-emoji">⚙️</div>
            <h3 class="path-title">Hand-author JSON</h3>
          </div>
          <p class="path-copy">
            For advanced users. Drop a manifest file into your data
            directory and it appears as a card. Canonical examples live
            in the repo's <code>templates/</code> folder.
          </p>
          <span class="path-cta">Open docs <span class="path-cta-arrow">→</span></span>
        </a>
      </div>
      <p class="foot">
        This card hides itself the first time you add any other card. You
        can restore it from Settings, or delete it entirely if you prefer.
      </p>
    `;
  }
}
customElements.define('eh-welcome-card', EhWelcomeCard);
registerRenderer('welcome-card', 'eh-welcome-card');
