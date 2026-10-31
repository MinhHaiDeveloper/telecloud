import { useCallback, useEffect, useRef, useState } from 'react';
import { flatBands } from '../utils/autoEqMath';

// EQ state for the whole app: bands, preamp, on/off, AutoEQ choices and an undo history.
// Persisted to the "eq" store and pushed to the player (af-command makes small, fast updates cheap).

const HISTORY_LIMIT = 60;
export const AUTOEQ_DEFAULTS = { filters: 10, maxGain: 6, maxQ: 4, minFreq: 20, maxFreq: 16000 };

const sameState = (a, b) => a && b && a.preamp === b.preamp && JSON.stringify(a.bands) === JSON.stringify(b.bands);

export default function useEq() {
  const [enabled, setEnabled] = useState(false);
  const [bands, setBands] = useState(flatBands);
  const [preamp, setPreamp] = useState(0);
  const [auto, setAuto] = useState({ measurement: null, target: null, params: AUTOEQ_DEFAULTS });
  const [history, setHistory] = useState({ stack: [], index: -1 });
  const [loaded, setLoaded] = useState(false);
  const latest = useRef({ bands, preamp });
  latest.current = { bands, preamp };

  useEffect(() => {
    window.ipcRenderer.invoke('load-store', 'eq').then((d) => {
      const ok = d && !Array.isArray(d) && Array.isArray(d.bands) && d.bands.length;
      const b = ok ? d.bands : flatBands();
      const p = ok && Number.isFinite(d.preamp) ? d.preamp : 0;
      if (ok) {
        setBands(b);
        setPreamp(p);
        setEnabled(!!d.enabled);
        if (d.auto) setAuto(a => ({ ...a, ...d.auto, params: { ...AUTOEQ_DEFAULTS, ...(d.auto.params || {}) } }));
      }
      setHistory({ stack: [{ bands: b, preamp: p, label: 'Saved EQ', ts: Date.now() }], index: 0 });
    }).catch(() => {}).finally(() => setLoaded(true));
  }, []);

  // Save shortly after the last change
  useEffect(() => {
    if (!loaded) return undefined;
    const t = setTimeout(() => window.ipcRenderer.invoke('save-store', 'eq', { enabled, preamp, bands, auto }), 600);
    return () => clearTimeout(t);
  }, [loaded, enabled, preamp, bands, auto]);

  // Player: at most every 40 ms while dragging, always the final state
  const sendTimer = useRef(null);
  const lastSent = useRef(0);
  useEffect(() => {
    if (!loaded) return undefined;
    const send = () => {
      lastSent.current = Date.now();
      sendTimer.current = null;
      window.ipcRenderer.invoke('set-eq', { enabled, preamp, bands });
    };
    clearTimeout(sendTimer.current);
    const wait = Math.max(0, 40 - (Date.now() - lastSent.current));
    sendTimer.current = setTimeout(send, wait);
    return () => clearTimeout(sendTimer.current);
  }, [loaded, enabled, preamp, bands]);

  /** Record the current bands/preamp as a history step (no-op when nothing changed) */
  const commit = useCallback((label, state) => {
    const snap = { ...(state || latest.current), label, ts: Date.now() };
    setHistory((h) => {
      if (sameState(h.stack[h.index], snap)) return h;
      const stack = [...h.stack.slice(0, h.index + 1), snap].slice(-HISTORY_LIMIT);
      return { stack, index: stack.length - 1 };
    });
  }, []);

  /** Replace bands and preamp in one go and record it */
  const apply = useCallback((next, label) => {
    setBands(next.bands);
    setPreamp(next.preamp);
    commit(label, { bands: next.bands, preamp: next.preamp });
  }, [commit]);

  const jump = useCallback((index) => {
    setHistory((h) => {
      const snap = h.stack[index];
      if (!snap) return h;
      setBands(snap.bands);
      setPreamp(snap.preamp);
      return { ...h, index };
    });
  }, []);
  const undo = useCallback(() => setHistory((h) => {
    const snap = h.stack[h.index - 1];
    if (!snap) return h;
    setBands(snap.bands);
    setPreamp(snap.preamp);
    return { ...h, index: h.index - 1 };
  }), []);
  const redo = useCallback(() => setHistory((h) => {
    const snap = h.stack[h.index + 1];
    if (!snap) return h;
    setBands(snap.bands);
    setPreamp(snap.preamp);
    return { ...h, index: h.index + 1 };
  }), []);

  return { enabled, setEnabled, bands, setBands, preamp, setPreamp, auto, setAuto, history, commit, apply, jump, undo, redo };
}
