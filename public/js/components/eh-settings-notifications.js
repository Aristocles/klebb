// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-notifications.js
//
// Settings > Notifications pane. Placeholder; the real surface (per-card
// toggles, quiet hours, pause-for-N-hours, iOS install instructions) lands
// in the notifications feature PR. Refs #387.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

export class EhSettingsNotifications extends LitElement {
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
    .footer-note {
      margin-top: 16px;
      color: var(--text-muted, var(--text-secondary));
      font-size: 12px;
      text-align: center;
    }
  `;

  render() {
    return html`
      <h2>Notifications</h2>
      <div class="placeholder">
        Notifications are coming soon. Cards will be able to remind you to
        log mood, pain, supplements, and the like.
      </div>
      <p class="footer-note">
        If a notification you want is missing, ask Klebbius to add it.
      </p>
    `;
  }
}
customElements.define('eh-settings-notifications', EhSettingsNotifications);
