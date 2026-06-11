// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-settings-view.js
//
// Settings shell. Renders the Connections pane (HAE + hidden discoveries)
// and the Cards pane today; the tabbed layout lands in a follow-up commit
// that introduces General/Notifications/Diagnostics tabs and slots these
// existing panes into Connections/Cards.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import './eh-settings-connections.js';
import './eh-settings-cards.js';

export class EhSettingsView extends LitElement {
  static styles = css`
    :host { display: block; max-width: 640px; margin: 0 auto; }
    eh-settings-cards { display: block; margin-top: 24px; }
  `;

  render() {
    return html`
      <eh-settings-connections></eh-settings-connections>
      <eh-settings-cards></eh-settings-cards>
    `;
  }
}
customElements.define('eh-settings-view', EhSettingsView);
