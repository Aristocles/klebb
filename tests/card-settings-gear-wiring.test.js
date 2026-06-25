// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/card-settings-gear-wiring.test.js
// Source-level coverage for the per-card settings gear (#456). The Lit
// components can't run under Node (esm.sh import), so this pins the
// load-bearing wiring: the gear is opt-in on the base, real renderers opt
// in, synthetic cards do not, and the modal<->app event contract holds.
// Interactive behaviour is owned by the e2e spec.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', ...p), 'utf8');
const BASE = read('components', 'eh-base-card.js');
const GENERIC = read('components', 'eh-generic-card.js');
const SCHEDULE = read('components', 'eh-schedule-card.js');
const CHECKLIST = read('components', 'eh-checklist-card.js');
const LIST = read('components', 'eh-list-card.js');
const COMBINATION = read('components', 'eh-combination-card.js');
const WELCOME = read('components', 'eh-welcome-card.js');
const UNKNOWN = read('components', 'eh-unknown-card.js');
const MODAL = read('components', 'eh-card-settings-modal.js');
const APP = read('app.js');

describe('gear opt-in on the base card', () => {
  test('base defaults supportsSettingsGear to false', () => {
    assert.ok(/static\s+supportsSettingsGear\s*=\s*false/.test(BASE),
      'EhBaseCard.supportsSettingsGear defaults false');
  });
  test('gear only shows when opted-in, has an id, and is not headerless', () => {
    assert.ok(/get _showSettingsGear\(\)/.test(BASE), '_showSettingsGear getter present');
    assert.ok(/!this\.headerless/.test(BASE), 'gear suppressed when headerless');
    assert.ok(/supportsSettingsGear\s*===\s*true/.test(BASE), 'gated on opt-in flag');
    assert.ok(/!!this\.card\?\.id/.test(BASE), 'gated on a real card id');
  });
  test('opening settings stops propagation and dispatches eh-open-card-settings', () => {
    assert.ok(/_openSettings\(e\)\s*\{[\s\S]*e\.stopPropagation\(\)/.test(BASE),
      'click does not bubble to the header expand handler');
    assert.ok(/new CustomEvent\('eh-open-card-settings'/.test(BASE), 'dispatches the open event');
  });
  test('gear button rendered in the header-right group', () => {
    assert.ok(/class="header-right"/.test(BASE), 'header-right group present');
    assert.ok(/\$\{this\._showSettingsGear\s*\?\s*html`[\s\S]*class="settings-gear"/.test(BASE),
      'gear button conditional on _showSettingsGear');
  });
});

describe('renderer opt-in', () => {
  test('generic-card opts into the gear and names a displayName', () => {
    assert.ok(/static\s+supportsSettingsGear\s*=\s*true/.test(GENERIC), 'generic-card opts in');
    assert.ok(/static\s+displayName\s*=/.test(GENERIC), 'generic-card sets a displayName');
  });
  test('generic-card declares a settingsSchema with the sparkline gate', () => {
    assert.ok(/static\s+get\s+settingsSchema\(\)/.test(GENERIC), 'settingsSchema getter present');
    assert.ok(/view\.showSparkline/.test(GENERIC), 'sparkline descriptor present');
    assert.ok(/needsData:\s*true/.test(GENERIC), 'sparkline descriptor flags needsData');
    assert.ok(/availableWhen:/.test(GENERIC), 'sparkline descriptor has an availability predicate');
    assert.ok(/view\.fallbackToLatest/.test(GENERIC), 'carry-forward descriptor present');
  });
  test('schedule + checklist opt in and share the adherence sparkline descriptor', () => {
    for (const [name, src] of [['schedule', SCHEDULE], ['checklist', CHECKLIST]]) {
      assert.ok(/static\s+supportsSettingsGear\s*=\s*true/.test(src), `${name} opts in`);
      assert.ok(/static\s+get\s+settingsSchema\(\)/.test(src), `${name} declares settingsSchema`);
      assert.ok(/adherenceSparklineDescriptor\(hasAdherenceSignal,\s*adherenceItems\)/.test(src),
        `${name} uses the shared adherence descriptor`);
    }
  });
  test('list-card opts in (common toggles only, no renderer schema)', () => {
    assert.ok(/static\s+supportsSettingsGear\s*=\s*true/.test(LIST), 'list-card opts in');
    assert.ok(!/static\s+get\s+settingsSchema/.test(LIST), 'list-card declares no renderer-specific schema');
  });
  test('list-card edit toolbar shifted to clear the gear', () => {
    assert.ok(/\.edit-toolbar[\s\S]*right:\s*40px/.test(LIST), 'edit-toolbar cleared from the top-right corner');
  });
  test('combination-card (read-only composite) does not opt into the gear', () => {
    assert.ok(!/supportsSettingsGear\s*=\s*true/.test(COMBINATION), 'combination-card stays gearless');
  });
  test('synthetic cards do NOT opt into the gear', () => {
    assert.ok(!/supportsSettingsGear\s*=\s*true/.test(WELCOME), 'welcome card stays opted out');
    assert.ok(!/supportsSettingsGear\s*=\s*true/.test(UNKNOWN), 'unknown card stays opted out');
  });
});

describe('modal <-> app event contract', () => {
  test('modal PATCHes meta and fires eh-card-settings-done on close', () => {
    assert.ok(/method:\s*'PATCH'/.test(MODAL), 'modal saves via PATCH');
    assert.ok(/\/api\/manifests\/\$\{encodeURIComponent\(this\.card\.id\)\}/.test(MODAL),
      'PATCH targets /api/manifests/:id');
    assert.ok(/new CustomEvent\('eh-card-settings-done'/.test(MODAL), 'fires the done event');
  });
  test('modal only fetches data when a descriptor needs it', () => {
    assert.ok(/_needsData\(\)/.test(MODAL), '_needsData guard present');
    assert.ok(/d\.needsData\s*===\s*true/.test(MODAL), 'guard keys off descriptor.needsData');
  });
  test('modal Ask-Klebbius seeds the chat with card context', () => {
    assert.ok(/klebb-paste-into-chat/.test(MODAL), 'dispatches the chat seed event');
    assert.ok(/this\.card\?\.id/.test(MODAL), 'prompt embeds the card id');
  });
  test('app listens for eh-open-card-settings and resolves the renderer schema', () => {
    assert.ok(/addEventListener\('eh-open-card-settings'/.test(APP), 'app subscribes to the open event');
    assert.ok(/removeEventListener\('eh-open-card-settings'/.test(APP), 'app cleans up the listener');
    assert.ok(/customElements\.get\(tag\)/.test(APP), 'resolves the renderer class via the registry tag');
    assert.ok(/mergeSchema\(/.test(APP), 'merges common + renderer schema');
  });
  test('modal renders a notifications section and combines patches into one PATCH', () => {
    assert.ok(/_renderNotifications\(\)/.test(MODAL), 'notifications section rendered');
    assert.ok(/buildNotificationsPatch/.test(MODAL), 'uses the notifications patch builder');
    assert.ok(/_combinedPatch\(\)/.test(MODAL), 'merges settings + notifications into one patch');
    assert.ok(/notificationsState|notificationsEnabled/.test(MODAL), 'reads notification state from the helper');
  });
  test('notifications toggle is separate from path descriptors (can create an item)', () => {
    assert.ok(/_notifEdit/.test(MODAL), 'notifications tracked as its own tri-state');
    assert.ok(/_toggleNotifications/.test(MODAL), 'dedicated toggle handler');
  });
  test('app refreshes the view only when a change was persisted', () => {
    assert.ok(/_onCardSettingsDone/.test(APP), 'done handler present');
    assert.ok(/e\.detail\?\.changed[\s\S]{0,80}klebb-cards-changed/.test(APP),
      'dispatches klebb-cards-changed only when changed');
  });
  test('app passes the renderer component to the modal (advanced discovery needs it)', () => {
    assert.ok(/\.component=\$\{this\._cardSettings\.component\}/.test(APP), 'component bound on the modal');
  });
  test('modal renders an advanced (added features) section via discover-and-park', () => {
    assert.ok(/_renderAdvanced\(\)/.test(MODAL), 'advanced section rendered');
    assert.ok(/discoverAdvanced/.test(MODAL), 'uses the discovery helper');
    assert.ok(/buildAdvancedPatch/.test(MODAL), 'uses the park/restore patch builder');
  });
  test('advanced patch is always computed so stale parked copies purge on save', () => {
    // buildAdvancedPatch is called in _combinedPatch unconditionally (not
    // guarded behind "only if edits"), enforcing live-wins.
    assert.ok(/buildAdvancedPatch\(meta,\s*this\._advanced\(\),\s*this\._advEdit\)/.test(MODAL),
      'advanced patch computed every save');
  });
  test('combined patch deep-merges so view sub-trees never clobber each other', () => {
    assert.ok(/function deepMerge/.test(MODAL), 'deepMerge helper present');
  });
});
