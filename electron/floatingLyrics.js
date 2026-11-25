// The floating lyrics window: a small always-on-top strip with the line being sung and the next one,
// above every other window. Locked, clicks go through it to whatever is behind. Where it sits and how big
// it is are remembered. The main window sends what plays; this only carries it across.

const { app, ipcMain, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let locked = false;
let last = null; // the latest state, for a window that opens mid-song
let quitting = false; // closed because TeleCloud quits: it stays "open", to come back with the app
app.on('before-quit', () => { quitting = true; });
const file = () => path.join(app.getPath('userData'), 'floating-lyrics.json');
const readSaved = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const save = (patch) => { try { fs.writeFileSync(file(), JSON.stringify({ ...readSaved(), ...patch })); } catch { /* fine */ } };

function status() { return { open: !!win && !win.isDestroyed(), locked }; }
function tellAll() {
  const st = status();
  const main = require('./mainWindow').get();
  if (main && !main.isDestroyed()) main.webContents.send('lyrics-float:changed', st);
  if (win && !win.isDestroyed()) win.webContents.send('lyrics-float:changed', st);
  try { require('./tray').update?.({ floating: st }); } catch { /* no tray */ }
}

/** Where it opens: as it was left, if that is still on a screen; else low in the middle of the main one */
function bounds() {
  const saved = readSaved().bounds;
  const area = screen.getPrimaryDisplay().workArea;
  const fits = saved && screen.getAllDisplays().some(d => saved.x >= d.workArea.x - 40 && saved.y >= d.workArea.y - 40 && saved.x + 80 <= d.workArea.x + d.workArea.width && saved.y + 40 <= d.workArea.y + d.workArea.height);
  if (fits) return saved;
  const width = Math.min(860, Math.round(area.width * 0.6)), height = 150;
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height - height - 60), width, height };
}

function open() {
  if (win && !win.isDestroyed()) { win.showInactive(); return; }
  locked = !!readSaved().locked;
  win = new BrowserWindow({
    ...bounds(), minWidth: 320, minHeight: 90,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: true, maximizable: false, minimizable: false, fullscreenable: false,
    show: false, title: 'TeleCloud lyrics',
    focusable: false, // never takes the keyboard from what you are doing; clicks and dragging still work
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.tcFloating = true; // never taken for the main window
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  let saveTimer = null;
  const remember = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (win && !win.isDestroyed()) save({ bounds: win.getBounds() }); }, 300); };
  win.on('move', remember);
  win.on('resize', remember);
  win.on('closed', () => { win = null; if (!quitting) save({ open: false }); tellAll(); console.log('[Lyrics] Floating lyrics closed'); });
  win.once('ready-to-show', () => {
    win.showInactive(); // never takes the focus from what you are doing
    if (locked) win.setIgnoreMouseEvents(true, { forward: true });
    if (last) win.webContents.send('lyrics-float:update', last);
    tellAll();
  });
  if (!app.isPackaged) win.loadURL(`${process.env.TELECLOUD_DEV_SERVER || 'http://localhost:3000'}/#floating-lyrics`);
  else win.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'floating-lyrics' });
  save({ open: true });
  console.log(`[Lyrics] Floating lyrics open${locked ? ', locked' : ''}`);
}

function close() { if (win && !win.isDestroyed()) win.close(); }

function setLocked(on) {
  locked = !!on;
  save({ locked });
  console.log(`[Lyrics] Floating lyrics ${locked ? 'locked (clicks go through)' : 'unlocked'}`);
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(locked, { forward: true });
  tellAll();
}

ipcMain.handle('lyrics-float:toggle', (event, on) => {
  const want = on === undefined ? !status().open : !!on;
  if (want) open(); else close();
  return status();
});
ipcMain.handle('lyrics-float:lock', (event, on) => { setLocked(on === undefined ? !locked : on); return status(); });
ipcMain.handle('lyrics-float:status', () => status());
// from the main window: the lyrics (when they change) and where the music is
ipcMain.handle('lyrics-float:state', (event, st) => {
  if (!st || typeof st !== 'object') return false;
  last = { ...(last || {}), ...st };
  if (win && !win.isDestroyed()) win.webContents.send('lyrics-float:update', st);
  return true;
});

/** Opened last time: open again with TeleCloud */
function restore() { if (readSaved().open) open(); }

module.exports = { open, close, setLocked, status, restore, _win: () => win };
