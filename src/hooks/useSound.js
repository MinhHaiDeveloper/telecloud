import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logGrid, totalResponse } from '../utils/autoEqMath';

// Settings > Sound: tone, space, effects, correction, headroom and A/B. Saved in the "sound" store,
// sent to the player (electron/soundChain.js checks it and builds the filters).

export const SOUND_DEFAULTS = {
  warmth: 0, bass: 0, treble: 0, loudness: false,
  width: 100, channels: 'normal', polarity: 'normal',
  night: 'off', air: 0, tube: 0,
  correction: null, // { name, kind, rate, taps, points: [[f, dB]] }
  autoHeadroom: true,
};

const GRID = logGrid(240);

/** The tone controls as the shelves they are, for working out the curve */
export const toneBands = (s) => [
  s.bass ? { type: 'LSF', freq: 100, q: 0.7, gain: s.bass } : null,
  s.treble ? { type: 'HSF', freq: 8000, q: 0.7, gain: s.treble } : null,
  // tilt: the warm side lifts the lows, the bright side the highs
  s.warmth > 0 ? { type: 'LSF', freq: 1000, q: 0.5, gain: s.warmth } : null,
  s.warmth < 0 ? { type: 'HSF', freq: 1000, q: 0.5, gain: -s.warmth } : null,
].filter(Boolean);

const interpolate = (points, f) => {
  if (!points?.length) return 0;
  if (f <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (f >= last[0]) return last[1];
  const i = points.findIndex(([x]) => x >= f);
  const [x0, y0] = points[i - 1], [x1, y1] = points[i];
  return y0 + ((Math.log(f) - Math.log(x0)) / (Math.log(x1) - Math.log(x0))) * (y1 - y0);
};

/**
 * The whole curve the EQ, tone and correction make (dB at each grid frequency), the headroom
 * that keeps its biggest boost from clipping, and how much louder it is overall (for A/B).
 */
export function soundCurve(eq, s) {
  const total = new Float64Array(GRID.length);
  if (eq?.enabled) {
    const r = totalResponse(eq.bands || [], GRID);
    for (let i = 0; i < total.length; i++) total[i] += r[i] + (Number(eq.preamp) || 0);
  }
  const tone = totalResponse(toneBands(s), GRID);
  for (let i = 0; i < total.length; i++) total[i] += tone[i] + interpolate(s.correction?.points, GRID[i]);
  const peak = Math.max(...total);
  const guard = s.autoHeadroom && peak > 0.05 ? -Math.ceil(peak * 10) / 10 : 0;
  // overall loudness change: the mean over 100 Hz to 8 kHz on a log scale, where the ear cares most
  let sum = 0, n = 0;
  GRID.forEach((f, i) => { if (f >= 100 && f <= 8000) { sum += total[i] + guard; n++; } });
  return { total, peak, guard, loudness: n ? sum / n : 0 };
}

const clean = (raw) => {
  const s = { ...SOUND_DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  for (const k of Object.keys(SOUND_DEFAULTS)) if (raw[k] !== undefined && typeof raw[k] === typeof SOUND_DEFAULTS[k]) s[k] = raw[k];
  if (raw.correction && Array.isArray(raw.correction.points)) s.correction = raw.correction;
  return s;
};

export default function useSound(eq) {
  const [sound, setSoundState] = useState(SOUND_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [ab, setAb] = useState(false); // hearing the original, for this session only
  useEffect(() => {
    window.ipcRenderer.invoke('load-store', 'sound').then(d => setSoundState(clean(d))).catch(() => {}).finally(() => setLoaded(true));
  }, []);
  const set = useCallback((patch) => setSoundState(s => ({ ...s, ...patch })), []);
  const reset = useCallback(() => setSoundState(s => ({ ...SOUND_DEFAULTS, correction: null, autoHeadroom: s.autoHeadroom })), []);

  // save shortly after the last change
  useEffect(() => {
    if (!loaded) return undefined;
    const t = setTimeout(() => window.ipcRenderer.invoke('save-store', 'sound', sound), 600);
    return () => clearTimeout(t);
  }, [loaded, sound]);

  const curve = useMemo(() => soundCurve(eq, sound), [eq?.enabled, eq?.bands, eq?.preamp, sound]); // eslint-disable-line react-hooks/exhaustive-deps

  // the player: at most every 40 ms while dragging, always the final state
  const timer = useRef(null);
  const lastSent = useRef(0);
  useEffect(() => {
    if (!loaded) return undefined;
    const payload = {
      ...sound,
      ir: sound.correction ? { points: sound.correction.points } : null,
      guard: curve.guard,
      // the original, as loud as the processed sound: louder always sounds better, so they must match
      bypass: ab ? { gain: Number(curve.loudness.toFixed(2)) } : null,
    };
    const send = () => { lastSent.current = Date.now(); timer.current = null; window.ipcRenderer.invoke('set-sound', payload); };
    clearTimeout(timer.current);
    timer.current = setTimeout(send, Math.max(0, 40 - (Date.now() - lastSent.current)));
    return () => clearTimeout(timer.current);
  }, [loaded, sound, curve.guard, curve.loudness, ab]);

  const active = useMemo(() => {
    const s = sound;
    return !!(s.warmth || s.bass || s.treble || s.loudness || s.width !== 100 || s.channels !== 'normal' || s.polarity !== 'normal'
      || s.night !== 'off' || s.air || s.tube || s.correction || curve.guard);
  }, [sound, curve.guard]);

  return { sound, set, reset, loaded, ab, setAb, curve, active };
}

/** What is on, in a few words (the signal path's Sound step) */
export function soundSummary(s, { guard = 0, ab = false, exclusive = false } = {}) {
  if (ab) return ['Original, level matched'];
  const out = [];
  if (s.warmth) out.push(s.warmth > 0 ? `Warm +${s.warmth} dB` : `Bright +${-s.warmth} dB`);
  if (s.bass) out.push(`Bass ${s.bass > 0 ? '+' : ''}${s.bass} dB`);
  if (s.treble) out.push(`Treble ${s.treble > 0 ? '+' : ''}${s.treble} dB`);
  if (s.loudness && !exclusive) out.push('Loudness');
  if (s.correction) out.push('Correction');
  if (s.width !== 100) out.push(`Width ${s.width}%`);
  if (s.channels === 'mono') out.push('Mono');
  if (s.channels === 'swap') out.push('L/R swapped');
  if (s.polarity !== 'normal') out.push(s.polarity === 'both' ? 'Polarity inverted' : `${s.polarity === 'left' ? 'Left' : 'Right'} polarity inverted`);
  if (s.night !== 'off') out.push(`Night ${s.night}`);
  if (s.air) out.push(`Air ${s.air}%`);
  if (s.tube) out.push(`Tube ${s.tube}%`);
  if (guard) out.push(`Headroom ${guard} dB`);
  return out;
}
