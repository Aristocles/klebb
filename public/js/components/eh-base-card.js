// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-base-card.js
// Base class for every generic renderer card.
//
// Every card receives:
//   .card        — the manifest entry { id, meta, viewConfig }
//   .data        — data block fetched from /api/manifests/:id/data
//   .date        — ISO date string (YYYY-MM-DD) representing the current DateView context
//   .dateMode    — "today" | "past" | "future"
//   .config      — the meta.<viewName> block for the current view
//   .writeable   — { fromWebapp, pastAllowed, todayAllowed, futureAllowed }
//
// Subclasses implement renderCard() and optionally renderExpanded().
// The base handles the shell chrome: header, expand/collapse, loading,
// and error states. All styling uses CSS variables so light/dark themes
// work automatically.

import { LitElement, html, css } from 'https://esm.sh/lit@3';

// Module-level data cache: id -> { data, fetchedAt, inflight }
// TTL: 20 seconds. Cuts duplicate fetches when the same card gets
// re-mounted during navigation (date switches, tab switches).
const _dataCache = new Map();
const _cacheRevisions = new Map();
const DATA_TTL_MS = 20000;

async function fetchManifestData(id, current) {
  const now = Date.now();
  const cached = _dataCache.get(id);
  if (cached && now - cached.fetchedAt < DATA_TTL_MS && !cached.inflight) {
    return cached.data;
  }
  if (cached && cached.inflight) return cached.inflight;
  const entry = { data: cached?.data ?? null, fetchedAt: cached?.fetchedAt ?? 0, inflight: null };
  const p = (async () => {
    try {
      const res = await fetch(`/api/manifests/${encodeURIComponent(id)}/data`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (Object.hasOwn(body, 'projection')) {
        if (_dataCache.get(id) === entry) _dataCache.delete(id);
        throw new Error('Saved source changed; refresh the card');
      }
      if (_dataCache.get(id) === entry) {
        if (current()) {
          entry.data = body.data;
          entry.fetchedAt = Date.now();
          entry.inflight = null;
        } else _dataCache.delete(id);
      }
      return body.data;
    } catch (error) {
      if (_dataCache.get(id) === entry) _dataCache.delete(id);
      throw error;
    }
  })();
  entry.inflight = p;
  _dataCache.set(id, entry);
  return p;
}

// Exported for writes — after a card POSTs data, invalidate its cache entry
async function fetchSelectedManifestData(id) {
  const res = await fetch(`/api/manifests/${encodeURIComponent(id)}/data`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.data) || !body.projection
      || !['saved', 'pending'].includes(body.projection.state)
      || !/^sha256:[a-f0-9]{64}$/.test(body.projection.revision)) {
    throw new Error('Saved data status is unavailable');
  }
  return body;
}

export function invalidateManifestCache(id) {
  _cacheRevisions.set(id, (_cacheRevisions.get(id) || 0) + 1);
  _dataCache.delete(id);
}

export class EhBaseCard extends LitElement {
  // Opt-in: real data-card renderers set this true to show a settings
  // gear in the header. Synthetic/system cards (welcome, unknown) leave
  // it false so they never offer to PATCH a manifest that shouldn't be
  // edited from a per-card gear.
  static supportsSettingsGear = false;

  static properties = {
    card: { type: Object },          // { id, meta, viewConfig }
    data: { state: true },
    projection: { state: true },
    date: { type: String },
    dateMode: { type: String },      // today | past | future
    expanded: { state: true },
    loading: { state: true },
    error: { state: true },
    // When true, render only the card body (no header). Used when a card is
    // mounted as a sub-element inside another card's expanded region, so the
    // host card's header isn't duplicated.
    headerless: { type: Boolean },
  };

  constructor() {
    super();
    this.card = null;
    this.data = null;
    this.projection = null;
    this._dataRequest = 0;
    this._selectedRefreshTimer = null;
    this._onManifestDataChanged = event => {
      const id = event?.detail?.cardId || event?.detail?.id;
      if (this.isConnected && this.card?.meta?.healthConnectDisplay
          && (!id || id === this.card?.id)) {
        invalidateManifestCache(this.card.id);
        this._fetchData();
      }
    };
    this.date = null;
    this.dateMode = 'today';
    this.headerless = false;
    this.expanded = false;
    this.loading = true;
    this.error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('manifest-data-changed', this._onManifestDataChanged);
    this._fetchData();
  }

  disconnectedCallback() {
    this._dataRequest++;
    if (this.card?.id) invalidateManifestCache(this.card.id);
    clearTimeout(this._selectedRefreshTimer);
    this._selectedRefreshTimer = null;
    window.removeEventListener('manifest-data-changed', this._onManifestDataChanged);
    super.disconnectedCallback();
  }

  _scheduleSelectedRefresh() {
    clearTimeout(this._selectedRefreshTimer);
    this._selectedRefreshTimer = null;
    if (!this.isConnected || !this.card?.meta?.healthConnectDisplay) return;
    this._selectedRefreshTimer = setTimeout(() => {
      this._selectedRefreshTimer = null;
      if (this.isConnected) this._fetchData();
    }, DATA_TTL_MS);
  }

  updated(changed) {
    if (changed.has('card') && changed.get('card') !== undefined) {
      const previous = changed.get('card');
      if (previous?.id !== this.card?.id
          || JSON.stringify(previous?.meta?.healthConnectDisplay || null)
            !== JSON.stringify(this.card?.meta?.healthConnectDisplay || null)
          || this.card?.meta?.healthConnectDisplay) {
        if (previous?.id) invalidateManifestCache(previous.id);
        if (this.card?.id) invalidateManifestCache(this.card.id);
        this._fetchData();
        return;
      }
    }
    if (this.card?.meta?.healthConnectDisplay && changed.has('date')
        && changed.get('date') !== undefined) this._fetchData();
  }

  async _fetchData() {
    if (!this.card?.id) return;
    clearTimeout(this._selectedRefreshTimer);
    this._selectedRefreshTimer = null;
    const card = this.card;
    const id = card.id;
    const selected = card.meta?.healthConnectDisplay || null;
    const selection = JSON.stringify(selected);
    const request = ++this._dataRequest;
    if (selected) invalidateManifestCache(id);
    const cacheRevision = _cacheRevisions.get(id) || 0;
    const current = () => this.isConnected && request === this._dataRequest
      && (selected || cacheRevision === (_cacheRevisions.get(id) || 0))
      && id === this.card?.id && (!selected || card === this.card)
      && selection === JSON.stringify(this.card?.meta?.healthConnectDisplay || null);
    this.loading = true;
    this.error = null;
    this.projection = null;
    try {
      const result = selected ? await fetchSelectedManifestData(id)
        : { data: await fetchManifestData(id, current), projection: null };
      if (!current()) return;
      this.data = result.data;
      this.projection = result.projection;
    } catch (e) {
      if (current()) this.error = e.message || 'fetch failed';
    } finally {
      if (current()) this.loading = false;
      if (this.isConnected && request === this._dataRequest && id === this.card?.id
          && (!selected || card === this.card)
          && selection === JSON.stringify(this.card?.meta?.healthConnectDisplay || null)) {
        if (!selected && cacheRevision !== (_cacheRevisions.get(id) || 0)) this._fetchData();
        else this._scheduleSelectedRefresh();
      }
    }
  }

  // Subclasses override these
  renderCard() {
    return html`<div class="card-body">—</div>`;
  }

  renderExpanded() {
    return html`<div class="card-expanded">No detail available.</div>`;
  }

  // Is this view's click-expand enabled for this card?
  get _canExpand() {
    const exp = this.card?.viewConfig?.expanded;
    return exp && exp.enabled === true;
  }

  // A subclass that renders its own expand control (next to whatever the
  // expansion is *about*) sets this true so the header indicator is
  // suppressed and the card shows exactly one chevron. See #572.
  get _ownsExpandControl() {
    return false;
  }

  get _config() {
    return this.card?.viewConfig || {};
  }

  get _meta() {
    return this.card?.meta || {};
  }

  // Can we edit on this date?
  get _canWrite() {
    const w = this._meta.writeable;
    if (this._meta.healthConnectDisplay) return false;
    if (!w || !w.fromWebapp) return false;
    if (this.dateMode === 'today')  return w.todayAllowed !== false;
    if (this.dateMode === 'past')   return w.pastAllowed === true;
    if (this.dateMode === 'future') return w.futureAllowed === true;
    return false;
  }

  get _showSettingsGear() {
    // headerless sub-cards never own the gear (the host card does).
    return !this.headerless
      && this.constructor.supportsSettingsGear === true
      && !!this.card?.id;
  }

  _openSettings(e) {
    // Don't let the click bubble to the header's expand handler.
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('eh-open-card-settings', {
      detail: { id: this.card.id, component: this.card?.viewConfig?.component || null },
    }));
  }

  _toggleExpand() {
    if (!this._canExpand) return;
    this.expanded = !this.expanded;
    // Broadcast the card the user just opened so the chat can resolve
    // vague references ("change the target to 80kg") against it. Only on
    // expand, not collapse: collapsing doesn't change what they're looking at.
    if (this.expanded && this.card?.id) {
      window.dispatchEvent(new CustomEvent('klebb-card-focused', { detail: { id: this.card.id } }));
    }
  }

  static styles = css`
    :host {
      display: block;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.08));
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px 6px;
      cursor: default;
      user-select: none;
    }
    .card-header.clickable { cursor: pointer; }
    .card-header.clickable:hover { background: var(--bg-hover, rgba(255,255,255,0.03)); }
    .title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--text-muted, var(--text-secondary));
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title .emoji { font-size: 14px; }
    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .expand-indicator {
      color: var(--text-muted, var(--text-secondary));
      font-size: 11px;
      transition: transform 0.15s;
    }
    .expand-indicator.open { transform: rotate(180deg); }
    .settings-gear {
      background: transparent;
      border: none;
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      line-height: 1;
      padding: 2px 4px;
      cursor: pointer;
      border-radius: 6px;
      opacity: 0.55;
      transition: opacity 0.15s, color 0.15s;
    }
    .settings-gear:hover { opacity: 1; color: var(--text-primary); }
    .settings-gear:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; opacity: 1; }
    @media (prefers-reduced-motion: reduce) {
      .expand-indicator, .settings-gear { transition: none; }
    }
    .card-body { padding: 6px 16px 16px; }
    .card-expanded {
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border);
      background: var(--bg-input, transparent);
    }
    .future-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      background: var(--accent-bg, rgba(255,170,0,0.15));
      color: var(--accent-amber, #ffaa00);
      font-weight: 600;
    }
    .past-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      background: var(--bg-hover, rgba(255,255,255,0.05));
      color: var(--text-muted, var(--text-secondary));
      font-weight: 600;
    }
    .error-placeholder {
      padding: 10px 14px;
      font-size: 12px;
      color: var(--accent-red, #ff4444);
      background: rgba(255, 68, 68, 0.06);
      border-top: 1px solid var(--border);
    }
    .loading {
      padding: 16px;
      font-size: 12px;
      color: var(--text-muted, var(--text-secondary));
      text-align: center;
    }
  `;

  render() {
    const m = this._meta;
    if (this.headerless) {
      return html`
        ${this.loading ? html`<div class="loading">Loading…</div>` : ''}
        ${this.error ? html`<div class="error-placeholder">⚠︎ ${this.error}</div>` : ''}
        ${!this.loading && !this.error ? html`<div class="card-body">${this._safeRender(() => this.renderCard())}</div>` : ''}
      `;
    }
    return html`
      <div
        class="card-header ${this._canExpand ? 'clickable' : ''}"
        @click=${this._canExpand ? this._toggleExpand : undefined}
        aria-expanded=${this._canExpand ? String(this.expanded) : undefined}
      >
        <div class="title">
          ${m.emoji ? html`<span class="emoji">${m.emoji}</span>` : ''}
          <span>${m.label || m.id || ''}</span>
          ${this.projection ? html`<span class="past-badge">${this.projection.state === 'saved' ? 'Saved' : 'Pending'}</span>` : ''}
          ${this.dateMode === 'future' ? html`<span class="future-badge">🔮 Planned</span>` : ''}
          ${this.dateMode === 'past'   ? html`<span class="past-badge">Past</span>` : ''}
        </div>
        <div class="header-right">
          ${this._canExpand && !this._ownsExpandControl ? html`
            <span class="expand-indicator ${this.expanded ? 'open' : ''}">▼</span>
          ` : ''}
          ${this._showSettingsGear ? html`
            <button
              class="settings-gear"
              type="button"
              aria-label="Card settings"
              title="Card settings"
              @click=${this._openSettings}
            >⚙️</button>
          ` : ''}
        </div>
      </div>
      ${this.loading ? html`<div class="loading">Loading…</div>` : ''}
      ${this.error ? html`<div class="error-placeholder">⚠︎ ${this._meta.label || this.card?.id}: ${this.error}</div>` : ''}
      ${!this.loading && !this.error ? html`
        <div class="card-body">${this._safeRender(() => this.renderCard())}</div>
        ${this.expanded ? html`<div class="card-expanded">${this._safeRender(() => this.renderExpanded())}</div>` : ''}
      ` : ''}
    `;
  }

  _safeRender(fn) {
    try {
      return fn();
    } catch (e) {
      console.error(`[${this.card?.id || 'card'}] render error`, e);
      return html`<div class="error-placeholder">Render failed: ${e.message}</div>`;
    }
  }
}
