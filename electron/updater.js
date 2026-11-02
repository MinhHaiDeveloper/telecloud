// Updates from GitHub Releases (MinhHaiDeveloper/telecloud). Checked a few seconds after start and
// on demand; downloaded in the background; installed on the next quit or when the user restarts.
// Beta installs (version like 1.0.0-beta.2) also get pre-releases; stable installs only releases.
const { app, ipcMain, BrowserWindow } = require('electron');

let state = { state: 'idle', version: app.getVersion() };
const send = (patch) => {
  state = { ...state, ...patch };
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('update:status', state));
};

let updater = null;
function getUpdater() {
  if (updater || !app.isPackaged) return updater; // development builds don't update themselves
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = app.getVersion().includes('-');
  updater.on('checking-for-update', () => send({ state: 'checking', error: null }));
  updater.on('update-available', (i) => send({ state: 'downloading', next: i.version, percent: 0 }));
  updater.on('update-not-available', () => send({ state: 'latest', checkedAt: Date.now() }));
  updater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => send({ state: 'ready', next: i.version }));
  updater.on('error', (err) => send({ state: 'error', error: String(err?.message || err).split('\n')[0] }));
  return updater;
}

async function check() {
  const u = getUpdater();
  if (!u) { send({ state: 'dev' }); return state; }
  try { await u.checkForUpdates(); } catch (err) { send({ state: 'error', error: err.message }); }
  return state;
}

app.whenReady().then(() => setTimeout(() => { check(); }, 8000));
setInterval(() => { if (state.state !== 'downloading' && state.state !== 'ready') check(); }, 6 * 3600000).unref?.();

ipcMain.handle('update:status', () => state);
ipcMain.handle('update:check', () => check());
ipcMain.handle('update:install', () => { if (state.state === 'ready' && updater) setImmediate(() => updater.quitAndInstall(false, true)); return true; });

module.exports = { check };
