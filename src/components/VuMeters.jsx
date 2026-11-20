import React, { memo, useEffect, useRef, useState } from 'react';
import { Segmented } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

// Two analogue-style VU meters for Now Playing (the VU panel). The levels come from a silent second mpv
// (electron/liveSpectrum.js, `levels`), 30 times a second, only while this panel is on screen and the
// window is visible. The needles move with VU ballistics (about 300 ms to reach a step, a little
// overshoot) and only their CSS transform changes, so the browser composites them without repainting.

const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this session only */ } };

// Scale geometry, in the face's own units (viewBox 400 x 230); the needle turns on a pivot below the face
const W = 400, H = 230, PX = 200, PY = 262, R = 196, SWEEP = 48;
// deflection is proportional to voltage, as on a real meter: +3 VU is full scale, 0 VU sits at 71 %
const defl = (vu) => 10 ** ((vu - 3) / 20);
const angle = (d) => -SWEEP + 2 * SWEEP * d;
const pt = (a, r) => { const t = (a * Math.PI) / 180; return [PX + r * Math.sin(t), PY - r * Math.cos(t)]; };
const MAJOR = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
const MINOR = [-15, -6, -4, -0.5, 0.5, 1.5, 2.5];
const PCT = [0, 20, 40, 60, 80, 100];

const REFS = [
  { value: '-18', label: '−18' },
  { value: '-14', label: '−14' },
  { value: '-10', label: '−10' },
];
// Classic and Blue are backlit faces; Theme takes the colours of the theme chosen in Settings > Appearance
// (and follows it); Backdrop has no face at all: the scale and needles over Now Playing's own background
const STYLES = [
  { value: 'classic', get label() { return t('Classic'); } },
  { value: 'blue', get label() { return t('Blue'); } },
  { value: 'theme', get label() { return t('Theme'); } },
  { value: 'backdrop', get label() { return t('Backdrop'); } },
];

function arc(r, a0, a1) {
  const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** The printed face: drawn once per style, never animated */
const Face = memo(({ side }) => {
  const zero = angle(defl(0));
  return (
    <svg className="vu-face" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path className="vu-arc" d={arc(R, -SWEEP, zero)} />
      <path className="vu-arc red" d={arc(R, zero, SWEEP)} />
      <path className="vu-arc red thick" d={arc(R + 4, zero, SWEEP)} />
      {MAJOR.map((v) => {
        const a = angle(defl(v));
        const [x0, y0] = pt(a, R), [x1, y1] = pt(a, R + 13), [tx, ty] = pt(a, R + 30);
        return (
          <g key={v} className={v > 0 ? 'red' : ''}>
            <line className="vu-tick" x1={x0} y1={y0} x2={x1} y2={y1} />
            <text className="vu-num" x={tx} y={ty + 5}>{v > 0 ? `+${v}` : v === 0 ? '0' : String(-v)}</text>
          </g>
        );
      })}
      {MINOR.map((v) => {
        const a = angle(defl(v));
        const [x0, y0] = pt(a, R), [x1, y1] = pt(a, R + 7);
        return <line key={v} className={`vu-tick minor ${v > 0 ? 'red' : ''}`} x1={x0} y1={y0} x2={x1} y2={y1} />;
      })}
      {/* the percentage scale under the arc, as on the meters it copies */}
      <path className="vu-arc thin" d={arc(R - 16, -SWEEP, SWEEP)} />
      {PCT.map((p) => {
        const a = angle(p / 100);
        const [x0, y0] = pt(a, R - 16), [x1, y1] = pt(a, R - 22), [tx, ty] = pt(a, R - 34);
        return <g key={p}><line className="vu-tick minor" x1={x0} y1={y0} x2={x1} y2={y1} /><text className="vu-pct" x={tx} y={ty + 3}>{p}</text></g>;
      })}
      <text className="vu-minus" x={pt(-SWEEP - 8, R + 22)[0]} y={pt(-SWEEP - 8, R + 22)[1] + 6}>−</text>
      <text className="vu-minus red" x={pt(SWEEP + 8, R + 22)[0]} y={pt(SWEEP + 8, R + 22)[1] + 6}>+</text>
      <text className="vu-title" x={PX} y={170}>VU</text>
      <text className="vu-side" x={30} y={214}>{side}</text>
      <text className="vu-peaklabel" x={340} y={214}>PEAK</text>
    </svg>
  );
});

// VU ballistics: a damped spring, ~300 ms to 99 % with ~1.5 % overshoot
const OMEGA = 19, ZETA = 0.8;
const HOLD_MS = 450; // the peak light stays on this long

const VuMeters = ({ active = true, label }) => {
  const [style, setStyleState] = useState(() => { const v = read('vu-style', 'classic'); return STYLES.some(o => o.value === v) ? v : 'classic'; });
  const [ref, setRefState] = useState(() => read('vu-ref', '-14'));
  const [why, setWhy] = useState(null);
  const setStyle = (v) => { setStyleState(v); write('vu-style', v); };
  const setRef = (v) => { setRefState(v); write('vu-ref', v); };
  const refDb = useRef(Number(ref));
  refDb.current = Number(ref);

  const needles = [useRef(null), useRef(null)];
  const leds = [useRef(null), useRef(null)];
  const sim = useRef({ d: [0, 0], v: [0, 0], t: [0, 0], at: 0, led: [0, 0], ledOn: [false, false], shown: [NaN, NaN], raf: 0, last: 0 });

  useEffect(() => {
    if (!active) return undefined;
    const ipc = window.ipcRenderer;
    const s = sim.current;
    const frame = (now) => {
      const dt = Math.min(0.05, (now - (s.last || now)) / 1000);
      s.last = now;
      // no level for a moment (paused, stopped, between tracks): the needles fall back to rest
      const fresh = now - s.at < 160;
      let moving = false;
      for (let c = 0; c < 2; c++) {
        const target = fresh ? s.t[c] : 0;
        // two half steps keep the spring steady at low frame rates
        for (let k = 0; k < 2; k++) {
          const h = dt / 2;
          s.v[c] += (OMEGA * OMEGA * (target - s.d[c]) - 2 * ZETA * OMEGA * s.v[c]) * h;
          s.d[c] += s.v[c] * h;
        }
        if (s.d[c] < -0.015) { s.d[c] = -0.015; s.v[c] = 0; } // the left stop
        if (s.d[c] > 1.07) { s.d[c] = 1.07; s.v[c] = 0; } // pinned at the right stop
        const a = angle(s.d[c]);
        if (!(Math.abs(a - s.shown[c]) < 0.03) && needles[c].current) {
          needles[c].current.style.transform = `rotate(${a.toFixed(2)}deg)`;
          s.shown[c] = a;
        }
        const on = now < s.led[c];
        if (on !== s.ledOn[c] && leds[c].current) { leds[c].current.classList.toggle('on', on); s.ledOn[c] = on; }
        if (Math.abs(s.v[c]) > 1e-3 || Math.abs(target - s.d[c]) > 1e-3 || on) moving = true;
      }
      // nothing to move: stop asking for frames until the next level arrives
      s.raf = moving || fresh ? requestAnimationFrame(frame) : 0;
    };
    const wake = () => { if (!s.raf) { s.last = 0; s.raf = requestAnimationFrame(frame); } };
    const onFrame = (e, lv) => {
      const now = performance.now();
      s.at = now;
      for (let c = 0; c < 2; c++) {
        s.t[c] = Math.min(1.1, defl(lv[c * 2] - refDb.current));
        if (lv[c * 2 + 1] >= -0.3) s.led[c] = now + HOLD_MS; // close to full scale: the peak light
      }
      setWhy(null);
      wake();
    };
    const onState = (e, st) => setWhy(st?.running ? null : st?.why || null);
    // only while the window can be seen: a minimised TeleCloud reads nothing
    const vis = () => ipc.invoke('levels:live', document.visibilityState === 'visible').catch(() => {});
    ipcOn(ipc, 'levels:frame', onFrame);
    ipcOn(ipc, 'levels:state', onState);
    document.addEventListener('visibilitychange', vis);
    vis();
    wake();
    return () => {
      ipcOff(ipc, 'levels:frame', onFrame);
      ipcOff(ipc, 'levels:state', onState);
      document.removeEventListener('visibilitychange', vis);
      ipc.invoke('levels:live', false).catch(() => {});
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`vu vu-${style}`}>
      <div className="vu-meters">
        {['Left', t('Right')].map((side, c) => (
          <div key={side} className="vu-meter">
            <div className="vu-glass">
              <Face side={side === 'Left' ? 'L' : 'R'} />
              <i className="vu-needle" ref={needles[c]} style={{ transform: `rotate(${-SWEEP}deg)` }} />
              <span className="vu-cap" />
              <span className="vu-led" ref={leds[c]} />
            </div>
          </div>
        ))}
      </div>
      {why && <div className="vu-note">{why === 'native' ? t('The VU meters do not run with native DSD: they show again with PCM.') : t('The VU meters need the track on this computer: they show once a TeleCloud track is cached.')}</div>}
      <div className="vu-foot">
        {label && <span className="mono vu-format">{label}</span>}
        <span className="vu-sp" />
        <span className="vu-reflabel" title={t('Which level, in dBFS (RMS), puts the needle on 0 VU. Loud modern masters read better at −10.')}>0 VU =</span>
        <Segmented value={ref} onChange={setRef} options={REFS} size="sm" />
        <span className="vu-reflabel">dBFS</span>
        <Segmented value={style} onChange={setStyle} options={STYLES} size="sm" />
      </div>
    </div>
  );
};

export default VuMeters;
