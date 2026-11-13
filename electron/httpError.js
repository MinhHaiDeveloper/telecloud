// What a failed answer from an online source means, short enough for "Not reached: Last.fm (…)".
// The log gets the host only: a full address can hold an API key.
module.exports = function httpError(r, url) {
  let host = '';
  try { host = new URL(url).host; } catch { /* not a URL */ }
  console.warn(`[Net] ${host || 'a source'}: HTTP ${r.status} ${r.statusText || ''} (${r.headers?.get?.('content-type') || 'no type'})`);
  // 600 and up is no HTTP status: something between this PC and the site answered instead
  if (r.status >= 600 || r.status < 100) return new Error(`the network answered ${r.status}: a VPN, proxy or security app?`);
  if (r.status === 429) return new Error('too many requests, try again later');
  if (r.status >= 500) return new Error(`server trouble, HTTP ${r.status}`);
  return new Error(`HTTP ${r.status}`);
};
