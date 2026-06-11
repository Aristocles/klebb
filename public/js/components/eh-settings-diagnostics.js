// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-diagnostics.js
//
// Settings > Diagnostics pane. Placeholder; the real surface (timezone,
// VAPID key fingerprint, push subscription health, recent fires) lands
// alongside notifications. Refs #387.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhSettingsDiagnostics extends LitElement {
  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 1.2rem;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    .placeholder {
      padding: 24px;
      text-align: center;
      color: var(--text-secondary);
      font-size: 13px;
      border: 1px dashed var(--border);
      border-radius: 10px;
    }
  `;

  render() {
    return html`
      <h2>Diagnostics</h2>
      <div class="placeholder">
        Push subscription health, server timezone, and recent notification
        delivery logs land here when the notifications feature ships.
      </div>
    `;
  }
}
customElements.define('eh-settings-diagnostics', EhSettingsDiagnostics);
