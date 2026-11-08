// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-base-card.js
// Base class for every generic renderer card.
//
// Every card receives:
//   .card        - the manifest entry { id, meta, viewConfig }
//   .data        - data block fetched from /api/manifests/:id/data
//   .date        - ISO date string (YYYY-MM-DD) representing the current DateView context
//   .dateMode    - "today" | "past" | "future"
//   .config      - the meta.<viewName> block for the current view
//   .writeable   - { fromWebapp, pastAllowed, todayAllowed, futureAllowed }
//
// Subclasses implement renderCard() and optionally renderExpanded().
// The base handles the shell chrome: header, expand/collapse, loading,
// and error states. All styling uses CSS variables so light/dark themes
// work automatically.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import {
  fetchManifestData, fetchSelectedManifestData, saveManifestData,
  peekManifestData, isManifestDataFresh, hasPendingManifestWrite,
  manifestCacheRevision, scheduleReadRetry,
} from '../lib/manifest-reads.js';
export { invalidateManifestCache } from '../lib/manifest-reads.js';
const DATA_TTL_MS = 20000;

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
    saving: { state: true },
    saveError: { state: true },
    readStatus: { state: true },
    _refreshing: { state: true },
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
    this._cancelReadRetry = null;
    this._requestIdentity = null;
    this._loadedIdentity = null;
    this._hasOrdinaryData = false;
    this._onManifestDataChanged = event => {
      const id = event?.detail?.cardId || event?.detail?.id;
      if (this.isConnected && this.card?.id && (!id || id === this.card.id)) {
        if (event?.detail?.cacheUpdated && !this.card.meta?.healthConnectDisplay) {
          // The writer already holds its candidate. Other readers can use
          // the confirmed snapshot without unmounting their open forms.
          if (this.saving) return;
          const cached = peekManifestData(this.card.id);
          if (cached !== undefined) {
            this._adoptConfirmedData(cached);
            this.saveError = null;
            return;
          }
        }
        // The shared module already invalidated before any reader listener.
        this._fetchData();
      }
    };
    this._onManifestSaveFailed = event => {
      if (this.isConnected && event?.detail?.cardId === this.card?.id) {
        this.saveError = event.detail.error;
        this.requestUpdate();
      }
    };
    this.date = null;
    this.dateMode = 'today';
    this.headerless = false;
    this.expanded = false;
    this.loading = true;
    this.error = null;
    this.saving = false;
    this.saveError = null;
    this.readStatus = null;
    this._refreshing = false;
    this._onVisible = () => {
      if (document.visibilityState === 'visible') this._refreshData();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('manifest-data-changed', this._onManifestDataChanged);
    window.addEventListener('manifest-data-save-failed', this._onManifestSaveFailed);
    document.addEventListener('visibilitychange', this._onVisible);
    this._fetchData();
  }

  disconnectedCallback() {
    this._dataRequest++;
    this._requestIdentity = null;
    this._cancelReadRetry?.();
    this._cancelReadRetry = null;
    clearTimeout(this._selectedRefreshTimer);
    this._selectedRefreshTimer = null;
    window.removeEventListener('manifest-data-changed', this._onManifestDataChanged);
    window.removeEventListener('manifest-data-save-failed', this._onManifestSaveFailed);
    document.removeEventListener('visibilitychange', this._onVisible);
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
    const dateChanged = changed.has('date') && changed.get('date') != null
      && changed.get('date') !== this.date;
    if (dateChanged) {
      // Stable date navigation keeps the renderer, so close only the old
      // date's unsaved form. An already-issued save keeps its own snapshot.
      this._closeEdit?.();
      this._cancelCheckOffForm?.();
      if ('_entriesExpandedKey' in this) this._entriesExpandedKey = null;
    }
    if (changed.has('card')) {
      const previous = changed.get('card');
      if (previous?.id !== this.card?.id
          || JSON.stringify(previous?.meta?.healthConnectDisplay || null)
            !== JSON.stringify(this.card?.meta?.healthConnectDisplay || null)) {
        if (this._requestIdentity !== this._identity()) {
          this._hasOrdinaryData = false;
          this.data = null;
          this._fetchData();
        }
        return;
      } else if (previous !== this.card) {
        // A list reload can replace metadata without changing identity.
        // Check shared freshness, including central scope invalidation.
        this._refreshData();
        return;
      }
    }
    if (dateChanged) this._refreshData();
  }

  _identity() {
    return JSON.stringify([this.card?.id, this.card?.meta?.healthConnectDisplay || null]);
  }

  _adoptConfirmedData(data) {
    this._cancelReadRetry?.();
    this._cancelReadRetry = null;
    this._dataRequest++;
    this.data = data;
    this.projection = null;
    this.error = null;
    this.readStatus = null;
    this.loading = false;
    this._refreshing = false;
    this._loadedIdentity = this._identity();
    this._hasOrdinaryData = true;
  }

  _refreshData() {
    if (!this.card?.id || !this.isConnected) return;
    if (!this.card.meta?.healthConnectDisplay) {
      if (this.saving) return;
      if (this._loadedIdentity === this._identity() && isManifestDataFresh(this.card.id)) {
        const confirmed = peekManifestData(this.card.id);
        if (confirmed !== undefined && (confirmed !== this.data || this.readStatus || this.error)) {
          this._adoptConfirmedData(confirmed);
        }
        return;
      }
    }
    this._fetchData();
  }

  async _fetchData(retry = false) {
    if (!this.card?.id || !this.isConnected) return;
    this._cancelReadRetry?.();
    this._cancelReadRetry = null;
    clearTimeout(this._selectedRefreshTimer);
    this._selectedRefreshTimer = null;
    const card = this.card;
    const id = card.id;
    const selected = card.meta?.healthConnectDisplay || null;
    const selection = JSON.stringify(selected);
    const identity = this._identity();
    this._requestIdentity = identity;
    const request = ++this._dataRequest;
    const cacheRevision = manifestCacheRevision(id);
    const current = () => this.isConnected && request === this._dataRequest
      && (selected || cacheRevision === manifestCacheRevision(id))
      && id === this.card?.id && (!selected || card === this.card)
      && selection === JSON.stringify(this.card?.meta?.healthConnectDisplay || null);
    const retain = !selected && this._hasOrdinaryData && this._loadedIdentity === identity;
    this.loading = !retain;
    this._refreshing = true;
    this.error = null;
    this.readStatus = null;
    this.projection = null;
    if (!retain) {
      this.data = null;
      this._hasOrdinaryData = false;
      this._loadedIdentity = null;
    }
    try {
      const result = selected ? await fetchSelectedManifestData(id)
        : { data: await fetchManifestData(id, current), projection: null };
      if (!current()) return;
      this.data = result.data;
      this.projection = result.projection;
      this._loadedIdentity = identity;
      this._hasOrdinaryData = !selected;
    } catch (e) {
      if (current()) {
        if (e.transient) {
          this.readStatus = e.status === 429 ? e.message
            : 'Updates are temporarily unavailable. Please try again shortly.';
          if (!selected) {
            const confirmed = peekManifestData(id);
            if (confirmed !== undefined) {
              this.data = confirmed;
              this._loadedIdentity = identity;
              this._hasOrdinaryData = true;
            } else {
              this.data = null;
              this._hasOrdinaryData = false;
            }
          }
          // A locally blocked check does not spend the one recovery GET.
          // Another response can extend the global deadline meanwhile.
          if (e.retryAt && (!retry || e.blocked)) {
            this._cancelReadRetry = scheduleReadRetry(e.retryAt, () => {
              this._cancelReadRetry = null;
              if (current()) this._fetchData(true);
            });
          }
        } else {
          this.error = e.message || 'fetch failed';
          this.data = null;
          this._hasOrdinaryData = false;
        }
      }
    } finally {
      if (current()) {
        this.loading = false;
        this._refreshing = false;
      }
      if (this.isConnected && request === this._dataRequest && id === this.card?.id
          && (!selected || card === this.card)
          && selection === JSON.stringify(this.card?.meta?.healthConnectDisplay || null)) {
        if (!selected && cacheRevision !== manifestCacheRevision(id)) this._fetchData();
        else this._scheduleSelectedRefresh();
      }
    }
  }

  async _saveData(nextData) {
    if (!this._canWrite) return false;
    const id = this.card.id;
    const previous = this.data;
    this.saving = true;
    this.saveError = null;
    this.data = nextData;
    try {
      await saveManifestData(id, nextData);
      return true;
    } catch (error) {
      if (id === this.card?.id && !this.card.meta?.healthConnectDisplay) {
        this.data = previous;
        this.saveError = error.message || 'Could not save. Please try again.';
      }
      return false;
    } finally {
      this.saving = false;
    }
  }

  // Subclasses override these
  renderCard() {
    return html`<div class="card-body">-</div>`;
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
    if (this.saving || this.loading || this._refreshing || this.readStatus
        || this.error || hasPendingManifestWrite(this.card?.id)) return false;
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
    .read-status {
      padding: 10px 14px;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-hover, rgba(255,255,255,0.03));
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
        ${this.readStatus ? html`<div class="read-status" role="status">${this.readStatus}</div>` : ''}
        ${this.saveError ? html`<div class="error-placeholder" role="alert">${this.saveError}</div>` : ''}
        ${!this.loading && !this.error && (!this.readStatus || this._hasOrdinaryData) ? html`<div class="card-body">${this._safeRender(() => this.renderCard())}</div>` : ''}
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
      ${this.readStatus ? html`<div class="read-status" role="status">${this.readStatus}</div>` : ''}
      ${this.saveError ? html`<div class="error-placeholder" role="alert">${this.saveError}</div>` : ''}
      ${!this.loading && !this.error && (!this.readStatus || this._hasOrdinaryData) ? html`
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
