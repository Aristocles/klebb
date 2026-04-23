// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-trends-view.js
// v2 Trends view — composes cards with meta.trends.enabled: true.
// Delegates rendering to the existing eh-view-renderer targeting view='trends'.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './eh-view-renderer.js';

export class EhTrendsView extends LitElement {
  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 0 0 16px;
    }
  `;
  render() {
    return html`
      <h2>📊 Trends</h2>
      <eh-view-renderer view="trends"></eh-view-renderer>
    `;
  }
}
customElements.define('eh-trends-view', EhTrendsView);
