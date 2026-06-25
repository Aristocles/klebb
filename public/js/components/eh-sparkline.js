// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/eh-sparkline.js
// Standalone trend-glyph: maps a number[] to an inline SVG polyline.
//
// Deliberately NOT an EhChartBase/EhBaseCard subclass and it never
// imports ECharts: that library is ~1MB and assumes one ~240px chart
// per card. A 64x22 inline sparkline cannot justify that weight, so
// this is a dumb, dependency-free Lit element doing only the maths in
// sparkline.esm.js. Colours come from inherited CSS custom properties
// (--accent, --chart-grid, --warning/--danger/--success) so the glyph
// tracks dark/light with no JS theme code and no getComputedStyle.

import { LitElement, html, svg, css } from 'https://esm.sh/lit@3';
import { buildSparklinePath, referenceY, summarise, MIN_POINTS }
  from '../lib/sparkline.esm.js';

export class EhSparkline extends LitElement {
  static properties = {
    values: { type: Array },
    mode: { type: String },
    width: { type: Number },
    height: { type: Number },
    baseline: { type: Number },
    threshold: { type: Number },
    colour: { type: String },
  };

  constructor() {
    super();
    this.values = [];
    this.mode = 'line';
    this.width = 64;
    this.height = 22;
    this.baseline = null;
    this.threshold = null;
    this.colour = null;
  }

  static styles = css`
    :host {
      display: inline-block;
      line-height: 0;
      color: var(--accent);
    }
    svg { display: block; overflow: visible; }
    .line {
      fill: none;
      stroke: var(--spark-colour, var(--accent));
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .dot { fill: var(--spark-colour, var(--accent)); }
    .bar {
      fill: var(--spark-colour, var(--accent));
      stroke: none;
    }
    .gap { fill: var(--chart-grid, currentColor); opacity: 0.35; }
    .ref {
      stroke: var(--chart-grid, currentColor);
      stroke-dasharray: 2 3;
      opacity: 0.6;
    }
  `;

  render() {
    const W = this.width;
    const H = this.height;
    const pad = 2;
    const opts = { width: W, height: H, pad };

    if (this.mode === 'adherence') return this._renderAdherence(W, H, pad);

    const built = buildSparklinePath(this.values, opts);
    if (built.count < MIN_POINTS) { this._applyHostA11y(null); return html``; }

    const sum = summarise(this.values);
    const baselineY = referenceY(this.values, this.baseline, opts);
    const thresholdY = referenceY(this.values, this.threshold, opts);
    const style = this.colour ? `--spark-colour:${this.colour}` : '';
    this._applyHostA11y(sum.label);

    return html`
      <svg
        viewBox="0 0 ${W} ${H}"
        width="${W}"
        height="${H}"
        preserveAspectRatio="none"
        aria-hidden="true"
        style="${style}"
      >
        ${baselineY == null ? '' : svg`<line class="ref" x1="0" y1="${baselineY}" x2="${W}" y2="${baselineY}"></line>`}
        ${thresholdY == null ? '' : svg`<line class="ref" x1="0" y1="${thresholdY}" x2="${W}" y2="${thresholdY}"></line>`}
        ${this.mode === 'bar'
          ? this._bars(built, W, H, pad)
          : svg`<polyline class="line" points="${built.points}"></polyline>`}
        ${built.lastPoint
          ? svg`<circle class="dot" cx="${built.lastPoint.x}" cy="${built.lastPoint.y}" r="1.6"></circle>`
          : ''}
      </svg>
    `;
  }

  _bars(built, W, H, pad) {
    const pts = built.points.split(' ').map(p => {
      const [x, y] = p.split(',').map(Number);
      return { x, y };
    });
    const bw = Math.max(1, ((W - 2 * pad) / pts.length) * 0.6);
    return pts.map(p => svg`<rect class="bar" x="${p.x - bw / 2}" y="${p.y}"
      width="${bw}" height="${Math.max(0.5, H - pad - p.y)}"></rect>`);
  }

  // Adherence: render the window as small bars/dots, one per slot, with
  // nulls as faint gap ticks so a missed day reads as a gap not a zero.
  // Values are treated as a 0..1 ratio (1 = taken, 0 = missed).
  _renderAdherence(W, H, pad) {
    const slots = Array.isArray(this.values) ? this.values : [];
    if (slots.length < MIN_POINTS) { this._applyHostA11y(null); return html``; }

    const sum = summarise(this.values);
    const style = this.colour ? `--spark-colour:${this.colour}` : '';
    this._applyHostA11y(`adherence, ${sum.label}`);
    const n = slots.length;
    const gap = 1;
    const bw = Math.max(1, (W - 2 * pad - gap * (n - 1)) / n);
    const top = pad;
    const full = H - 2 * pad;

    const bars = slots.map((v, i) => {
      const x = pad + i * (bw + gap);
      if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) {
        return svg`<rect class="gap" x="${x}" y="${H / 2 - 0.5}" width="${bw}" height="1"></rect>`;
      }
      const ratio = Math.max(0, Math.min(1, Number(v)));
      const h = Math.max(0.5, full * ratio);
      return svg`<rect class="bar" x="${x}" y="${top + (full - h)}" width="${bw}" height="${h}"></rect>`;
    });

    return html`
      <svg
        viewBox="0 0 ${W} ${H}"
        width="${W}"
        height="${H}"
        preserveAspectRatio="none"
        aria-hidden="true"
        style="${style}"
      >${bars}</svg>
    `;
  }

  // The inner <svg> is decorative (aria-hidden); the host carries the
  // summary so assistive tech announces direction + latest once. Clear
  // both when there is nothing to render so no stale glyph is read out.
  _applyHostA11y(label) {
    if (label) {
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', label);
    } else {
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    }
  }
}

customElements.define('eh-sparkline', EhSparkline);
