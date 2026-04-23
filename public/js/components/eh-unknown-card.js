// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-unknown-card.js — shown when a manifest declares a component name we don't have.
// Keeps the UI resilient to typos / components-not-yet-implemented.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';

export class EhUnknownCard extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .missing {
        font-size: 12px;
        color: var(--accent-amber, #ffaa00);
        padding: 4px 0;
      }
      code {
        background: var(--bg-input, rgba(255,255,255,0.05));
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 11px;
      }
    `,
  ];

  renderCard() {
    const comp = this._config.component || '?';
    return html`
      <div class="missing">
        ⚠︎ Unknown renderer: <code>${comp}</code>
      </div>
    `;
  }
}
customElements.define('eh-unknown-card', EhUnknownCard);
