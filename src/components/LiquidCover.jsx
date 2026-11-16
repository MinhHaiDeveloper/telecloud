import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Cover from './Cover';
import { coverUrl } from '../utils/audio';

// A cover that pours into the next one when the album changes: a wavy front sweeps across while both
// pictures ripple, like paint running into water. Within one album, or with Reduce motion, it just swaps.
// Canvas 2D on purpose: the covers come from media://, which WebGL won't take as a texture.

const DURATION = 5000; // slow, like paint running into water
const albumOf = (f) => {
  if (!f) return '';
  const m = f.metadata || {};
  const album = (m.album || '').trim().toLowerCase();
  if (!album || album === 'unknown album') return `dir:${(f.path || '').replace(/[\\/][^\\/]*$/, '').toLowerCase()}`;
  return `${album}|${(m.albumArtist || m.artist || '').trim().toLowerCase()}`;
};
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const load = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
});

/** The part of the picture that fills the box, as object-fit: cover does; `zoom` crops in a little more */
const fit = (img, w, h, zoom = 1) => {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight) * zoom;
  const sw = w / s, sh = h / s;
  return { sx: (img.naturalWidth - sw) / 2, sy: (img.naturalHeight - sh) / 2, scale: s };
};

function Liquid({ from, to, onDone }) {
  const cv = useRef(null);
  useEffect(() => {
    let raf = 0;
    let dead = false;
    Promise.all([load(from), load(to)]).then(([a, b]) => {
      if (dead || !cv.current) return;
      const el = cv.current;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(el.clientWidth * dpr)), H = Math.max(1, Math.round(el.clientHeight * dpr));
      el.width = W; el.height = H;
      const ctx = el.getContext('2d');
      const strip = Math.max(2, Math.round(2 * dpr));
      const seed = Math.random() * 10;
      const seg = Math.max(3, Math.round(4 * dpr)); // width of the pieces the waves bend
      const lambda = W * 0.075; // from one crest to the next
      const CRESTS = 6;
      const start = performance.now();
      const frame = (now) => {
        const t = Math.max(0, Math.min(1, (now - start) / DURATION));
        el.dataset.t = t.toFixed(2); // how far along, for a look from outside
        const s = Math.max(0, (now - start) / 1000); // the waves move in seconds, whatever the length
        const p = ease(t);
        const swell = Math.sin(Math.PI * t); // the ripples grow, then settle
        // a touch of zoom while they ripple, so a picture pushed sideways never shows its edge (none at the ends)
        const zoom = 1 + 0.16 * swell;
        const fa = fit(a, W, H, zoom), fb = fit(b, W, H, zoom);
        // how far a wave pushes the picture, at distance d behind the front: crests rolling in
        const waveAt = (d, sec) => swell * W * 0.0065 * Math.sin((d / lambda) * Math.PI * 2 + sec * 5.6);
        ctx.clearRect(0, 0, W, H);
        for (let y = 0; y < H; y += strip) {
          const v = y / H;
          // the front: a slanted line that sweeps from left to right, bent by two waves
          const front = W * (-0.25 + p * 1.5) + W * 0.12 * (v - 0.5)
            + swell * W * (0.07 * Math.sin(v * 6.3 + seed + s * 2.2) + 0.035 * Math.sin(v * 17 + seed * 2 - s * 3.4));
          // each picture ripples sideways, more near the front and mid-way through
          const ripple = swell * W * 0.025 * Math.sin(v * 22 + seed - s * 4.2);
          const dA = ripple * 1.2 + swell * W * 0.035 * Math.sin(v * 5 + s * 1.9);
          const dB = -ripple - swell * W * 0.03 * Math.sin(v * 4.2 - s * 1.6);
          // the new picture pours in from the left, up to the front
          const x = Math.max(0, Math.min(W, front));
          // waves running in behind the front, like the sea onto a shore: inside a band behind it the picture is
          // drawn in short pieces, each pushed sideways by the wave it sits on, so the crests bend what is under them
          const zone = Math.min(x, W * 0.5);
          if (x - zone > 0) ctx.drawImage(b, fb.sx - dB / fb.scale, fb.sy + y / fb.scale, (x - zone) / fb.scale, strip / fb.scale, 0, y, x - zone, strip);
          if (zone > 0) {
            const n = Math.max(1, Math.ceil(zone / seg));
            const w = zone / n;
            for (let k = 0; k < n; k++) {
              const x0 = x - zone + k * w;
              const d = x - (x0 + w / 2); // how far behind the front
              const push = waveAt(d, s) * (1 - d / zone);
              ctx.drawImage(b, fb.sx + (x0 - dB - push) / fb.scale, fb.sy + y / fb.scale, (w + 0.5) / fb.scale, strip / fb.scale, x0, y, w + 0.5, strip);
            }
          }
          // the old one still right of it, with a short swell pushed ahead of the front (the shockwave)
          if (x < W) {
            const ahead = Math.min(W - x, W * 0.22);
            const n = Math.max(1, Math.ceil(ahead / seg));
            const w = ahead / n;
            for (let k = 0; k < n; k++) {
              const x0 = x + k * w;
              const d = x0 + w / 2 - x;
              const push = -waveAt(d * 1.2, s) * 0.7 * (1 - d / ahead);
              ctx.drawImage(a, fa.sx + (x0 - dA - push) / fa.scale, fa.sy + y / fa.scale, (w + 0.5) / fa.scale, strip / fa.scale, x0, y, w + 0.5, strip);
            }
            if (x + ahead < W) ctx.drawImage(a, fa.sx + (x + ahead - dA) / fa.scale, fa.sy + y / fa.scale, (W - x - ahead) / fa.scale, strip / fa.scale, x + ahead, y, W - x - ahead, strip);
          }
          if (front > 0 && front < W && swell > 0.05) {
            // a thin bright edge where the two meet, like the surface of the water
            ctx.fillStyle = `rgba(255,255,255,${0.35 * swell})`;
            ctx.fillRect(front - 1.5 * dpr, y, 3 * dpr, strip);
          }
          if (swell > 0.05) {
            // the crests catch the light, the troughs just after them a little shade; they roll in toward the front
            for (let k = 0; k < CRESTS; k++) {
              const d = (k + 1 - ((s * 0.9) % 1)) * lambda;
              const cx = front - d;
              if (cx < 0 || cx > W) continue;
              const fade = swell * (1 - k / CRESTS);
              ctx.fillStyle = `rgba(255,255,255,${0.22 * fade})`;
              ctx.fillRect(cx - dpr, y, 2 * dpr, strip);
              ctx.fillStyle = `rgba(0,0,0,${0.12 * fade})`;
              ctx.fillRect(cx + dpr, y, 3 * dpr, strip);
            }
            for (let k = 0; k < 2; k++) { // and two fainter ones ahead of it
              const cx = front + (k + 0.6 + ((s * 0.9) % 1) * 0.5) * lambda * 0.7;
              if (cx < 0 || cx > W) continue;
              ctx.fillStyle = `rgba(255,255,255,${0.14 * swell * (1 - k / 2)})`;
              ctx.fillRect(cx - dpr, y, 2 * dpr, strip);
            }
          }
        }
        if (t < 1) raf = requestAnimationFrame(frame);
        else onDone();
      };
      raf = requestAnimationFrame(frame);
    }).catch(() => onDone()); // a picture that won't load: just show the new one
    return () => { dead = true; cancelAnimationFrame(raf); };
  }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={cv} className="liquid-canvas" aria-hidden="true" />;
}

/**
 * Cover with the liquid change between albums. `coverKey` re-creates the inner Cover as before (a new
 * track, a new cached copy); the change itself is drawn over it until the new one is in place.
 */
const LiquidCover = ({ file, className, coverKey, ...rest }) => {
  const url = file ? coverUrl(file) : null;
  const album = albumOf(file);
  const prev = useRef({ url: null, album: null });
  const [run, setRun] = useState(null); // { from, to, id }
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = { url, album };
    if (!was.url || !url || was.url === url || was.album === album) return;
    if (document.documentElement.classList.contains('reduce-motion') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    setRun({ from: was.url, to: url, id: Date.now() });
  }, [url, album]);
  return (
    <Cover key={coverKey} file={file} className={`${className || ''} ${run ? 'liquid-on' : ''}`} {...rest}>
      {run && <Liquid key={run.id} from={run.from} to={run.to} onDone={() => setRun(null)} />}
    </Cover>
  );
};

export default LiquidCover;
export { albumOf };
