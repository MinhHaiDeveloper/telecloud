import React, { useEffect, useRef, useState } from 'react';
import Cover from './Cover';
import { coverUrl } from '../utils/audio';
import { albumOf } from './LiquidCover';
import { DURATION, ease, motionOff, bitmapFor, beginChange, runningChange, fitScale, backdropCanvas } from '../utils/liquid';

// Behind Now Playing: the cover's colours, very close up and slowly stirred like ink in water. When the
// album changes, rings spread out from the cover, the middle swirls and the new colours follow, in step
// with the cover's own change (they share one clock). Drawn small and blurred, so it costs very little;
// about 30 frames a second is plenty for something this soft. Reduce motion: the still, blurred cover.

const FPS_GAP = 1000 / 30 - 2;
const SETTLE = 4500; // how long the swirl takes to wind down after its peak

const FluidBackdrop = ({ file }) => {
  const url = file ? coverUrl(file) : null;
  const album = albumOf(file);
  const cv = useRef(null);
  const st = useRef({ g: null, url: null, album: null, change: null, a: null, b: null, center: [0.3, 0.5], ready: false });
  const [ready, setReady] = useState(false);
  const still = motionOff();

  // set up once; the loop runs while Now Playing is open
  useEffect(() => {
    if (still) return undefined;
    const s = st.current;
    const el = backdropCanvas(); // made ahead and kept, so opening Now Playing compiles nothing
    if (!el) return undefined;
    el.classList.remove('on');
    cv.current.appendChild(el);
    s.g = el.__g;
    let raf = 0, last = 0, wait = 0;
    // about 30 frames a second: the page sleeps between them instead of waking on every screen refresh
    // (60 to 144 times a second) only to skip it
    const next = () => { raf = requestAnimationFrame(frame); };
    const frame = (now) => {
      raf = 0;
      wait = setTimeout(next, Math.max(0, FPS_GAP - 8 - (performance.now() - now)));
      if (now - last < FPS_GAP - 8 || !s.b) return;
      last = now;
      const g = s.g;
      const w = Math.max(1, Math.round(el.clientWidth)), h = Math.max(1, Math.round(el.clientHeight));
      if (el.width !== w || el.height !== h || s.dirty) {
        s.dirty = false;
        g.size(w, h);
        g.set1('uAspect', w / h);
        g.set2('uSA', ...fitScale(s.a || s.b, w, h)); g.set2('uSB', ...fitScale(s.b, w, h));
        g.set2('uCenter', ...s.center);
      }
      let p = 1, swell = 0;
      if (s.change) {
        // the swirl grows with the cover's change, then winds down over a longer, gentle tail: both ends
        // flat, so it never stops with a jolt
        const el2 = now - s.change.start;
        const t = Math.min(1, el2 / DURATION);
        const sm = (x) => { const k = Math.max(0, Math.min(1, x)); return k * k * (3 - 2 * k); };
        p = ease(t);
        swell = el2 < DURATION / 2 ? sm(el2 / (DURATION / 2)) : 1 - sm((el2 - DURATION / 2) / SETTLE);
        if (el2 >= DURATION / 2 + SETTLE) s.change = null;
      }
      g.set1('uP', p); g.set1('uSwell', swell); g.set1('uTime', now / 1000);
      g.draw();
      if (!s.ready) { s.ready = true; el.classList.add('on'); setReady(true); }
    };
    raf = requestAnimationFrame(frame);
    // closed: the canvas stays ready to draw, without its buffer and pictures (see release in liquid.js)
    return () => { cancelAnimationFrame(raf); clearTimeout(wait); el.classList.remove('on'); el.remove(); el.__g?.release?.(); s.g = null; s.ready = false; s.a = null; s.b = null; s.url = null; s.album = null; };
  }, [still]);

  // the pictures: a new album changes over with the rings, the same album just swaps
  useEffect(() => {
    if (still || !url) return undefined;
    const s = st.current;
    const wasUrl = s.url, wasAlbum = s.album;
    s.url = url; s.album = album;
    let dead = false;
    const change = !wasUrl ? runningChange(url) : (wasUrl !== url && wasAlbum !== album ? beginChange(wasUrl, url) : null);
    // where the cover sits, in the backdrop's own coordinates (it is 120% of the screen, centred)
    const cover = document.querySelector('.np-full .np-cover');
    if (cover) {
      const r = cover.getBoundingClientRect();
      const x = 0.5 + ((r.left + r.width / 2) / window.innerWidth - 0.5) / 1.2;
      const y = 0.5 + ((r.top + r.height / 2) / window.innerHeight - 0.5) / 1.2;
      s.center = [x, y];
    }
    Promise.all([change ? bitmapFor(change.from).catch(() => null) : null, bitmapFor(url)]).then(([a, b]) => {
      if (dead || !s.g) return;
      s.g.texture(1, b, 'uB');
      s.g.texture(0, a || b, 'uA');
      s.a = a || b; s.b = b; s.dirty = true;
      s.change = a ? change : null;
    }).catch(() => {});
    return () => { dead = true; };
  }, [url, album, still]);

  return (
    <>
      <Cover file={file} className={`np-bg ${ready ? 'under-fluid' : ''}`} key={`bg-${file?.path}`} />
      {!still && <span ref={cv} className="np-fluid-host" aria-hidden="true" />}
    </>
  );
};

export default FluidBackdrop;
