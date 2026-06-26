// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// eh-schedule-card.js — rich per-item card for scheduled protocols.
// Replaces the bare checklist-card for the peptides/medication data file.
// Shows:
//   - Cycle ring (SVG 48px, progress = cycleDay / cycleTotalDays)
//   - Name + short_name
//   - Dose label + units
//   - "Cycle N — Day X of Y" subtitle
//   - M T W T F S S week dots (filled on scheduled days, ring on the
//     day currently being viewed)
//   - Injection checkbox (appends to item.doses[])
//   - Status chip (Inject / Rest Day / Off Cycle / Loading / Maint)
//
// Reads from a v2 manifest whose data block is { items: [...], groups?: [...] }
// Each item has: name, short_name?, dose_mg, dose_units, route, schedule,
// cycles[], doses[].

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { EhBaseCard } from './eh-base-card.js';
import { isScheduledOnDate, effectiveCycles } from '../../../lib/schedule.mjs';
import { registerRenderer } from '../renderer-registry.js';
import { chipsFor as todChipsFor } from '../lib/time-of-day.esm.js';
import { itemAdherenceSeries, hasAdherenceSignal, adherenceItems } from '../lib/adherence-series.esm.js';
import { adherenceSparklineDescriptor } from '../lib/card-settings.js';
import './eh-input-form.js';
import './eh-sparkline.js';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Hash a string to a stable hex colour (used when itemColours isn't in meta).
function autoColour(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

// Mon-first week for a given date.
function weekDatesFor(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const wd = new Date(monday);
    wd.setDate(monday.getDate() + i);
    out.push(iso(wd));
  }
  return out;
}

// Find the active cycle that contains the given date.
function activeCycle(item, dateStr) {
  const cycles = effectiveCycles(item);
  if (!cycles) return null;
  for (const c of cycles) {
    const start = c.start || c.start_date;
    const end = c.end || c.end_date;
    if (!start) continue;
    if (end ? (dateStr >= start && dateStr <= end) : (dateStr >= start)) return c;
  }
  return null;
}

// Day number of the cycle (1-based), total days in cycle (if end date known).
function cycleProgress(item, dateStr) {
  const c = activeCycle(item, dateStr);
  if (!c) return { day: 0, total: 0, type: null, cycle: null };
  const start = c.start || c.start_date;
  const end = c.end || c.end_date;
  const d = new Date(dateStr + 'T00:00:00');
  const s = new Date(start + 'T00:00:00');
  const day = Math.round((d - s) / 86400000) + 1;
  if (!end) return { day, total: 0, type: c.type || 'on', cycle: c };
  const e = new Date(end + 'T00:00:00');
  const total = Math.round((e - s) / 86400000) + 1;
  return { day, total, type: c.type || 'on', cycle: c };
}

export class EhScheduleCard extends EhBaseCard {
  static supportsSettingsGear = true;
  static displayName = 'Schedule';

  static get settingsSchema() {
    return [adherenceSparklineDescriptor(hasAdherenceSignal, adherenceItems)];
  }

  // Extend the base reactive properties with one renderer-internal
  // bit of state: which scheduled item (if any) currently has the
  // check-off form expanded inline. The key is the item's `name` (or
  // `short_name` if no name); only one item's form is open at a time.
  static properties = {
    ...EhBaseCard.properties,
    _expandedItemKey: { state: true },
    _formError: { state: true },
  };

  constructor() {
    super();
    this._expandedItemKey = null;
    this._formError = null;
  }

  static styles = [
    EhBaseCard.styles,
    css`
      .items {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .item {
        display: grid;
        grid-template-columns: 54px minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        min-width: 0;
      }
      /* Cycle ring */
      .ring {
        position: relative;
        width: 48px;
        height: 48px;
      }
      .ring svg {
        width: 48px;
        height: 48px;
        transform: rotate(-90deg);
      }
      .ring-bg { fill: none; stroke: var(--border); stroke-width: 4; }
      .ring-fg { fill: none; stroke-width: 4; stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; }
      .ring-label {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 700;
        color: var(--text-muted, var(--text-secondary));
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .info { min-width: 0; }
      .name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .dose {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 1px;
      }
      .cycle-text {
        font-size: 11px;
        color: var(--text-muted, var(--text-secondary));
        margin-top: 1px;
      }
      .tod-chip {
        display: inline-block;
        margin-left: 6px;
        font-size: 14px;
        line-height: 1;
        vertical-align: middle;
        user-select: none;
      }
      .tod-chip + .tod-chip { margin-left: 2px; }
      /* Per-dose metadata summary for the viewed date — site, reactions
         the user logged via meta.view.checkOffForm. Hidden when the
         viewed date has no dose entry or the entry carries nothing
         from the form's field lists. See #354. */
      .dose-summary {
        font-size: 11px;
        color: var(--text-muted, var(--text-secondary));
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Week dots */
      .sc-spark {
        margin-top: 6px;
        line-height: 0;
        max-width: 160px;
      }
      .week {
        display: flex;
        gap: 4px;
        margin-top: 6px;
        /* On very narrow phones the info column may be thinner than
           7 × dot width + gaps; allow a gentle horizontal scroll
           rather than breaking the grid + forcing the page wider. */
        overflow-x: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .week::-webkit-scrollbar { display: none; }
      .dot {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        font-weight: 700;
        transition: all 0.15s;
        box-sizing: border-box;
        flex-shrink: 0;
      }
      .dot.inactive {
        background: var(--bg-card);
        color: var(--text-muted, var(--text-secondary));
        border: 1px solid var(--border);
      }
      .dot.active {
        border: 2px solid var(--dot-colour, var(--accent));
        color: var(--dot-colour, var(--accent));
        background: transparent;
      }
      .dot.selected-ring {
        box-shadow: 0 0 0 2px var(--bg-card), 0 0 0 3px var(--accent);
      }
      .dot.active.selected-ring {
        background: var(--dot-colour, var(--accent));
        color: white;
      }

      /* Status chip + checkbox */
      .right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
      }
      .chip {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        white-space: nowrap;
      }
      .chip.inject {
        background: var(--accent-bg, rgba(0,212,170,0.15));
        color: var(--accent);
      }
      .chip.rest {
        background: rgba(136,136,170,0.15);
        color: var(--text-secondary);
      }
      .chip.off {
        background: rgba(136,136,170,0.15);
        color: var(--text-muted, var(--text-secondary));
      }
      .checkbox {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: 2px solid var(--border);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .checkbox:hover { border-color: var(--accent); }
      .checkbox.checked {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .checkbox::before {
        content: '';
        font-size: 14px;
        font-weight: 700;
      }
      .checkbox.checked::before { content: '✓'; }
      .checkbox.disabled { opacity: 0.4; cursor: not-allowed; }

      /* Off-schedule variant: dimmer, dashed border, amber when checked.
         Appears on rest-days to let the user log an extra dose. */
      .checkbox.off-schedule {
        opacity: 0.55;
        border-style: dashed;
        border-color: var(--text-muted, var(--text-secondary));
      }
      .checkbox.off-schedule:hover {
        opacity: 1;
        border-color: #d0a030;
        border-style: solid;
      }
      .checkbox.off-schedule.checked {
        opacity: 1;
        background: #d0a030;
        border-color: #d0a030;
        border-style: solid;
        color: white;
      }
      .checkbox.off-schedule.checked::before { content: '✓'; }

      .empty {
        color: var(--text-muted, var(--text-secondary));
        font-size: 12px;
        padding: 8px 0;
      }

      /* --- Inline check-off form (per-dose metadata, see #345) --- */
      .item-row { display: flex; flex-direction: column; gap: 0; }
      .checkoff-form {
        margin-top: 8px;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-card);
      }
      /* Previous-dose section (#359, #375). The panel-and-prompt
         markup is now hosted inside <eh-input-form> via its
         headerSlot prop, so the .prev-dose* styles live there. The
         schedule-card keeps no styling for those classes. */
      .form-error {
        color: #ff4466;
        font-size: 12px;
        margin-top: 8px;
      }

      @media (max-width: 480px) {
        .item { grid-template-columns: 44px minmax(0, 1fr) auto; gap: 8px; }
        .ring, .ring svg { width: 40px; height: 40px; }
        .dot { width: 20px; height: 20px; }
      }
    `,
  ];

  get _items() {
    const d = this.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.items)) return d.items;
    return [];
  }

  _colourFor(item) {
    // Try meta-declared colours first (meta.view.colorMap { name: colour })
    const map = this._config?.colorMap || this._meta?.colorMap;
    if (map && typeof map === 'object' && map[item.name]) return map[item.name];
    return autoColour(item.name || 'item');
  }

  _isTakenOn(item, dateStr) {
    if (!Array.isArray(item.doses)) return false;
    const hit = item.doses.find(d => d.scheduledDate === dateStr);
    return !!(hit && hit.takenAt);
  }

  _statusChip(item) {
    const status = isScheduledOnDate(item, this.date);
    if (status === 'scheduled') {
      const text = item.action_label
        || (item.route === 'intranasal' ? 'Spray' : 'Inject');
      return { cls: 'inject', text };
    }
    if (status === 'rest') return { cls: 'rest', text: 'Rest day' };
    if (status === 'off') return { cls: 'off', text: 'Off cycle' };
    return null; // outside all cycles — don't show
  }

  _doseLabel(item) {
    if (item.dose_label) return item.dose_label;
    if (item.dose_mg != null) return `${item.dose_mg}mg`;
    if (item.dose) return item.dose;
    return '';
  }

  // Per-dose-metadata config (see #345). When meta.view.checkOffForm is
  // present with a non-empty currentDoseFields list, tapping ✓ expands
  // an inline form sourced from meta.writeable.inputs instead of
  // immediately stamping {scheduledDate, takenAt}.
  _checkOffFormConfig() {
    const cfg = this._config?.checkOffForm || this._meta?.checkOffForm;
    if (!cfg || typeof cfg !== 'object') return null;
    const current = Array.isArray(cfg.currentDoseFields) ? cfg.currentDoseFields : [];
    const previous = Array.isArray(cfg.previousDoseFields) ? cfg.previousDoseFields : [];
    if (current.length === 0 && previous.length === 0) return null;
    return {
      currentDoseFields: current,
      previousDoseFields: previous,
      previousDosePrompt: typeof cfg.previousDosePrompt === 'string'
        ? cfg.previousDosePrompt : null,
      currentDosePrompt: typeof cfg.currentDosePrompt === 'string'
        ? cfg.currentDosePrompt : null,
    };
  }

  _writeableInputs() {
    const inputs = this._meta?.writeable?.inputs;
    return Array.isArray(inputs) ? inputs : [];
  }

  // Inputs filtered to a list of keys, in the order that `keys` lists
  // them (so the form renders previousDoseFields first, currentDoseFields
  // second, regardless of the order in meta.writeable.inputs[]). Silently
  // skips any field key the manifest's writeable.inputs[] doesn't
  // actually declare.
  _filteredInputs(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const byKey = new Map();
    for (const input of this._writeableInputs()) byKey.set(input.key, input);
    const out = [];
    for (const key of keys) {
      const input = byKey.get(key);
      if (input) out.push(input);
    }
    return out;
  }

  // The most recent dose with a takenAt timestamp set, OR null. Walks
  // backwards to skip scheduled-but-untaken entries (takenAt: null) and
  // any dose for the currently-viewed date — when the user logs today
  // and re-opens the form to fill in the previous-dose reaction, the
  // "previous" dose is the one before today, not today itself.
  _findPreviousDose(item) {
    if (!Array.isArray(item.doses)) return null;
    for (let i = item.doses.length - 1; i >= 0; i--) {
      const d = item.doses[i];
      if (d && d.takenAt && d.scheduledDate !== this.date) return { dose: d, index: i };
    }
    return null;
  }

  _itemKey(item) {
    return item.name || item.short_name || '';
  }

  _summarisePreviousDose(prevDose, currentDoseFields) {
    if (!prevDose) return '';
    const parts = [];
    for (const key of currentDoseFields) {
      const v = prevDose[key];
      if (v === null || v === undefined || v === '') continue;
      parts.push(Array.isArray(v) ? v.join(', ') : String(v));
    }
    return parts.join(' ');
  }

  // Render the metadata of a dose entry as a one-line summary for the
  // card body (NOT the previous-dose context line, which has its own
  // formatter above). Two clusters: current-dose values joined with
  // spaces, and previous-dose values joined with ", ". Clusters
  // separated by " · ". The reactions value "none" is filtered from
  // chips-multi arrays — it's implicit, either by ticking the chip or
  // leaving the field empty. Returns '' when no fields carry a value.
  _summariseDoseForCard(dose, formCfg) {
    if (!dose || !formCfg) return '';
    const cluster = (keys, joiner) => {
      const out = [];
      for (const key of keys) {
        const v = dose[key];
        if (v === null || v === undefined || v === '') continue;
        if (Array.isArray(v)) {
          const filtered = v.filter(x => x !== 'none');
          if (filtered.length === 0) continue;
          out.push(filtered.join(joiner));
        } else {
          out.push(String(v));
        }
      }
      return out;
    };
    const current = cluster(formCfg.currentDoseFields, ' ');
    const previous = cluster(formCfg.previousDoseFields, ', ');
    const sections = [];
    if (current.length > 0) sections.push(current.join(' '));
    if (previous.length > 0) sections.push(previous.join(', '));
    return sections.join(' · ');
  }

  _relativeDays(isoTimestamp) {
    if (!isoTimestamp) return '';
    const then = new Date(isoTimestamp);
    if (Number.isNaN(then.getTime())) return '';
    const today = new Date(this.date + 'T00:00:00');
    const days = Math.round((today - new Date(then.toDateString())) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }

  async _toggleDose(item, opts = {}) {
    if (!this._canWrite) return;
    const doses = Array.isArray(item.doses) ? [...item.doses] : [];
    const idx = doses.findIndex(d => d.scheduledDate === this.date);
    const alreadyTaken = idx >= 0 && doses[idx].takenAt;

    // Form-driven path: only fires on the "take a dose" tap, never on
    // untick. Untick clears takenAt and saves immediately, same as
    // before. The form also skips on disable.
    const formCfg = this._checkOffFormConfig();
    if (formCfg && !alreadyTaken) {
      this._formError = null;
      this._expandedItemKey = this._itemKey(item) + (opts.offSchedule ? ':offschedule' : '');
      return;
    }

    if (idx >= 0) {
      if (doses[idx].takenAt) doses[idx] = { ...doses[idx], takenAt: null };
      else {
        const updated = { ...doses[idx], takenAt: new Date().toISOString() };
        if (opts.offSchedule) updated.offSchedule = true;
        doses[idx] = updated;
      }
    } else {
      const entry = { scheduledDate: this.date, takenAt: new Date().toISOString() };
      if (opts.offSchedule) entry.offSchedule = true;
      doses.push(entry);
    }
    await this._persistDoses(item, doses);
  }

  async _persistDoses(item, doses) {
    const d = this.data;
    const updatedItems = d.items.map(it => it === item ? { ...it, doses } : it);
    this.data = { ...d, items: updatedItems };
    this.requestUpdate();
    try {
      const res = await fetch(`/api/manifests/${encodeURIComponent(this.card.id)}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: this.data }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`save failed: ${res.status} ${text}`);
      }
    } catch (e) {
      console.warn('[schedule] save failed', e);
      this._formError = e.message || 'save failed';
    }
  }

  async _submitCheckOffForm(item, opts, e) {
    const payload = (e && e.detail) || {};
    const formCfg = this._checkOffFormConfig();
    if (!formCfg) return;

    // Build the new dose entry. eh-input-form auto-fills `date` from
    // its .date property — drop it; schedule-card uses scheduledDate.
    const newDose = { scheduledDate: this.date, takenAt: new Date().toISOString() };
    if (opts.offSchedule) newDose.offSchedule = true;
    for (const key of formCfg.currentDoseFields) {
      if (key in payload) newDose[key] = payload[key];
    }

    // Clone the item's doses and resolve the previous-dose merge BEFORE
    // pushing the new one (so "previous" doesn't accidentally point at
    // itself).
    const doses = Array.isArray(item.doses) ? [...item.doses] : [];
    let prev = null;
    for (let i = doses.length - 1; i >= 0; i--) {
      const d = doses[i];
      if (d && d.takenAt && d.scheduledDate !== this.date) { prev = { dose: d, index: i }; break; }
    }
    if (prev && formCfg.previousDoseFields.length > 0) {
      const merged = { ...prev.dose };
      for (const key of formCfg.previousDoseFields) {
        if (key in payload) merged[key] = payload[key];
      }
      doses[prev.index] = merged;
    }

    // Replace any existing same-date dose entry, otherwise append.
    const idx = doses.findIndex(d => d.scheduledDate === this.date);
    if (idx >= 0) doses[idx] = newDose; else doses.push(newDose);

    this._expandedItemKey = null;
    this._formError = null;
    await this._persistDoses(item, doses);
  }

  _cancelCheckOffForm() {
    this._expandedItemKey = null;
    this._formError = null;
  }

  _renderRing(cp, colour) {
    const r = 18;
    const circ = 2 * Math.PI * r;
    const pct = cp.total > 0 ? Math.min(1, cp.day / cp.total) : 0;
    const offset = circ * (1 - pct);
    const label = cp.total > 0 ? `${cp.day}/${cp.total}` : `d${cp.day}`;
    return html`
      <div class="ring">
        <svg viewBox="0 0 48 48">
          <circle class="ring-bg" cx="24" cy="24" r="${r}"></circle>
          <circle class="ring-fg" cx="24" cy="24" r="${r}"
                  stroke="${colour}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${offset}"></circle>
        </svg>
        <span class="ring-label">${label}</span>
      </div>
    `;
  }

  _renderWeekDots(item, colour) {
    const week = weekDatesFor(this.date);
    return html`
      <div class="week">
        ${week.map((wd, i) => {
          const status = isScheduledOnDate(item, wd);
          const active = status === 'scheduled';
          const isSelected = wd === this.date;
          const classes = ['dot'];
          classes.push(active ? 'active' : 'inactive');
          if (isSelected) classes.push('selected-ring');
          return html`<span class="${classes.join(' ')}" style="--dot-colour: ${colour}">${DAY_LETTERS[i]}</span>`;
        })}
      </div>
    `;
  }

  // Opt-in per-item adherence strip (meta.view.showSparkline): 1 taken /
  // 0 missed over scheduled days in the last 30, null on rest/off days. The
  // 30-day generalisation of the 7-day week dots. Today-only; needs >= 2
  // scheduled days of signal or it renders nothing.
  _renderAdherenceSpark(item) {
    if (!this._config.showSparkline) return '';
    const isToday = this.dateMode === 'today' || !this.dateMode;
    if (!isToday) return '';
    const series = itemAdherenceSeries(item, {
      endDate: this.date,
      limit: 30,
      isScheduled: (it, day) => isScheduledOnDate(it, day) === 'scheduled',
      isTaken: (it, day) => this._isTakenOn(it, day),
    });
    if (series.filter(v => v !== null).length < 2) return '';
    return html`<div class="sc-spark"><eh-sparkline mode="adherence" .values=${series}></eh-sparkline></div>`;
  }

  _renderCheckOffForm(item, opts) {
    const cfg = this._checkOffFormConfig();
    if (!cfg) return '';
    const all = this._writeableInputs();
    if (all.length === 0) return '';
    const fieldKeys = [...cfg.previousDoseFields, ...cfg.currentDoseFields];
    const inputs = this._filteredInputs(fieldKeys);
    if (inputs.length === 0) return '';

    const prev = this._findPreviousDose(item);
    const summary = prev ? this._summarisePreviousDose(prev.dose, cfg.currentDoseFields) : '';
    const ago = prev ? this._relativeDays(prev.dose.takenAt) : '';
    const showPrevContext = !!(prev && (summary || cfg.previousDoseFields.length > 0));

    // If there is no previous dose, hide the previous-dose fields by
    // restricting the form to currentDoseFields only.
    const visibleInputs = prev
      ? inputs
      : this._filteredInputs(cfg.currentDoseFields);

    const onSubmit = (e) => this._submitCheckOffForm(item, opts, e);
    const onCancel = () => this._cancelCheckOffForm();

    // Prefill the form when a dose entry already exists for the viewed
    // date — lets the user edit a logged dose by re-tapping ✓ instead
    // of having to untick + re-fill from scratch. eh-input-form's
    // willUpdate handles chips-multi array coercion already.
    const existingDose = Array.isArray(item.doses)
      ? item.doses.find(d => d.scheduledDate === this.date)
      : null;
    const formValues = existingDose ? { ...existingDose } : {};

    // When previousDoseFields is non-empty, render a divider after
    // its last field so the previous-dose section (panel + reactions
    // chips) is visually separated from the new-dose fields below.
    const dividerAfterKey = (cfg.previousDoseFields.length > 0 && prev)
      ? cfg.previousDoseFields[cfg.previousDoseFields.length - 1]
      : '';
    // The new-dose section gets a small heading right after the
    // divider so users know what those fields describe. Use the
    // manifest's currentDosePrompt if set; otherwise fall back to a
    // generic "This dose". Only when the divider exists; without a
    // divider there's nothing to label.
    const dividerLabel = dividerAfterKey
      ? (cfg.currentDosePrompt || 'This dose')
      : '';

    // The prev-dose context block ("Last: 4d ago / How does the last
    // injection site look?") is hosted INSIDE the form via headerSlot
    // so the top action bar (which the form renders) sits visually
    // above it: the user pops the form, sees Cancel / Log dose at the
    // very top, then the prompt, then the chips. See #375.
    const prevDoseSlot = showPrevContext ? html`
      <div class="prev-dose">
        <div class="prev-dose-line">
          <span class="prev-dose-label">Last:</span>
          <span class="prev-dose-summary">${ago}${summary ? ' · ' + summary : ''}</span>
        </div>
        ${cfg.previousDosePrompt ? html`
          <div class="prev-dose-prompt">${cfg.previousDosePrompt}</div>
        ` : ''}
      </div>
    ` : null;

    return html`
      <div class="checkoff-form">
        <eh-input-form
          .inputs=${visibleInputs}
          .values=${formValues}
          .date=${this.date}
          .headerSlot=${prevDoseSlot}
          submit-label=${opts.offSchedule ? 'Log off-schedule dose' : 'Log dose'}
          cancel-label="Cancel"
          actions-position="both"
          divider-after-key=${dividerAfterKey}
          divider-label=${dividerLabel}
          @eh-submit=${onSubmit}
          @eh-cancel=${onCancel}
        ></eh-input-form>
        ${this._formError ? html`<div class="form-error">${this._formError}</div>` : ''}
      </div>
    `;
  }

  renderCard() {
    const items = this._items;
    if (items.length === 0) return html`<div class="empty">Nothing scheduled.</div>`;
    // Filter: only render items that have some form of activity (scheduled today OR rest OR in cycle)
    const visible = items.filter(it => activeCycle(it, this.date));
    return html`
      <div class="items">
        ${visible.map(item => {
          const colour = this._colourFor(item);
          const cp = cycleProgress(item, this.date);
          const chip = this._statusChip(item);
          const taken = this._isTakenOn(item, this.date);
          const scheduledStatus = isScheduledOnDate(item, this.date);
          const isScheduledToday = scheduledStatus === 'scheduled';
          const isRestToday = scheduledStatus === 'rest';
          // Off-schedule dose taken when the date's status is 'rest' but
          // we have a takenAt — or the dose entry itself has offSchedule.
          const doseEntry = Array.isArray(item.doses)
            ? item.doses.find(d => d.scheduledDate === this.date) : null;
          const isOffScheduleTaken = !!(taken && (isRestToday || doseEntry?.offSchedule));
          const itemKey = this._itemKey(item);
          const formKey = this._expandedItemKey;
          const formExpandedScheduled = formKey === itemKey;
          const formExpandedOffSchedule = formKey === itemKey + ':offschedule';
          const formCfg = this._checkOffFormConfig();
          const doseSummary = (formCfg && doseEntry && doseEntry.takenAt)
            ? this._summariseDoseForCard(doseEntry, formCfg) : '';
          return html`
            <div class="item-row">
              <div class="item">
                ${this._renderRing(cp, colour)}
                <div class="info">
                  <div class="name">${item.short_name || item.name}</div>
                  ${isScheduledToday ? html`<div class="dose">${this._doseLabel(item)}${item.dose_units ? ' · ' + item.dose_units + 'u' : ''}</div>` : ''}
                  <div class="cycle-text">
                    ${cp.type === 'off' ? 'Off cycle' : 'Cycle'} · Day ${cp.day}${cp.total ? ' of ' + cp.total : ''}
                    ${todChipsFor(item.schedule?.time_of_day).map(c => html`<span class="tod-chip" aria-label=${c.label} title=${c.label}>${c.emoji}</span>`)}
                  </div>
                  ${doseSummary ? html`<div class="dose-summary">${doseSummary}</div>` : ''}
                  ${this._renderWeekDots(item, colour)}
                  ${this._renderAdherenceSpark(item)}
                </div>
                <div class="right">
                  ${chip ? html`<span class="chip ${chip.cls}">${chip.text}</span>` : ''}
                  ${isScheduledToday ? html`
                    <div
                      class="checkbox ${taken ? 'checked' : ''} ${this._canWrite ? '' : 'disabled'}"
                      @click=${() => this._toggleDose(item)}
                      role="button"
                      aria-label="mark ${item.name} taken"
                    ></div>
                  ` : isRestToday ? html`
                    <div
                      class="checkbox off-schedule ${isOffScheduleTaken ? 'checked' : ''} ${this._canWrite ? '' : 'disabled'}"
                      @click=${() => this._toggleDose(item, { offSchedule: true })}
                      role="button"
                      aria-label="log extra ${item.name} dose (off-schedule)"
                      title="Log an off-schedule dose"
                    ></div>
                  ` : ''}
                </div>
              </div>
              ${formExpandedScheduled ? this._renderCheckOffForm(item, { offSchedule: false }) : ''}
              ${formExpandedOffSchedule ? this._renderCheckOffForm(item, { offSchedule: true }) : ''}
            </div>
          `;
        })}
      </div>
    `;
  }
}
customElements.define('eh-schedule-card', EhScheduleCard);
registerRenderer('schedule-card', 'eh-schedule-card');
