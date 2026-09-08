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

// A stacked entry's display time (#705). When the log instant's local
// calendar date differs from the entry's scheduledDate (backfill: logged
// today against a past day), a bare time would read as that past day's
// time, so the label carries the log date too.
function _entryTimeLabel(e) {
  if (!e.takenAt) return '';
  const dt = new Date(e.takenAt);
  const t = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const localDate = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  if (e.scheduledDate && localDate !== e.scheduledDate) {
    return `logged ${dt.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
  }
  return t;
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
    _entriesExpandedKey: { state: true },
  };

  constructor() {
    super();
    this._expandedItemKey = null;
    this._formError = null;
    this._entriesExpandedKey = null;
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
      .multi-count {
        border: 1px solid var(--border, #333);
        background: none;
        color: var(--text-secondary);
        border-radius: 10px;
        font-size: 11px;
        line-height: 1.4;
        padding: 1px 7px;
        cursor: pointer;
      }
      .multi-count.open {
        color: var(--accent, #00d4aa);
        border-color: var(--accent, #00d4aa);
      }
      .day-entries {
        margin: 4px 8px 6px 52px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .day-entry {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .entry-time {
        font-variant-numeric: tabular-nums;
      }
      .entry-summary {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .entry-remove {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 4px;
      }
      .entry-remove:hover {
        color: var(--danger, #e05661);
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
    // .some, not find-first: an unticked entry (takenAt null) followed by
    // a taken one must still read as taken, and multi mode (#705) can hold
    // several same-day entries.
    return item.doses.some(d => d && d.scheduledDate === dateStr && d.takenAt);
  }

  // Taken entries for one date, oldest first (stacking order, #705).
  _takenEntriesOn(item, dateStr = this.date) {
    if (!Array.isArray(item.doses)) return [];
    return item.doses.filter(d => d && d.scheduledDate === dateStr && d.takenAt);
  }

  // The entry that represents a date: the latest taken one, else the
  // date's untaken placeholder. Identical to find-first when a date can
  // only hold one entry.
  _doseEntryOn(item, dateStr = this.date) {
    if (!Array.isArray(item.doses)) return null;
    const same = item.doses.filter(d => d && d.scheduledDate === dateStr);
    if (same.length === 0) return null;
    const taken = same.filter(d => d.takenAt);
    if (taken.length === 0) return same[same.length - 1];
    return taken.reduce((a, b) => ((a.takenAt || '') >= (b.takenAt || '') ? a : b));
  }

  // meta.writeable.maxReadingsPerDay, the existing schema knob for
  // multiple same-day entries (#705). 1 (or anything invalid) keeps the
  // one-entry-per-date behaviour byte-identical.
  _maxReadingsPerDay() {
    const v = this._meta?.writeable?.maxReadingsPerDay;
    return Number.isInteger(v) && v > 1 ? v : 1;
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

  // meta.view.doseLine controls when the per-item dose text renders:
  // 'scheduled' (the default, and the pre-#706 behaviour) on scheduled
  // days only, 'always' also on rest and off-cycle rows, 'never' not at
  // all. An unrecognised value falls back to the default so a typo can
  // never blank the line.
  _doseLineVisible(isScheduledToday) {
    const mode = this._config?.doseLine;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return isScheduledToday;
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

  // The dose the form's "Last:" context line describes. Delegates to
  // _resolvePreviousDose so the line always names the SAME dose the
  // submit-time review merge will write to.
  _findPreviousDose(item) {
    return this._resolvePreviousDose(item.doses);
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
    const alreadyTaken = doses.some(d => d.scheduledDate === this.date && d.takenAt);
    const maxPerDay = this._maxReadingsPerDay();

    // Form-driven path: only fires on the "take a dose" tap, never on
    // untick. Untick clears takenAt and saves immediately, same as
    // before. The form also skips on disable. In multi mode (#705) every
    // tap goes through the form: under the cap it logs another entry, at
    // the cap it edits the latest. The form session (prefill + edit
    // target) is snapshotted HERE, at open time: deriving it per render
    // let any state change beside the open form (badge toggle, entry
    // remove) reset typed input and silently retarget Submit.
    const formCfg = this._checkOffFormConfig();
    if (formCfg && (!alreadyTaken || maxPerDay > 1)) {
      const underCap = maxPerDay > 1 && this._takenEntriesOn(item).length < maxPerDay;
      const editTarget = maxPerDay > 1 && !underCap ? this._doseEntryOn(item) : null;
      const prefill = maxPerDay > 1
        ? editTarget
        : this._doseEntryOn(item);
      this._formSession = {
        values: prefill ? { ...prefill } : {},
        editTarget,
      };
      this._formError = null;
      this._expandedItemKey = this._itemKey(item) + (opts.offSchedule ? ':offschedule' : '');
      return;
    }

    if (maxPerDay > 1) {
      // Multi mode, no form: each tap stacks a fresh entry up to the cap.
      // The checkbox never unticks; entries are removed individually via
      // the day's entry list. At the cap a tap is a no-op rather than
      // silently dropping the oldest record.
      if (this._takenEntriesOn(item).length >= maxPerDay) return;
      const entry = { scheduledDate: this.date, takenAt: new Date().toISOString() };
      if (opts.offSchedule) entry.offSchedule = true;
      doses.push(entry);
      await this._persistDoses(item, doses);
      return;
    }

    if (alreadyTaken) {
      // Untick clears EVERY same-date taken entry: the readers use .some,
      // so a lingering taken duplicate (chat- or import-written) would
      // otherwise leave the checkbox stuck checked while taps silently
      // flipped only the first entry.
      for (let i = 0; i < doses.length; i++) {
        const d = doses[i];
        if (d.scheduledDate === this.date && d.takenAt) doses[i] = { ...d, takenAt: null };
      }
    } else if (idx >= 0) {
      const updated = { ...doses[idx], takenAt: new Date().toISOString() };
      if (opts.offSchedule) updated.offSchedule = true;
      doses[idx] = updated;
    } else {
      const entry = { scheduledDate: this.date, takenAt: new Date().toISOString() };
      if (opts.offSchedule) entry.offSchedule = true;
      doses.push(entry);
    }
    await this._persistDoses(item, doses);
  }

  async _removeDoseEntry(item, entry) {
    if (!this._canWrite) return;
    const doses = (item.doses || []).filter(d => d !== entry);
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
    const prev = this._resolvePreviousDose(doses);
    if (prev && formCfg.previousDoseFields.length > 0) {
      const merged = { ...prev.dose };
      for (const key of formCfg.previousDoseFields) {
        if (key in payload) merged[key] = payload[key];
      }
      doses[prev.index] = merged;
    }

    // Single mode: replace any existing same-date dose entry, otherwise
    // append. Multi mode (#705): the open-time form session decides.
    // Appends get the fresh takenAt; an at-cap edit MERGES onto its
    // target and keeps the original take time, or "edit" would silently
    // restamp the dose to now and drop fields the form never carried.
    const maxPerDay = this._maxReadingsPerDay();
    if (maxPerDay > 1) {
      const target = this._formSession?.editTarget;
      const ti = target ? doses.indexOf(target) : -1;
      if (ti >= 0) {
        doses[ti] = { ...target, ...newDose, takenAt: target.takenAt };
      } else {
        doses.push(newDose);
      }
    } else {
      const idx = doses.findIndex(d => d.scheduledDate === this.date);
      if (idx >= 0) doses[idx] = newDose; else doses.push(newDose);
    }

    this._expandedItemKey = null;
    this._formError = null;
    this._formSession = null;
    await this._persistDoses(item, doses);
  }

  // "Previous dose" for the retroactive-review merge. Single mode keeps
  // the shipped rule: latest taken entry on a PRIOR date (today's entry
  // is the one being edited). Multi mode (#705) resolves by recency
  // instead: today's earlier stacked entries are legitimate review
  // targets, and only an at-cap edit's own target is excluded, or the
  // 14:00 form would merge the 08:00 dose's review onto yesterday.
  _resolvePreviousDose(doses) {
    if (!Array.isArray(doses)) return null;
    if (this._maxReadingsPerDay() > 1) {
      const target = this._formSession?.editTarget;
      let best = -1;
      for (let i = 0; i < doses.length; i++) {
        const d = doses[i];
        if (!d || !d.takenAt || d === target) continue;
        if (best < 0 || d.takenAt > doses[best].takenAt) best = i;
      }
      return best >= 0 ? { dose: doses[best], index: best } : null;
    }
    for (let i = doses.length - 1; i >= 0; i--) {
      const d = doses[i];
      if (d && d.takenAt && d.scheduledDate !== this.date) return { dose: d, index: i };
    }
    return null;
  }

  _cancelCheckOffForm() {
    this._expandedItemKey = null;
    this._formError = null;
    this._formSession = null;
  }

  // The viewed day's taken entries, oldest first: time, form summary when
  // configured, and a per-entry remove. This is the untick surface in
  // multi mode, where the checkbox only ever adds (#705).
  _renderDayEntries(item) {
    const entries = this._takenEntriesOn(item);
    if (entries.length === 0) return '';
    const formCfg = this._checkOffFormConfig();
    return html`
      <div class="day-entries">
        ${entries.map(e => {
          const t = _entryTimeLabel(e);
          const summary = formCfg ? this._summariseDoseForCard(e, formCfg) : '';
          return html`
            <div class="day-entry">
              <span class="entry-time">${t}</span>
              ${summary ? html`<span class="entry-summary">${summary}</span>` : ''}
              ${this._canWrite ? html`
                <button
                  class="entry-remove"
                  @click=${() => this._removeDoseEntry(item, e)}
                  aria-label="remove the ${t} entry for ${item.name}"
                  title="Remove this entry"
                >✕</button>` : ''}
            </div>`;
        })}
      </div>`;
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

    // The prefill was snapshotted when the form opened (_toggleDose):
    // single mode prefills from the date's entry so re-tapping ✓ edits
    // it; multi mode (#705) starts BLANK under the cap (the tap logs
    // another entry) and prefills from the latest at the cap (Submit
    // then edits that entry). The snapshot's identity is stable across
    // re-renders, so eh-input-form never re-seeds over typed input when
    // unrelated state (badge toggle, entry remove) changes beside the
    // open form.
    const formValues = this._formSession?.values || {};
    // eh-input-form reseeds its internal state whenever the IDENTITY of
    // .values or .inputs changes. Both are frozen for the life of the
    // form session, or any re-render beside the open form (badge toggle,
    // entry remove) would wipe typed input.
    if (this._formSession && !this._formSession.inputs) {
      this._formSession.inputs = visibleInputs;
    }
    const formInputs = this._formSession?.inputs || visibleInputs;

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
          .inputs=${formInputs}
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
          const doseEntry = this._doseEntryOn(item);
          const isOffScheduleTaken = !!(taken && (isRestToday || doseEntry?.offSchedule));
          const itemKey = this._itemKey(item);
          const formKey = this._expandedItemKey;
          const formExpandedScheduled = formKey === itemKey;
          const formExpandedOffSchedule = formKey === itemKey + ':offschedule';
          const formCfg = this._checkOffFormConfig();
          const doseSummary = (formCfg && doseEntry && doseEntry.takenAt)
            ? this._summariseDoseForCard(doseEntry, formCfg) : '';
          const maxPerDay = this._maxReadingsPerDay();
          const takenToday = maxPerDay > 1 ? this._takenEntriesOn(item) : [];
          const entriesExpanded = this._entriesExpandedKey === itemKey;
          return html`
            <div class="item-row">
              <div class="item">
                ${this._renderRing(cp, colour)}
                <div class="info">
                  <div class="name">${item.short_name || item.name}</div>
                  ${this._doseLineVisible(isScheduledToday) ? html`<div class="dose">${this._doseLabel(item)}${item.dose_units ? ' · ' + item.dose_units + 'u' : ''}</div>` : ''}
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
                  ${maxPerDay > 1 && takenToday.length > 0 ? html`
                    <button
                      class="multi-count ${entriesExpanded ? 'open' : ''}"
                      @click=${() => { this._entriesExpandedKey = entriesExpanded ? null : itemKey; }}
                      aria-expanded=${entriesExpanded ? 'true' : 'false'}
                      aria-label="${entriesExpanded ? 'hide' : 'show'} ${takenToday.length} logged ${takenToday.length === 1 ? 'entry' : 'entries'} for ${item.name}"
                      title="Entries logged this day"
                    >×${takenToday.length}</button>` : ''}
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
              ${entriesExpanded ? this._renderDayEntries(item) : ''}
            </div>
          `;
        })}
      </div>
    `;
  }
}
customElements.define('eh-schedule-card', EhScheduleCard);
registerRenderer('schedule-card', 'eh-schedule-card');
