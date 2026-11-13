import React, { useEffect, useMemo, useRef, useState } from 'react';
import { logGrid, totalResponse, bandResponse, resample, smooth, meanIn, GAIN_LIMIT } from '../utils/autoEqMath';

// Canvas EQ graph: draws the filter curve, optional measurement / target / result curves and one
// handle per band sitting on the curve. Drag a handle to move it (Shift: gain only, Alt:
// frequency only), scroll on it to change Q, double-click to flatten it.

const F_MIN = 20, F_MAX = 20000;
const PAD = { l: 40, r: 12, t: 10, b: 24 };
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const GRID = logGrid(360);
const HIT = 13;

const fmtHz = (f) => (f >= 1000 ? `${Number((f / 1000).toFixed(f >= 10000 ? 1 : 2))}k` : `${Math.round(f)}`);
const fmtDb = (g) => `${g > 0 ? '+' : ''}${g.toFixed(1)} dB`;

const EqGraph = ({ bands, measurement, target, smoothing = 1 / 12, yRange = 12, selected, onSelect, onChange, onCommit, spectrum = null, liveFreqs = null }) => {
  const liveRef = useRef(null);
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
  const drag = useRef(null);
  const live = useRef({});
  const wheelCommit = useRef(null);

  // Curves are lined up the way AutoEQ sees them: target averaged to 0 dB over 300 Hz–3 kHz,
  // measurement shifted onto the target
  const curves = useMemo(() => {
    if (!measurement?.length && !target?.length) return null;
    const t = target?.length ? smooth(resample(target, GRID), GRID, smoothing) : null;
    const m = measurement?.length ? smooth(resample(measurement, GRID), GRID, smoothing) : null;
    const tOff = t ? meanIn(t, GRID) : 0;
    const mOff = m ? meanIn(m, GRID) : 0;
    return {
      target: t && t.map(v => v - tOff),
      measurement: m && m.map(v => v - mOff),
    };
  }, [measurement, target, smoothing]);

  // Response per band is cached, so dragging one band only recomputes that band
  const cache = useRef(new Map());
  const responses = useMemo(() => {
    const next = new Map();
    const list = bands.map((b) => {
      const key = `${b.type}|${b.freq}|${b.q}|${b.gain}`;
      const hit = cache.current.get(key) || bandResponse(b, GRID);
      next.set(key, hit);
      return hit;
    });
    cache.current = next;
    const total = new Float64Array(GRID.length);
    for (const r of list) for (let i = 0; i < total.length; i++) total[i] += r[i];
    return total;
  }, [bands]);

  const handles = useMemo(() => bands.map((b) => ({ f: b.freq, db: totalResponse(bands, [b.freq])[0] })), [bands]);

  // Geometry
  const plotW = Math.max(1, size.w - PAD.l - PAD.r);
  const plotH = Math.max(1, size.h - PAD.t - PAD.b);
  const xOf = (f) => PAD.l + (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * plotW;
  const fOf = (x) => F_MIN * Math.pow(F_MAX / F_MIN, (x - PAD.l) / plotW);
  const yOf = (db) => PAD.t + (1 - (db + yRange) / (2 * yRange)) * plotH;
  const dbPerPx = (2 * yRange) / plotH;
  live.current = { bands, handles, xOf, yOf, fOf, dbPerPx, onChange, onCommit, onSelect, selected };

  useEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    // colours come from CSS variables: redraw when the theme flips
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const css = getComputedStyle(canvas);
    const color = (v, fb) => css.getPropertyValue(v).trim() || fb;
    const c = {
      grid: color('--border', '#333'), axis: color('--text-3', '#888'), accent: color('--accent', '#f73'),
      meas: color('--info', '#5af'), target: color('--text-2', '#aaa'), result: color('--ok', '#5c8'), text: color('--text', '#fff'), surface: color('--surface', '#222'),
    };

    // grid + labels
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;
    ctx.fillStyle = c.axis;
    ctx.textAlign = 'center';
    for (const f of FREQ_TICKS) {
      const x = Math.round(xOf(f)) + 0.5;
      ctx.strokeStyle = c.grid;
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + plotH); ctx.stroke();
      ctx.fillText(fmtHz(f), x, size.h - 6);
    }
    const stepDb = yRange <= 12 ? 3 : yRange <= 24 ? 6 : 12;
    ctx.textAlign = 'right';
    for (let db = -yRange; db <= yRange; db += stepDb) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.strokeStyle = c.grid;
      ctx.globalAlpha = db === 0 ? 1 : 0.55;
      ctx.lineWidth = db === 0 ? 1.4 : 1;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + plotW, y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, PAD.l - 6, y + 4);
    }

    const line = (values, stroke, width, dash) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.l, PAD.t, plotW, plotH);
      ctx.clip();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      for (let i = 0; i < GRID.length; i++) {
        const x = xOf(GRID[i]), y = yOf(values[i]);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    if (curves?.target) line(curves.target, c.target, 1.6, [6, 5]);
    if (curves?.measurement) {
      line(curves.measurement, c.meas, 1.6);
      const result = curves.measurement.map((v, i) => v + responses[i]);
      line(result, c.result, 2.4);
    }
    // filter curve with a soft fill towards 0 dB
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t, plotW, plotH);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(xOf(GRID[0]), yOf(0));
    for (let i = 0; i < GRID.length; i++) ctx.lineTo(xOf(GRID[i]), yOf(responses[i]));
    ctx.lineTo(xOf(GRID[GRID.length - 1]), yOf(0));
    ctx.closePath();
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.restore();
    line(responses, c.accent, 2.4);

    // handles
    handles.forEach((h, i) => {
      const x = xOf(h.f), y = Math.max(PAD.t, Math.min(PAD.t + plotH, yOf(h.db)));
      const on = i === selected || i === hover;
      const flat = !bands[i].gain;
      ctx.beginPath();
      ctx.arc(x, y, on ? 7.5 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = on ? c.accent : flat ? c.surface : c.text;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = on ? c.text : flat ? c.axis : c.accent;
      ctx.stroke();
    });

    // tooltip for the hovered / dragged band
    const tipIdx = drag.current ? drag.current.idx : hover;
    if (tipIdx != null && bands[tipIdx]) {
      const b = bands[tipIdx];
      const label = `${tipIdx + 1} · ${b.type === 'Peak' ? 'PK' : b.type === 'LSF' ? 'LS' : 'HS'} ${fmtHz(b.freq)}Hz · ${fmtDb(b.gain)} · Q ${b.q.toFixed(2)}`;
      ctx.font = '600 12px "JetBrains Mono", monospace';
      const w = ctx.measureText(label).width + 18;
      const hx = xOf(handles[tipIdx].f), hy = yOf(handles[tipIdx].db);
      const x = Math.max(PAD.l, Math.min(PAD.l + plotW - w, hx - w / 2));
      const y = hy - 40 < PAD.t ? hy + 16 : hy - 40;
      ctx.fillStyle = c.surface;
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.roundRect(x, y, w, 24, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.text;
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 9, y + 16);
    }
  }, [size, bands, curves, responses, handles, yRange, selected, hover, theme]);

  // ---- interaction ----
  const pick = (x, y) => {
    const { handles: hs, xOf: xo, yOf: yo } = live.current;
    let best = null, bestD = HIT;
    hs.forEach((h, i) => {
      const d = Math.hypot(xo(h.f) - x, yo(h.db) - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const local = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const [x, y] = local(e);
    const idx = pick(x, y);
    live.current.onSelect(idx);
    if (idx == null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const b = live.current.bands[idx];
    drag.current = { idx, x0: x, y0: y, f0: b.freq, g0: b.gain, moved: false, raf: 0, pending: null };
  };

  const onPointerMove = (e) => {
    const [x, y] = local(e);
    const d = drag.current;
    if (!d) {
      const idx = pick(x, y);
      if (idx !== hover) setHover(idx);
      return;
    }
    const { fOf: fo, xOf: xo, dbPerPx } = live.current;
    const b = live.current.bands[d.idx];
    let freq = e.shiftKey ? d.f0 : fo(xo(d.f0) + (x - d.x0));
    let gain = e.altKey ? d.g0 : d.g0 + (d.y0 - y) * dbPerPx;
    freq = Math.min(F_MAX, Math.max(F_MIN, freq));
    freq = freq < 100 ? Math.round(freq * 10) / 10 : Math.round(freq);
    gain = Math.round(Math.min(GAIN_LIMIT, Math.max(-GAIN_LIMIT, gain)) * 10) / 10;
    if (freq === b.freq && gain === b.gain) return;
    d.moved = true;
    d.pending = { ...b, freq, gain };
    // one state update per frame, however fast the mouse moves
    if (!d.raf) d.raf = requestAnimationFrame(() => { d.raf = 0; if (d.pending) live.current.onChange(d.idx, d.pending); d.pending = null; });
  };

  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    if (d.raf) { cancelAnimationFrame(d.raf); if (d.pending) live.current.onChange(d.idx, d.pending); }
    drag.current = null;
    if (d.moved) live.current.onCommit(`Moved band ${d.idx + 1}`);
  };

  const onDoubleClick = (e) => {
    const [x, y] = local(e);
    const idx = pick(x, y);
    if (idx == null) return;
    live.current.onChange(idx, { ...live.current.bands[idx], gain: 0 });
    live.current.onCommit(`Flattened band ${idx + 1}`);
  };

  // Wheel must be non-passive to stop the page scrolling while adjusting Q
  useEffect(() => {
    const el = canvasRef.current;
    const onWheel = (e) => {
      const r = el.getBoundingClientRect();
      const idx = drag.current ? drag.current.idx : pick(e.clientX - r.left, e.clientY - r.top);
      if (idx == null) return;
      e.preventDefault();
      const b = live.current.bands[idx];
      const factor = Math.pow(e.shiftKey ? 1.02 : 1.08, e.deltaY < 0 ? 1 : -1);
      const q = Math.round(Math.min(20, Math.max(0.1, b.q * factor)) * 100) / 100;
      if (q === b.q) return;
      live.current.onSelect(idx);
      live.current.onChange(idx, { ...b, q });
      clearTimeout(wheelCommit.current);
      wheelCommit.current = setTimeout(() => live.current.onCommit(`Q of band ${idx + 1} → ${q}`), 500);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); clearTimeout(wheelCommit.current); };
  }, []);

  // The live spectrum, under the curves: its own scale, 0 dBFS at the top and -96 at the bottom
  useEffect(() => {
    const cv = liveRef.current;
    if (!cv || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== size.w * dpr || cv.height !== size.h * dpr) { cv.width = size.w * dpr; cv.height = size.h * dpr; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!spectrum?.length || !liveFreqs) return;
    const css = getComputedStyle(cv);
    const accent = css.getPropertyValue('--accent').trim() || '#f73';
    const yLive = (d) => PAD.t + (Math.min(0, Math.max(-96, d)) / -96) * plotH;
    // a smooth line through the middle of each band (quadratic curves between the midpoints)
    const pts = spectrum.map((d, i) => [xOf(liveFreqs[i]), yLive(d)]);
    const bottom = PAD.t + plotH;
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, PAD.t, plotW, plotH); ctx.clip();
    const trace = () => {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };
    ctx.beginPath(); trace();
    ctx.lineTo(pts[pts.length - 1][0], bottom); ctx.lineTo(pts[0][0], bottom); ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.t, 0, bottom);
    grad.addColorStop(0, accent); grad.addColorStop(1, 'transparent');
    ctx.globalAlpha = 0.14; ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); trace();
    ctx.globalAlpha = 0.4; ctx.strokeStyle = accent; ctx.lineWidth = 1.2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
  }, [spectrum, liveFreqs, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="eq-canvas" ref={wrapRef}>
      <canvas ref={liveRef} className="eq-live" style={{ width: size.w, height: size.h }} aria-hidden="true" />
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: drag.current ? 'grabbing' : hover != null ? 'grab' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => { if (!drag.current) setHover(null); }}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
};

export default EqGraph;
