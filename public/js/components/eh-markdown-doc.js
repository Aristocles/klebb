// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-markdown-doc.js — renders a markdown file (used primarily in Reports view)
// Config (meta.reports.markdownPath): path relative to reports dir, or a full
// "/report/<name>" URL. For now, supports linking out to the existing /report/<name>
// route which the server already renders.

import { html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { registerRenderer } from '../renderer-registry.js';

export class EhMarkdownDoc extends EhBaseCard {
  static styles = [
    EhBaseCard.styles,
    css`
      .doc-link {
        display: inline-block;
        margin-top: 4px;
        font-size: 12px;
        color: var(--accent, #00d4aa);
        text-decoration: none;
      }
      .doc-link:hover { text-decoration: underline; }
      .summary {
        font-size: 13px;
        color: var(--text-secondary);
      }
    `,
  ];

  renderCard() {
    const cfg = this._config;
    const name = cfg.reportName || cfg.markdownName || this.card?.id;
    const url = cfg.url || (name ? `/report/${encodeURIComponent(name)}` : null);
    return html`
      ${cfg.summary ? html`<div class="summary">${cfg.summary}</div>` : ''}
      ${url ? html`<a class="doc-link" href="${url}" target="_blank">Open document →</a>` : ''}
    `;
  }
}
customElements.define('eh-markdown-doc', EhMarkdownDoc);
registerRenderer('markdown-doc', 'eh-markdown-doc');
