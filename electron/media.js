// TeleCloud outside its window: the Windows media controls (the flyout by the volume keys and the lock
// screen, through tc-media.exe), the keyboard's media keys, the taskbar thumbnail buttons and the tray.
// Every button ends in the renderer's own handlers ('media:command'), as a click there would.

const { app, ipcMain, globalShortcut, nativeImage, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const exePath = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'tc-media.exe')
  : path.join(__dirname, '..', 'native', 'media', 'bin', 'tc-media.exe'));
// the app id of TeleCloud's Start menu shortcut (set by the installer from build.appId): Windows finds the
// shortcut by it and shows its name and icon. Tests use their own id, to find their own session.
const appId = () => process.env.TELECLOUD_MEDIA_AUMID || require('../package.json').build?.appId || 'com.telecloud.app';
const appName = () => (require('../package.json').version.includes('-') ? 'TeleCloud Beta' : 'TeleCloud');

let win = null;
let state = null;       // what the renderer says is playing
let sleep = null;       // the sleep timer, as the renderer shows it
let helper = null;
let helperOk = false;
let keysHeld = false;
let lastMeta = '';


const command = (cmd, extra = {}) => {
  const w = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) w.webContents.send('media:command', { cmd, ...extra });
};

// ---------- the helper
const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, 300);
function tell(line) {
  if (!helper || !helper.stdin.writable) return;
  try { helper.stdin.write(`${line}\n`); } catch { /* gone */ }
}
function startHelper() {
  if (helper || process.env.TELECLOUD_MEDIA === 'off') return;
  if (!fs.existsSync(exePath())) { console.warn('[Media] tc-media.exe is missing: media keys only'); holdKeys(); return; }
  const h = spawn(exePath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  helper = h;
  let buf = '';
  h.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      onHelper(line);
    }
  });
  h.on('error', () => { if (helper === h) { helper = null; holdKeys(); } });
  h.on('exit', (code) => {
    if (helper !== h) return;
    helper = null;
    helperOk = false;
    if (code) console.warn(`[Media] Windows media controls stopped (${code}): media keys only`);
    holdKeys();
  });
  tell(`aumid\t${clean(appId())}\t${clean(appName())}\t${clean(process.execPath)}`);
}
function onHelper(line) {
  const [kind, a] = line.split('\t');
  if (kind === 'ready') {
    helperOk = true;
    releaseKeys(); // Windows sends the media keys to the session now; holding them would take them from other apps
    console.log('[Media] In the Windows media controls');
    lastMeta = '';
    if (state) push(state);
  } else if (kind === 'button') {
    const map = { play: 'play', pause: 'pause', stop: 'stop', next: 'next', previous: 'prev' };
    if (map[a]) command(map[a]);
  } else if (kind === 'seek') {
    const t = Number(a);
    if (Number.isFinite(t)) command('seek', { time: t });
  } else if (kind === 'error') {
    console.warn(`[Media] ${line.slice(6)}`);
    if (!helperOk) holdKeys();
  }
}

/** A small JPEG of the cover for Windows to read. Two names in turn, so a new cover is never a cached old one */
async function coverFile(trackPath) {
  try {
    const buf = await require('./covers').artFor(trackPath);
    if (!buf?.length) return '';
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return '';
    const { width } = img.getSize();
    const dir = path.join(app.getPath('userData'), 'media-controls');
    await fs.promises.mkdir(dir, { recursive: true });
    // named after the picture itself: Windows keeps what it read from a path, so a reused name could show
    // an earlier track's picture. The last few are kept, older ones removed.
    const jpeg = (width > 400 ? img.resize({ width: 400, quality: 'good' }) : img).toJPEG(88);
    const file = path.join(dir, `cover-${require('crypto').createHash('sha1').update(jpeg).digest('hex').slice(0, 16)}.jpg`);
    if (!fs.existsSync(file)) await fs.promises.writeFile(file, jpeg);
    const now = Date.now();
    await fs.promises.utimes(file, now / 1000, now / 1000).catch(() => {});
    const old = (await fs.promises.readdir(dir)).filter(f => /^cover-.*\.jpg$/.test(f)).map(f => path.join(dir, f))
      .map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(6);
    for (const o of old) await fs.promises.rm(o.f, { force: true }).catch(() => {});
    return file;
  } catch { return ''; }
}

async function push(st) {
  if (!helperOk) return;
  if (!st) { tell('clear'); lastMeta = ''; return; }
  const meta = [st.path, st.title, st.artist, st.album, st.art || 0].join('|');
  if (meta !== lastMeta) {
    lastMeta = meta;
    // the names at once, the cover as soon as it's ready (a big embedded picture takes a moment)
    const text = `${clean(st.title)}\t${clean(st.artist)}\t${clean(st.album)}`;
    tell(`meta\t${text}\t`);
    coverFile(st.path).then((cover) => {
      if (cover && meta === lastMeta) tell(`meta\t${text}\t${clean(cover)}`); // still this track
    });
  }
  tell(`state\t${st.playing ? 'playing' : 'paused'}`);
  tell(`time\t${Number(st.position || 0).toFixed(2)}\t${Number(st.duration || 0).toFixed(2)}`);
  tell(`buttons\t${st.hasNext ? 1 : 0}\t${st.hasPrev ? 1 : 0}`);
}

// ---------- media keys, only when the Windows media controls can't take them
const KEYS = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
function holdKeys() {
  if (keysHeld || !app.isReady()) return;
  for (const [key, cmd] of Object.entries(KEYS)) {
    try { globalShortcut.register(key, () => command(cmd)); } catch { /* another app has it */ }
  }
  keysHeld = true;
  console.log('[Media] Media keys held by TeleCloud');
}
function releaseKeys() {
  if (!keysHeld) return;
  for (const key of Object.keys(KEYS)) { try { globalShortcut.unregister(key); } catch { /* not ours */ } }
  keysHeld = false;
}

// ---------- taskbar thumbnail buttons, drawn here: white shapes on transparent
function glyph(kind, size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 16;
  const inTri = (x, y, ax, ay, bx, by, cx, cy) => {
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / d;
    const v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / d;
    return u >= 0 && v >= 0 && 1 - u - v >= 0;
  };
  const shapes = {
    play: [['t', 4, 2.5, 4, 13.5, 13, 8]],
    pause: [['r', 3.5, 2.5, 3.5, 11], ['r', 9, 2.5, 3.5, 11]],
    next: [['t', 2.5, 3, 2.5, 13, 10, 8], ['r', 10.5, 3, 2.5, 10]],
    prev: [['t', 13.5, 3, 13.5, 13, 6, 8], ['r', 3, 3, 2.5, 10]],
  }[kind];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4 samples a pixel for smooth edges
      let hit = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const fx = (x + ox) / s, fy = (y + oy) / s;
        if (shapes.some(sh => (sh[0] === 'r' ? fx >= sh[1] && fx <= sh[1] + sh[3] && fy >= sh[2] && fy <= sh[2] + sh[4] : inTri(fx, fy, sh[1], sh[2], sh[3], sh[4], sh[5], sh[6])))) hit++;
      }
      const i = (y * size + x) * 4;
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = Math.round((hit / 4) * 255);
    }
  }
  return px;
}
const icons = {};
function icon(kind) {
  if (!icons[kind]) {
    const img = nativeImage.createFromBitmap(glyph(kind, 16), { width: 16, height: 16, scaleFactor: 1 });
    img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: glyph(kind, 32) });
    icons[kind] = img;
  }
  return icons[kind];
}
let lastButtons = '';
function thumbar() {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  const playing = !!state?.playing;
  const has = !!state;
  const key = `${has}|${playing}|${!!state?.hasNext}`;
  if (key === lastButtons) return;
  lastButtons = key;
  try {
    win.setThumbarButtons(has ? [
      { tooltip: 'Previous', icon: icon('prev'), click: () => command('prev') },
      { tooltip: playing ? 'Pause' : 'Play', icon: icon(playing ? 'pause' : 'play'), click: () => command('toggle') },
      { tooltip: 'Next', icon: icon('next'), click: () => command('next'), flags: state?.hasNext ? [] : ['disabled'] },
    ] : []);
  } catch { /* the window isn't on the taskbar yet */ }
}

ipcMain.handle('media:state', (event, st) => {
  state = st && typeof st === 'object' ? st : null;
  push(state).catch(() => {});
  thumbar();
  require('./tray').update?.({ playing: !!state?.playing, hasTrack: !!state, sleep });
  return true;
});
ipcMain.handle('sleep:set', (event, s) => {
  sleep = s && typeof s === 'object' ? { label: String(s.label || ''), kind: String(s.kind || '') } : null;
  require('./tray').update?.({ playing: !!state?.playing, hasTrack: !!state, sleep });
  return true;
});

function attach(w) {
  win = w;
  startHelper();
  w.once('ready-to-show', () => { lastButtons = ''; thumbar(); });
  w.on('show', () => { lastButtons = ''; thumbar(); });
}

app.on('will-quit', () => {
  releaseKeys();
  tell('quit');
  if (helper) { const h = helper; helper = null; setTimeout(() => { try { h.kill(); } catch { /* gone */ } }, 500); }
});

module.exports = { attach, command, _media: () => ({ helperOk, keysHeld, state, sleep, appId: appId(), buttons: lastButtons }) };
