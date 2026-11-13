// TeleCloud Remote: another device on the same network (a phone, a tablet, another PC) sees what plays and
// controls it from a web page TeleCloud serves. Off by default.
//
// - A new random port each time it starts.
// - A device pairs with the key in the link or QR code, then keeps a cookie (HttpOnly, SameSite=Strict).
//   Renewing the key signs every device out.
// - State comes from the window (remote:state); commands go back to it (remote:command), so the queue,
//   history, Last.fm and Discord behave as if the click was made on this computer.
// - Never served: audio, file paths, folders, anything about Telegram, settings or keys. Tracks are known
//   to remotes by an opaque id; covers are served by that id.
const { app, ipcMain, BrowserWindow, nativeImage, powerSaveBlocker } = require('electron');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_DEVICES = 10;
const COOKIE = 'tc_remote';
const DIST = path.join(__dirname, '..', 'dist');
const COMMANDS = new Set(['toggle', 'next', 'prev', 'seek', 'volume', 'mute', 'shuffle', 'repeat', 'jump', 'remove', 'move', 'eq', 'output', 'play', 'queue', 'fav']);
const SOURCES = new Set(['album', 'artist', 'playlist', 'favorites', 'recent', 'search']);
const BROWSE = new Set(['home', 'search', 'albums', 'album', 'artists', 'artist', 'playlists', 'playlist', 'favorites', 'recent', 'lyrics']);

const settingsFile = () => path.join(app.getPath('userData'), 'remote-settings.json');
const newKey = () => crypto.randomBytes(16).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
let conf = null;
function load() {
  if (conf) return conf;
  try { conf = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { conf = {}; }
  if (!Array.isArray(conf.devices)) conf.devices = [];
  if (!conf.key) { conf.key = newKey(); persist(); }
  return conf;
}
function persist() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(conf, null, 2)); } catch (err) { console.warn('[Remote] settings not saved:', err.message); }
}

// ---------- what the host is called
const realName = () => os.hostname();
const hostInfo = () => {
  const c = load();
  const custom = String(c.name || '').trim();
  return { name: custom || realName(), realName: realName(), custom: !!custom, beta: require('../package.json').version.includes('-') };
};

// ---------- addresses on the local network: Wi-Fi and Ethernet first, virtual adapters last
const VIRTUAL = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Bluetooth|Teredo|isatap|Tailscale|ZeroTier|Npcap|Docker/i;
const privateIp = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      out.push({ address: i.address, name, virtual: VIRTUAL.test(name), private: privateIp(i.address), mac: i.mac, netmask: i.netmask });
    }
  }
  return out.sort((a, b) => (a.virtual - b.virtual) || (b.private - a.private) || a.name.localeCompare(b.name));
}
function chosenAddress() {
  const list = addresses();
  const pick = load().address;
  return (pick && list.find(a => a.address === pick)) || list[0] || null;
}

// ---------- tracks by id, never by path
const ids = new Map();
const idOf = (p) => {
  if (!p) return null;
  const id = crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);
  if (!ids.has(id)) {
    // a big library browsed for a long time: forget the oldest ids, not all of them
    if (ids.size >= 60000) { let n = 0; for (const k of ids.keys()) { ids.delete(k); if (++n >= 10000) break; } }
    ids.set(id, p);
  }
  return id;
};
// artists by id too: their pictures are asked for by that id
const artistIds = new Map();
const artistIdOf = (name) => {
  const id = crypto.createHash('sha1').update(`artist\u0000${name}`).digest('hex').slice(0, 16);
  if (!artistIds.has(id)) { if (artistIds.size >= 20000) artistIds.clear(); artistIds.set(id, name); }
  return id;
};
const clip = (s, n = 200) => (typeof s === 'string' ? s.slice(0, n) : s ?? null);
const publicTrack = (t) => (t ? {
  id: idOf(t.path), title: clip(t.title), artist: clip(t.artist), album: clip(t.album), duration: Number(t.duration) || 0,
  quality: clip(t.quality, 40), tier: clip(t.tier, 12), mqa: t.mqa ? { label: clip(t.mqa.label, 20), short: clip(t.mqa.short, 30), studio: !!t.mqa.studio } : null,
  ...(typeof t.fav === 'boolean' ? { fav: t.fav } : {}),
  ...(t.where === 'cloud' || t.where === 'cached' ? { where: t.where } : {}),
} : null);

// a library answer from the window, rebuilt key by key: only these go out; paths become ids
const OUT_TEXT = new Set(['key', 'name', 'artist', 'error']);
const OUT_NUM = new Set(['year', 'count', 'total', 'offset', 'albums', 'artists', 'playlists', 'favorites', 'recent', 'tracks']);
function publicAnswer(r) {
  if (!r || typeof r !== 'object') return { error: 'no answer' };
  const item = (x) => {
    if (!x || typeof x !== 'object') return null;
    if ('path' in x) return publicTrack(x);
    const o = {};
    for (const [k, v] of Object.entries(x)) {
      if (OUT_TEXT.has(k) && typeof v === 'string') o[k] = clip(v, k === 'key' ? 600 : 200);
      else if (OUT_NUM.has(k) && Number.isFinite(v)) o[k] = v;
      else if (k === 'coverPath' && typeof v === 'string') o.cover = idOf(v);
      else if (k === 'pictureOf' && typeof v === 'string' && v) o.pic = artistIdOf(v);
    }
    return o;
  };
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) out[k] = v.slice(0, 500).map(item).filter(Boolean);
    else if (v && typeof v === 'object') out[k] = item(v);
    else if (OUT_NUM.has(k) && Number.isFinite(v)) out[k] = v;
    else if (k === 'missing' || k === 'error') out[k] = typeof v === 'string' ? clip(v, 200) : !!v;
    else if (k === 'synced') out[k] = !!v;
  }
  // lyrics: lines of text with their times
  if (Array.isArray(r.lines)) out.lines = r.lines.slice(0, 2000).map(l => ({ time: Number.isFinite(l?.time) ? l.time : null, text: clip(String(l?.text ?? ''), 500) }));
  return out;
}

// questions to the window, answered over IPC
const pending = new Map();
let qseq = 0;
function ask(req) {
  const wc = player && !player.isDestroyed() ? player : null;
  if (!wc) return Promise.resolve(null);
  const qid = ++qseq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(qid); resolve(null); }, 6000);
    pending.set(qid, (r) => { clearTimeout(timer); pending.delete(qid); resolve(r); });
    wc.send('remote:query', { qid, req });
  });
}

let state = null;      // what remotes see, without paths
let stateAt = 0;
function setState(s) {
  if (!s || typeof s !== 'object') return;
  state = {
    track: publicTrack(s.track),
    playing: !!s.playing,
    position: Number(s.position) || 0,
    volume: Math.max(0, Math.min(100, Number(s.volume) || 0)),
    muted: !!s.muted,
    shuffle: !!s.shuffle,
    repeat: ['none', 'all', 'one'].includes(s.repeat) ? s.repeat : 'none',
    queue: (Array.isArray(s.queue) ? s.queue.slice(0, 200) : []).map(publicTrack),
    exclusive: !!s.exclusive,
    outputs: (Array.isArray(s.outputs) ? s.outputs.slice(0, 30) : []).map(o => ({ id: clip(o.id, 120), name: clip(o.name, 120) })),
    output: clip(s.output, 120),
    eq: !!s.eq,
    verdict: clip(s.verdict, 40),
    bitPerfect: !!s.bitPerfect,
    theme: clip(s.theme, 20),
    lyrics: Math.max(0, Number(s.lyrics) || 0),
    art: Math.max(0, Number(s.art) || 0), // covers or artist pictures changed: their addresses change with it
    lib: Math.max(0, Number(s.lib) || 0), // the library, favourites or playlists changed: lists are asked for again
    notice: s.notice && typeof s.notice.text === 'string' ? { text: clip(s.notice.text, 300), at: Number(s.notice.at) || 0 } : null,
    steps: (Array.isArray(s.steps) ? s.steps.slice(0, 14) : []).map(x => ({ label: clip(String(x?.label ?? ''), 80), value: clip(String(x?.value ?? ''), 60), state: ['ok', 'warn', 'off'].includes(x?.state) ? x.state : 'off' })),
  };
  stateAt = Date.now();
  broadcast('state', { ...state, host: hostInfo() });
}

// ---------- devices
// Most browsers also call themselves Chrome and Safari: the specific names are looked for first,
// and one that isn't recognised is just "browser", never a guess
const BROWSERS = [
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/EdgA?\/|EdgiOS\/|Edg\//, 'Edge'],
  [/OPR\/|OPiOS\/|OPT\/|Opera/, 'Opera'],
  [/coc_coc_browser\//, 'Cốc Cốc'],
  [/YaBrowser\//, 'Yandex Browser'],
  [/Vivaldi\//, 'Vivaldi'],
  [/MiuiBrowser\/|XiaoMi\//, 'Mi Browser'],
  [/HuaweiBrowser\//, 'Huawei Browser'],
  [/UCBrowser\//, 'UC Browser'],
  [/DuckDuckGo\//, 'DuckDuckGo'],
  [/FBAN|FBAV|Instagram|Zalo|Line\/|; wv\)/, 'in-app browser'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/CriOS\/|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
function deviceLabel(ua = '') {
  const os_ = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet or foldable')
    : /Windows/.test(ua) ? 'Windows PC' : /Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = BROWSERS.find(([re]) => re.test(ua));
  return `${os_} · ${br ? br[1] : 'browser'}`;
}
const cookieOf = (req) => (String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1);
function deviceOf(req) {
  const token = cookieOf(req);
  if (!token) return null;
  const h = hash(token);
  return load().devices.find(d => d.token === h) || null;
}
let seenSave = 0;
function touch(d) {
  d.lastSeen = Date.now();
  if (Date.now() - seenSave > 30000) { seenSave = Date.now(); persist(); }
}

// ---------- the server
let server = null;
let port = 0;
const clients = new Set(); // { res, device }
const buckets = new Map(); // device id -> { n, at }: a few commands a second at most

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.res.write(msg); } catch { /* closed */ } }
}
const send = (res, code, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(isBuf ? {} : { 'Content-Type': 'application/json' }), ...headers });
  res.end(isBuf ? body : JSON.stringify(body ?? {}));
};
const readJson = (req) => new Promise((resolve) => {
  let size = 0;
  const parts = [];
  req.on('data', (c) => { size += c.length; if (size > 8192) req.destroy(); else parts.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { resolve(null); } });
  req.on('error', () => resolve(null));
});
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const head = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
    if (file.endsWith('.html')) head['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
    send(res, 200, buf, path.extname(file) === '.html' ? head : { ...head, 'Cache-Control': 'public, max-age=86400' });
  });
}

// npm run dev: the page comes from Vite (it has no dist/ yet); a built copy is the fallback
// TELECLOUD_REMOTE_DEV_SERVER: another Vite address, or `off` to serve dist/ even in development
const VITE = process.env.TELECLOUD_REMOTE_DEV_SERVER || 'http://localhost:3000';
// what the page needs under npm run dev: the app's own sources, Vite's client and the packages.
// Never the rest of the project (electron/ holds the API keys, the root holds .env).
const DEV_FILES = /^\/(?:(?:index|remote)\.html|icon\.png|@vite\/client|@react-refresh|(?:src|@id|node_modules)\/[\w@.\/+~-]+)?(?:\?[\w=&.%-]*)?$/;
function fromVite(req, res, p) {
  return new Promise((resolve) => {
    if (VITE === 'off') { resolve(false); return; }
    const r = http.get(VITE + (p === '/' || p === '/index.html' ? '/remote.html' : req.url), { headers: { host: new URL(VITE).host, accept: req.headers.accept || '*/*' }, timeout: 3000 }, (up) => {
      res.writeHead(up.statusCode || 502, { 'Content-Type': up.headers['content-type'] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      up.pipe(res);
      up.on('end', () => resolve(true));
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}

// the same cover the app shows: a local file's art, the cached copy's, or the one stored in TeleCloud
const IMAGE_TYPE = (b) => (b[0] === 0x89 ? 'image/png' : b.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp' : b.toString('latin1', 0, 3) === 'GIF' ? 'image/gif' : 'image/jpeg');
async function coverOf(id) {
  const p = ids.get(id);
  if (!p) return null;
  const buf = await require('./covers').artFor(p).catch(() => null);
  if (!buf || !buf.length) return null;
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) {
    // WebP and GIF can't be resized here; the browser draws them as they are
    const type = IMAGE_TYPE(buf);
    return type !== 'image/jpeg' && buf.length < 4 * 1048576 ? { buf, type } : null;
  }
  const { width } = img.getSize();
  return { buf: (width > 512 ? img.resize({ width: 512, quality: 'good' }) : img).toJPEG(86), type: 'image/jpeg' };
}

// the window that reports the state is the one that plays (not a lyrics or mini window)
let player = null;
function toWindow(cmd, args, device) {
  const wc = player && !player.isDestroyed() ? player : BrowserWindow.getAllWindows().find(w => !w.isDestroyed())?.webContents;
  if (!wc) return false;
  wc.send('remote:command', { cmd, args, device: device.label });
  return true;
}

const sourceOf = (x) => (x && SOURCES.has(x.kind) ? { kind: x.kind, key: typeof x.key === 'string' ? x.key.slice(0, 600) : undefined } : null);
function validArgs(cmd, a = {}) {
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);
  switch (cmd) {
    case 'seek': { const t = num(a.time, 0, 86400); return t == null ? null : { time: t }; }
    case 'volume': { const v = num(a.volume, 0, 100); return v == null ? null : { volume: Math.round(v) }; }
    case 'mute': case 'eq': return { on: !!a.on };
    case 'repeat': return { mode: ['none', 'all', 'one'].includes(a.mode) ? a.mode : null };
    case 'jump': case 'remove': {
      const i = num(a.index, 0, 10000);
      const p = ids.get(String(a.id || ''));
      return i == null || !p ? null : { index: Math.round(i), path: p };
    }
    case 'move': {
      const from = num(a.from, 0, 10000); const to = num(a.to, 0, 10000);
      const p = ids.get(String(a.id || ''));
      return from == null || to == null || !p ? null : { from: Math.round(from), to: Math.round(to), path: p };
    }
    case 'play': case 'queue': {
      const source = sourceOf(a.source);
      if (!source) return null;
      let p;
      if (a.id != null) { p = ids.get(String(a.id)); if (!p) return null; }
      return { source, path: p, shuffle: cmd === 'play' && !!a.shuffle, next: cmd === 'queue' && !!a.next };
    }
    case 'fav': { const p = ids.get(String(a.id || '')); return p ? { path: p, on: !!a.on } : null; }
    case 'output': {
      const id = String(a.id || '');
      return id === '-1' || (state?.outputs || []).some(o => o.id === id) ? { id } : null;
    }
    default: return {};
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // the page and its files are not secret; everything under /api is
  if (req.method === 'GET' && !app.isPackaged && !p.includes('..') && DEV_FILES.test(req.url) && await fromVite(req, res, p)) return undefined;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(DIST, 'remote.html'));
  if (req.method === 'GET' && /^\/assets\/[\w.-]+$/.test(p)) return serveFile(res, path.join(DIST, 'assets', path.basename(p)));
  if (req.method === 'GET' && /^\/(icon|favicon)\.png$/.test(p)) return serveFile(res, path.join(DIST, require('../package.json').version.includes('-') ? 'icon-beta.png' : 'icon.png'));
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  if (req.method === 'POST' && p === '/api/pair') {
    if (req.headers['x-telecloud'] !== '1') return send(res, 400, { error: 'bad request' });
    const body = await readJson(req);
    const c = load();
    const given = String(body?.key || '');
    if (!given || given.length !== c.key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(c.key))) {
      console.warn('[Remote] A device tried to pair with a wrong or old key');
      return send(res, 403, { error: 'This link or QR code is old. Scan the one shown in TeleCloud now.' });
    }
    // already paired in this browser (the link opened again, or a Fold unfolded): the same device, not a new one
    const known = deviceOf(req);
    if (known) {
      touch(known);
      persist();
      pushStatus();
      return send(res, 200, { ok: true, host: hostInfo(), again: true });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const device = { id: crypto.randomBytes(6).toString('hex'), token: hash(token), label: deviceLabel(req.headers['user-agent']), paired: Date.now(), lastSeen: Date.now() };
    c.devices.push(device);
    c.devices.sort((a, b) => b.lastSeen - a.lastSeen);
    c.devices = c.devices.slice(0, MAX_DEVICES);
    persist();
    console.log(`[Remote] Paired: ${device.label}`);
    pushStatus();
    return send(res, 200, { ok: true, host: hostInfo() }, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
  }

  const device = deviceOf(req);
  if (!device) return send(res, 401, { error: 'Not paired' });
  touch(device);

  if (req.method === 'GET' && p === '/api/hello') {
    // the name follows the browser actually used (the same phone may open another browser)
    const ua = String(req.headers['user-agent'] || '');
    const label = deviceLabel(ua);
    if (/^Mozilla\//.test(ua) && label !== device.label) { device.label = label; persist(); pushStatus(); }
    return send(res, 200, { host: hostInfo(), device: device.label, readOnly: !!device.readOnly });
  }
  if (req.method === 'POST' && p === '/api/browse') {
    if (req.headers['x-telecloud'] !== '1') return send(res, 400, { error: 'bad request' });
    const body = await readJson(req);
    if (!body || !BROWSE.has(body.kind)) return send(res, 400, { error: 'Unknown list' });
    const q = { kind: body.kind };
    if (typeof body.key === 'string') q.key = body.key.slice(0, 600);
    if (typeof body.q === 'string') q.q = body.q.slice(0, 120);
    if (['name', 'artist', 'latest', 'oldest'].includes(body.sort)) q.sort = body.sort;
    if (Number.isFinite(body.offset)) q.offset = Math.max(0, Math.min(1e6, Math.round(body.offset)));
    if (Number.isFinite(body.limit)) q.limit = Math.max(1, Math.min(60, Math.round(body.limit)));
    const r = await ask(q);
    return r ? send(res, 200, publicAnswer(r)) : send(res, 503, { error: 'TeleCloud did not answer' });
  }
  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 2000\n\n`);
    const client = { res, device };
    clients.add(client);
    pushStatus();
    res.write(`event: me
data: ${JSON.stringify({ readOnly: !!device.readOnly, label: device.label })}

`);
    if (state) res.write(`event: state\ndata: ${JSON.stringify({ ...state, host: hostInfo() })}\n\n`);
    else res.write(`event: state\ndata: ${JSON.stringify({ host: hostInfo(), track: null, queue: [] })}\n\n`);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(client); pushStatus(); });
    return undefined;
  }
  if (req.method === 'GET' && p.startsWith('/api/artist/')) {
    // the picture the app shows for an artist (chosen, or from their tags); ?motion=1 for the GIF
    const name = artistIds.get(p.slice('/api/artist/'.length));
    const images = require('./artistImages');
    const buf = name ? await (url.searchParams.get('motion') ? images.motionFor(name) : images.pictureFor(name)).catch(() => null) : null;
    return buf && buf.length ? send(res, 200, buf, { 'Content-Type': IMAGE_TYPE(buf), 'Cache-Control': 'private, max-age=3600' }) : send(res, 404, { error: 'no picture' });
  }
  if (req.method === 'GET' && p.startsWith('/api/cover/')) {
    const art = await coverOf(p.slice('/api/cover/'.length)).catch(() => null);
    return art ? send(res, 200, art.buf, { 'Content-Type': art.type, 'Cache-Control': 'private, max-age=3600' }) : send(res, 404, { error: 'no cover' });
  }
  if (req.method === 'POST' && p === '/api/cmd') {
    if (req.headers['x-telecloud'] !== '1') return send(res, 400, { error: 'bad request' }); // a page on another site can't send this header
    if (device.readOnly) return send(res, 403, { error: 'This device can only watch' });
    const b = buckets.get(device.id) || { n: 0, at: Date.now() };
    if (Date.now() - b.at > 1000) { b.n = 0; b.at = Date.now(); }
    if (++b.n > 15) { buckets.set(device.id, b); return send(res, 429, { error: 'Too many commands' }); }
    buckets.set(device.id, b);
    const body = await readJson(req);
    const cmd = String(body?.cmd || '');
    if (!COMMANDS.has(cmd)) return send(res, 400, { error: 'Unknown command' });
    const args = validArgs(cmd, body.args);
    if (!args) return send(res, 400, { error: 'Bad value' });
    return toWindow(cmd, args, device) ? send(res, 200, { ok: true }) : send(res, 503, { error: 'TeleCloud has no window open' });
  }
  return send(res, 404, { error: 'not found' });
}

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { handle(req, res).catch((err) => { console.warn('[Remote] request failed:', err.message); try { send(res, 500, { error: 'error' }); } catch { /* gone */ } }); });
    s.on('error', (err) => { console.error('[Remote] could not start:', err.message); server = null; resolve(0); });
    // the network; tests keep it on this computer only
    s.listen(0, process.env.TELECLOUD_REMOTE_HOST || '0.0.0.0', () => {
      server = s;
      port = s.address().port;
      const a = chosenAddress();
      console.log(`[Remote] On, port ${port}${a ? ` (${a.name})` : ''}`);
      pushStatus();
      resolve(port);
    });
  });
}
function stop() {
  for (const c of clients) { try { c.res.end(); } catch { /* gone */ } }
  clients.clear();
  if (server) { server.close(); server = null; console.log('[Remote] Off'); }
  port = 0;
  pushStatus();
}

// ---------- for Settings
function status() {
  const c = load();
  const a = chosenAddress();
  const online = new Set([...clients].map(x => x.device.id));
  return {
    enabled: !!c.enabled, running: !!server, port,
    addresses: addresses().map(x => ({ address: x.address, name: x.name, virtual: x.virtual })),
    address: a?.address || null,
    url: server && a ? `http://${a.address}:${port}/#k=${c.key}` : null,
    host: hostInfo(), name: c.name || '', keepAwake: !!c.keepAwake, awake: blocker != null, wake: wakeInfo(),
    devices: c.devices.map(d => ({ id: d.id, label: d.label, lastSeen: d.lastSeen, paired: d.paired, online: online.has(d.id), readOnly: !!d.readOnly })),
  };
}
function pushStatus() {
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('remote:status', status()); });
}
function networkProfile() {
  return new Promise((resolve) => {
    // Name is the network's own name (the Wi-Fi's SSID); InterfaceAlias is the adapter ("Wi-Fi 2")
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (err, out) => {
      if (err) { resolve([]); return; }
      try {
        const j = JSON.parse(out);
        resolve((Array.isArray(j) ? j : [j]).map(x => ({
          name: x.Name || x.InterfaceAlias, adapter: x.InterfaceAlias,
          category: x.NetworkCategory === 1 || x.NetworkCategory === 'Private' ? 'Private' : x.NetworkCategory === 2 || x.NetworkCategory === 'DomainAuthenticated' ? 'Domain' : 'Public',
        })));
      } catch { resolve([]); }
    });
  });
}

ipcMain.handle('remote:status', () => status());
ipcMain.handle('remote:set', async (e, patch = {}) => {
  const c = load();
  if (typeof patch.name === 'string') c.name = patch.name.trim().slice(0, 60);
  if (typeof patch.address === 'string') c.address = patch.address;
  if (typeof patch.keepAwake === 'boolean') { c.keepAwake = patch.keepAwake; persist(); applyAwake(); }
  if (typeof patch.enabled === 'boolean') {
    c.enabled = patch.enabled;
    persist();
    if (patch.enabled) await start(); else stop();
  } else persist();
  if (typeof patch.name === 'string' && state) broadcast('state', { ...state, host: hostInfo() });
  pushStatus();
  return status();
});
ipcMain.handle('remote:renew', () => {
  const c = load();
  c.key = newKey();
  c.devices = [];
  persist();
  for (const x of clients) { try { x.res.end(); } catch { /* gone */ } }
  clients.clear();
  console.log('[Remote] New key: every device was signed out');
  pushStatus();
  return status();
});
ipcMain.handle('remote:remove-device', (e, id) => {
  const c = load();
  c.devices = c.devices.filter(d => d.id !== id);
  persist();
  for (const x of [...clients]) if (x.device.id === id) { try { x.res.end(); } catch { /* gone */ } clients.delete(x); }
  pushStatus();
  return status();
});
ipcMain.handle('remote:network', () => networkProfile());
// ---------- keep the computer awake while music plays (Settings > Remote; a sleeping PC can't be reached)
let blocker = null;
let playingNow = false;
function applyAwake() {
  const want = !!load().keepAwake && playingNow;
  if (want && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blocker != null) { if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); blocker = null; }
}
ipcMain.handle('power:playing', (e, on) => { playingNow = !!on; applyAwake(); return blocker != null; });

// ---------- Wake-on-LAN: what a phone app needs to wake this computer
function wakeInfo() {
  const a = chosenAddress();
  if (!a || !a.mac || /^0{2}(:0{2}){5}$/.test(a.mac)) return null;
  const ip = a.address.split('.').map(Number);
  const mask = String(a.netmask || '255.255.255.0').split('.').map(Number);
  return { mac: a.mac.toUpperCase().replace(/:/g, '-'), broadcast: ip.map((x, i) => (x | (~mask[i] & 255))).join('.'), adapter: a.name, wireless: /Wi-?Fi|Wireless|WLAN|802\.11/i.test(a.name) };
}

ipcMain.handle('remote:answer', (e, a) => { pending.get(a?.qid)?.(a?.result); });
// a device that may only watch: it sees everything, its commands are refused
ipcMain.handle('remote:device-access', (e, id, readOnly) => {
  const d = load().devices.find(x => x.id === id);
  if (d) {
    d.readOnly = !!readOnly;
    persist();
    for (const c of clients) if (c.device.id === id) { try { c.res.write(`event: me
data: ${JSON.stringify({ readOnly: d.readOnly, label: d.label })}

`); } catch { /* gone */ } }
  }
  pushStatus();
  return status();
});
ipcMain.handle('remote:state', (e, s) => { player = e.sender; if (server) setState(s); });

app.whenReady().then(() => { if (load().enabled) start(); });
app.on('before-quit', () => { stop(); playingNow = false; applyAwake(); });

module.exports = { start, stop, status, networkProfile, deviceLabel, _state: () => state, _ids: ids };
