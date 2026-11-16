import React, { useEffect, useRef, useState } from 'react';

// The track's loudness over time, behind the seek bar. Drawn twice: grey for what is to come, the accent
// for what has played. The played copy is cut with CSS (--pct, moved by the player bar every frame), so
// nothing is redrawn while the music plays.
const cache = new Map(); // path -> peaks, for this session

export function useWaveform(file, on) {
  const [peaks, setPeaks] = useState(null);
  useEffect(() => {
    if (!on || !file) { setPeaks(null); return undefined; }
    if (cache.has(file)) { setPeaks(cache.get(file)); return undefined; }
    setPeaks(null);
    let live = true;
    // a moment after the track starts, so the start of the music gets the computer first; a skipped track
    // never gets read at all
    const timer = setTimeout(() => {
      window.ipcRenderer.invoke('waveform:get', file).then((r) => {
        if (!r?.ok || !Array.isArray(r.peaks)) return;
        cache.set(file, r.peaks);
        if (cache.size > 40) cache.delete(cache.keys().next().value);
        if (live) setPeaks(r.peaks);
      }).catch(() => {});
    }, 1500);
    return () => { live = false; clearTimeout(timer); };
  }, [file, on]);
  return peaks;
}

const WaveSeek = ({ peaks }) => {
  const box = useRef(null);
  const base = useRef(null);
  const played = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [theme, setTheme] = useState(0);
  useEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    const mo = new MutationObserver(() => setTheme(t => t + 1)); // colours come from the theme
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);
  useEffect(() => {
    if (!peaks || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    const css = getComputedStyle(box.current);
    const draw = (cv, colour) => {
      cv.width = size.w * dpr; cv.height = size.h * dpr;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      ctx.fillStyle = colour;
      // one bar every 3 px, each the loudest of the peaks it covers, mirrored around the middle
      const step = 3, bar = 2, mid = size.h / 2;
      const n = Math.floor(size.w / step);
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i / n) * peaks.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length));
        let v = 0;
        for (let k = a; k < b; k++) v = Math.max(v, peaks[k] || 0);
        const h = Math.max(1.5, v * (size.h - 2));
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(i * step, mid - h / 2, bar, h, 1); else ctx.rect(i * step, mid - h / 2, bar, h);
        ctx.fill();
      }
    };
    draw(base.current, css.getPropertyValue('--wave-rest').trim() || 'rgba(128,128,128,.35)');
    draw(played.current, css.getPropertyValue('--accent').trim() || '#f73');
  }, [peaks, size.w, size.h, theme]);
  return (
    <div className={`wave ${peaks ? 'ready' : ''}`} ref={box} aria-hidden="true">
      <canvas ref={base} className="wave-rest" />
      <canvas ref={played} className="wave-played" />
    </div>
  );
};

export default WaveSeek;
