// How the full-screen view looks: saved on this computer, applied through CSS variables so the
// lyrics follow every change right away. The defaults keep the plain look: extras are opt-in.
import { useSyncExternalStore } from 'react';

const KEY = 'tc-appearance';
export const APPEARANCE_DEFAULTS = {
  followCover: false, // the accent takes the colour of the cover playing
  coverTilt: false,
  tiltStrength: 10, // degrees at the edge of the cover
  lyricCurrent: 26, // px
  lyricOther: 26, // px
  lyricAlign: 'left',
  lyricGlow: false,
  lyricSpeed: 400, // ms from one line to the next
};
export const APPEARANCE_LIMITS = {
  tiltStrength: [3, 25],
  lyricCurrent: [16, 64],
  lyricOther: [12, 48],
  lyricSpeed: [100, 1500],
};

const clean = (raw) => {
  const out = { ...APPEARANCE_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['followCover', 'coverTilt', 'lyricGlow']) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  if (['left', 'center', 'right'].includes(raw.lyricAlign)) out.lyricAlign = raw.lyricAlign;
  for (const [k, [lo, hi]] of Object.entries(APPEARANCE_LIMITS)) {
    const n = Number(raw[k]);
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, n));
  }
  return out;
};

const read = () => { try { return clean(JSON.parse(localStorage.getItem(KEY))); } catch { return clean(null); } };

let current = read();
const listeners = new Set();

function apply(a) {
  const s = document.documentElement.style;
  s.setProperty('--np-lyric-current', `${a.lyricCurrent}px`);
  s.setProperty('--np-lyric-other', `${a.lyricOther}px`);
  s.setProperty('--np-lyric-align', a.lyricAlign);
  s.setProperty('--np-lyric-speed', `${a.lyricSpeed}ms`);
  document.documentElement.classList.toggle('np-lyric-glow', a.lyricGlow);
}
apply(current);

export function setAppearance(patch) {
  current = clean({ ...current, ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* still applies until restart */ }
  apply(current);
  listeners.forEach(fn => fn());
}
export const resetAppearance = () => setAppearance(APPEARANCE_DEFAULTS);

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const useAppearance = () => useSyncExternalStore(subscribe, () => current);
