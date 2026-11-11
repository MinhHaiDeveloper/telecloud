import { useCallback, useState } from 'react';

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

/**
 * useState for a page's sort or filter that is kept when the page closes and after a restart.
 * `allowed` drops a value the page no longer offers. Without a key it is a plain useState.
 */
export default function useRemembered(key, fallback, allowed) {
  const [value, setValue] = useState(() => {
    if (!key) return fallback;
    const saved = read(`view:${key}`);
    return saved !== null && (!allowed || allowed.includes(saved)) ? saved : fallback;
  });
  const set = useCallback((next) => {
    setValue(next);
    if (key) { try { localStorage.setItem(`view:${key}`, next); } catch { /* private storage: this session only */ } }
  }, [key]);
  return [value, set];
}
