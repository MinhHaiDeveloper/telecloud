// Updates from GitHub Releases (MinhHaiDeveloper/telecloud). Checked a few seconds after start and
// on demand; downloaded in the background; installed on the next quit or when the user restarts.
// Beta installs (version like 1.0.0-beta.2) also get pre-releases; stable installs only releases.
const { app, ipcMain, BrowserWindow } = require('electron');

let state = { state: 'idle', version: app.getVersion() };
const send = (patch) => {
  state = { ...state, ...patch };
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('update:status', state));
};

/** One sentence for the About card. The raw error holds the whole response from GitHub, cookies included. */
function shortError(err) {
  const text = String(err?.message || err || '');
  const status = err?.statusCode || Number(/^\s*(?:HttpError:\s*)?(\d{3})\b/.exec(text)?.[1]) || 0;
  if (status === 404) return 'GitHub has no release to look at.';
  if (status) return `GitHub is not answering right now (${status}). Try again later.`;
  if (/net::ERR_|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(text)) return 'TeleCloud could not reach GitHub. Check your connection.';
  const first = text.split('\n')[0].trim();
  return first.length > 120 ? `${first.slice(0, 120)}…` : first || 'Unknown error';
}
function fail(err) {
  const error = shortError(err);
  if (state.state !== 'error' || state.error !== error) console.warn(`[Updater] ${error}`);
  send({ state: 'error', error });
}

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
  updater.on('error', fail);
  return updater;
}

async function check() {
  const u = getUpdater();
  if (!u) { send({ state: 'dev' }); return state; }
  try { await u.checkForUpdates(); } catch (err) { fail(err); }
  return state;
}

app.whenReady().then(() => setTimeout(() => { check(); }, 8000));
setInterval(() => { if (state.state !== 'downloading' && state.state !== 'ready') check(); }, 6 * 3600000).unref?.();

ipcMain.handle('update:status', () => state);
ipcMain.handle('update:check', () => check());
ipcMain.handle('update:install', () => { if (state.state === 'ready' && updater) setImmediate(() => updater.quitAndInstall(false, true)); return true; });

module.exports = { check, shortError };
