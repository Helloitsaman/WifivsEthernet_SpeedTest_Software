/* charts.js - tiny canvas chart helpers (no libraries, works offline) */
(function () {
  const C = {
    text: '#C9D1D9', muted: '#9AA4B2', grid: '#222934', axis: '#2A313C',
    accent: '#4CC9F0', eth: '#B794F6', good: '#3DDC97', ok: '#FFB547', bad: '#FF6B6B',
    mono: "11px 'IBM Plex Mono', ui-monospace, monospace",
  };

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(10, Math.round(rect.width));
    const h = Math.max(10, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // log scale helpers for latency (ms)
  const LOG_MIN = 0.1, LOG_MAX = 1000;
  function logY(v, top, bottom, lo = LOG_MIN, hi = LOG_MAX) {
    const x = Math.log10(Math.min(hi, Math.max(lo, v)));
    const a = Math.log10(lo), b = Math.log10(hi);
    return bottom - (x - a) / (b - a) * (bottom - top);
  }
  function fmtMs(v) { return v >= 1 ? String(Math.round(v)) : String(v); }

  function logGridY(ctx, L, R, T, B, lo, hi) {
    ctx.font = C.mono; ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of [0.1, 1, 10, 100, 1000]) {
      if (v < lo || v > hi) continue;
      const y = logY(v, T, B, lo, hi);
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, y + 0.5); ctx.lineTo(R, y + 0.5); ctx.stroke();
      ctx.fillText(fmtMs(v) + ' ms', L - 6, y);
    }
  }

  /** Scatter of packet latency over time (log y) + horizontal reference line. */
  function timeline(canvas, pts, opt) {
    const { ctx, w, h } = setup(canvas);
    const L = 56, R = w - 8, T = 8, B = h - 22;
    const lo = 0.1, hi = 1000;
    logGridY(ctx, L, R, T, B, lo, hi);
    const span = opt.span, t1 = opt.now, t0 = t1 - span;
    ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.font = C.mono;
    for (let s = 0; s <= span; s += 2) {
      const x = L + (s / span) * (R - L);
      ctx.fillText(s === span ? 'now' : `-${span - s}s`, x, B + 6);
    }
    ctx.globalAlpha = 0.55;
    for (const p of pts) {
      if (p.t < t0) continue;
      const x = L + ((p.t - t0) / span) * (R - L);
      const y = logY(p.lost ? hi : p.v, T, B, lo, hi);
      ctx.fillStyle = p.lost ? C.bad : C.accent;
      ctx.fillRect(x - 1, y - 1, 2.2, 2.2);
    }
    ctx.globalAlpha = 1;
    for (const ref of opt.refs || []) {
      const y = logY(ref.v, T, B, lo, hi);
      ctx.strokeStyle = ref.color; ctx.lineWidth = 2; ctx.setLineDash(ref.dash || []);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      const tw = ctx.measureText(ref.label).width;
      ctx.fillStyle = 'rgba(22,27,34,0.9)'; ctx.fillRect(L + 4, y - 17, tw + 8, 14);
      ctx.fillStyle = ref.color; ctx.fillText(ref.label, L + 8, y - 4);
    }
  }

  /** CDF curves, x = latency (log), y = fraction 0..1 */
  function cdf(canvas, series) {
    const { ctx, w, h } = setup(canvas);
    const L = 38, R = w - 10, T = 8, B = h - 22;
    const lo = 0.1, hi = 1000;
    const X = v => L + (Math.log10(Math.min(hi, Math.max(lo, v))) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (R - L);
    ctx.font = C.mono; ctx.fillStyle = C.muted;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of [0.1, 1, 10, 100, 1000]) {
      const x = X(v);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(x + 0.5, T); ctx.lineTo(x + 0.5, B); ctx.stroke();
      ctx.fillText(fmtMs(v) + (v === 1000 ? ' ms' : ''), x, B + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const f of [0, 0.5, 0.99]) {
      const y = B - f * (B - T);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, y + 0.5); ctx.lineTo(R, y + 0.5); ctx.stroke();
      ctx.fillText(f === 0.99 ? 'p99' : f === 0.5 ? 'p50' : '0', L - 5, y);
    }
    for (const s of series) {
      const v = s.values; if (!v.length) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
      const step = Math.max(1, Math.floor(v.length / 400));
      for (let i = 0; i < v.length; i += step) {
        const x = X(v[i]), y = B - (i / (v.length - 1 || 1)) * (B - T);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.lineTo(X(v[v.length - 1]), T); ctx.stroke();
    }
  }

  /** Vertical bars (one per item). values: [{v, color}] */
  function bars(canvas, values, opt = {}) {
    const { ctx, w, h } = setup(canvas);
    const L = 44, R = w - 6, T = 8, B = h - 18;
    const max = Math.max(1e-9, opt.max || Math.max(...values.map(d => d.v), 1));
    const nice = niceMax(max);
    ctx.font = C.mono; ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = nice * i / 4, y = B - (val / nice) * (B - T);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, y + 0.5); ctx.lineTo(R, y + 0.5); ctx.stroke();
      ctx.fillText(short(val), L - 5, y);
    }
    const n = values.length; if (!n) return;
    const bw = (R - L) / n, gap = bw > 6 ? Math.min(2, bw * 0.2) : 0;
    values.forEach((d, i) => {
      const bh = (d.v / nice) * (B - T);
      ctx.fillStyle = d.color;
      ctx.fillRect(L + i * bw + gap / 2, B - bh, Math.max(1, bw - gap), bh);
    });
    if (opt.xLabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = C.muted; ctx.fillText(opt.xLabel, (L + R) / 2, B + 4); }
  }

  /** Grouped bars: groups [{label, values:[...]}], series [{name,color,unit,max}] each series own scale */
  function grouped(canvas, groups, series) {
    const { ctx, w, h } = setup(canvas);
    const L = 8, R = w - 8, T = 22, B = h - 36;
    ctx.font = C.mono;
    // legend
    let lx = L;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    series.forEach(s => {
      ctx.fillStyle = s.color; ctx.fillRect(lx, 6, 10, 10);
      ctx.fillStyle = C.muted; ctx.fillText(s.name, lx + 14, 11);
      lx += ctx.measureText(s.name).width + 30;
    });
    const gw = (R - L) / groups.length;
    groups.forEach((g, gi) => {
      const x0 = L + gi * gw + gw * 0.12, inner = gw * 0.76, bw = inner / series.length;
      series.forEach((s, si) => {
        const v = g.values[si];
        const frac = Math.min(1, v / s.max);
        const bh = frac * (B - T - 14);
        ctx.fillStyle = s.color;
        ctx.fillRect(x0 + si * bw + 1, B - bh, bw - 2, bh);
        if (s.fmt) {
          ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(s.fmt(v), x0 + si * bw + bw / 2, B - bh - 2);
        }
      });
      ctx.fillStyle = g.highlight ? C.accent : C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(g.label, L + gi * gw + gw / 2, B + 5);
      if (g.sub) { ctx.fillStyle = C.muted; ctx.fillText(g.sub, L + gi * gw + gw / 2, B + 19); }
    });
    ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(L, B + 0.5); ctx.lineTo(R, B + 0.5); ctx.stroke();
  }

  /** Speedometer gauge (log-ish scale 0..1000 Mbps) */
  const GAUGE_STOPS = [0, 5, 10, 25, 50, 100, 250, 500, 1000];
  function gaugeFrac(v) {
    if (v <= 0) return 0;
    for (let i = 1; i < GAUGE_STOPS.length; i++) {
      if (v <= GAUGE_STOPS[i]) {
        const a = GAUGE_STOPS[i - 1], b = GAUGE_STOPS[i];
        return (i - 1 + (v - a) / (b - a)) / (GAUGE_STOPS.length - 1);
      }
    }
    return 1;
  }
  function gauge(canvas, value, opt = {}) {
    const { ctx, w, h } = setup(canvas);
    const cx = w / 2, cy = h * 0.62, r = Math.min(w * 0.42, h * 0.56);
    const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    ctx.lineCap = 'round';
    ctx.lineWidth = 16; ctx.strokeStyle = '#21262D';
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
    const f = gaugeFrac(value);
    ctx.strokeStyle = opt.color || C.accent;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.max(0.001, f)); ctx.stroke();
    ctx.font = C.mono; ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    GAUGE_STOPS.forEach((s, i) => {
      const a = a0 + (a1 - a0) * i / (GAUGE_STOPS.length - 1);
      ctx.fillText(String(s), cx + Math.cos(a) * (r - 30), cy + Math.sin(a) * (r - 30));
    });
    ctx.fillStyle = '#F5F7FA';
    ctx.font = "700 46px 'Space Grotesk', system-ui, sans-serif";
    ctx.fillText(opt.text != null ? opt.text : (value >= 100 ? value.toFixed(0) : value.toFixed(1)), cx, cy - 4);
    ctx.font = "13px 'IBM Plex Mono', monospace"; ctx.fillStyle = C.muted;
    ctx.fillText(opt.unit || 'Mbps', cx, cy + 30);
  }

  /** Ping samples: idle (accent) then loaded (red), log y */
  function pings(canvas, idle, loaded) {
    const { ctx, w, h } = setup(canvas);
    const L = 56, R = w - 8, T = 8, B = h - 10;
    const all = idle.concat(loaded);
    const hi = Math.max(10, Math.pow(10, Math.ceil(Math.log10(Math.max(1, ...all) * 1.2))));
    const lo = 0.1;
    logGridY(ctx, L, R, T, B, lo, hi);
    const n = Math.max(1, all.length);
    const dx = (R - L) / n;
    all.forEach((v, i) => {
      const y = logY(v, T, B, lo, hi);
      ctx.fillStyle = i < idle.length ? C.accent : C.bad;
      ctx.fillRect(L + i * dx + 0.5, y, Math.max(1, dx - 1), B - y);
    });
  }

  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function short(v) {
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'G';
    if (v >= 10) return v.toFixed(0);
    if (v >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }

  window.Charts = { setup, timeline, cdf, bars, grouped, gauge, pings, colors: C };
})();
