// Talking to TeleCloud from the remote page. Every call names itself with a header a page on
// another site can't send, and the cookie set when pairing says which device it is.
export const HEADERS = { 'Content-Type': 'application/json', 'X-TeleCloud': '1' };

/** A command; resolves to the HTTP status (0 when TeleCloud can't be reached). */
export const send = (cmd, args = {}) => fetch('/api/cmd', { method: 'POST', headers: HEADERS, body: JSON.stringify({ cmd, args }) })
  .then(r => r.status).catch(() => 0);

// answers are kept a little while, so going back is instant
const cache = new Map();
const KEEP = 20000;
/** A list from the library: { kind, key?, q?, sort?, offset?, limit? } */
export async function browse(req, { fresh = false } = {}) {
  const k = JSON.stringify(req);
  const hit = cache.get(k);
  if (!fresh && hit && Date.now() - hit.at < KEEP) return hit.data;
  const r = await fetch('/api/browse', { method: 'POST', headers: HEADERS, body: JSON.stringify(req) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `TeleCloud answered ${r.status}`);
  const data = await r.json();
  cache.set(k, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}
export const forgetAll = () => cache.clear();
/** Favourites and recently played change while you look: drop what was kept. */
export const forget = (kinds) => { for (const k of [...cache.keys()]) if (kinds.some(x => k.includes(`"kind":"${x}"`))) cache.delete(k); };

export const clock = (t) => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
