const { app, BrowserWindow, ipcMain, protocol, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const dotenv = require('dotenv');
const logger = require('./logger');

// First of all, so nothing from startup is missed
logger.init(path.join(app.getPath('userData'), 'logs'));
logger.write('INFO', 'app', `TeleCloud ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${require('os').release()}, ${app.isPackaged ? 'installed' : 'development'})`);
app.on('child-process-gone', (e, d) => { if (d.reason !== 'clean-exit') logger.write('ERROR', 'crash', `${d.type} process gone: ${d.reason} (exit ${d.exitCode})`); });
app.on('render-process-gone', (e, wc, d) => { logger.write('ERROR', 'crash', `Window process gone: ${d.reason} (exit ${d.exitCode})`); logger.flush(); });
app.on('web-contents-created', (e, wc) => {
  wc.on('console-message', (d) => {
    if (String(d.sourceId || '').startsWith('devtools://')) return; // the developer tools talking to themselves
    const name = d.level;
    const where = d.sourceId ? ` (${String(d.sourceId).replace(/^.*[\\/]/, '')}:${d.lineNumber})` : '';
    if (name === 'error') logger.write('ERROR', 'window', `${d.message}${where}`);
    else if (name === 'warning') logger.write('WARN', 'window', `${d.message}${where}`);
    else logger.write('DEBUG', 'window', d.message);
  });
  wc.on('preload-error', (ev, p, err) => logger.write('ERROR', 'window', `Preload failed: ${err?.message}`));
});
app.on('before-quit', () => { logger.write('INFO', 'app', 'Quitting'); logger.flush(); });

// Load .env from different locations in dev vs production
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')  // Production: resources/.env
  : path.join(__dirname, '..', '.env');        // Dev: project-root/.env
dotenv.config({ path: envPath, quiet: true });

// Cover cache directory
const COVER_CACHE_DIR = path.join(app.getPath('userData'), 'cover-cache');

const MusicFolderWatcher = require('./watcher.js');
const { setupTeleCloudSyncHandlers, cleanupTeleCloudSync } = require('./telecloud/service');
const database = require('./database');
const { getLibraryRoots, getTempDir, isInLibrary, isInAppStorage, safeFileName, readSettings } = require('./paths');
const { backgroundRefresh } = require('./music.js');
const { applyAudioSettings } = require('./player.js');
require('./spectrum.js');
require('./autoeq.js');
require('./stats.js');
require('./lyrics.js');
require('./coverSearch.js');
require('./discord.js');
const artistImages = require('./artistImages.js');
require('./logExport.js');
require('./tagEdit.js');
require('./lastfm.js');
require('./updater.js');

// File system watcher instance
let folderWatcher = null;
let currentlyWatchedKey = null; // Folder list the watcher was started with
const covers = require('./covers');

const isDev = !app.isPackaged;

// One copy at a time: a second one would fight over the database and the audio output, and with
// the window in the tray, opening TeleCloud again has to bring that window back.
if (!app.requestSingleInstanceLock()) app.exit(0);

// Settings → General → Performance: run on the high-performance GPU (laptops with two GPUs often
// give Electron apps the integrated one, which can't keep up with 144–240 Hz screens). Applies at start.
// Low memory mode draws the interface without the graphics card: much less memory, slower animations.
try {
  if (readSettings().lowMemoryMode) app.disableHardwareAcceleration();
  else if (readSettings().highPerformanceGpu) app.commandLine.appendSwitch('force_high_performance_gpu');
} catch { /* defaults */ }
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

// Temporary download target for cloud tracks; the renderer only chooses the file name
ipcMain.handle('get-temp-path', async (event, filename) => {
  return path.join(getTempDir(), safeFileName(filename, `telecloud_${Date.now()}.flac`));
});

// Settings > Playback > DSD: the ASIO drivers, and what one can do (opening it takes it for a moment)
ipcMain.handle('asio:list', async () => { try { return { success: true, names: await require('./asio').list(), available: require('./asio').available() }; } catch (err) { return { success: false, error: err.message, names: [] }; } });
ipcMain.handle('asio:probe', async (event, driver) => { try { return { success: true, ...(await require('./asio').probe(String(driver), { fresh: true })) }; } catch (err) { return { success: false, error: err.message }; } });

ipcMain.handle('apply-audio-settings', async (event, settings) => {
  try {
    await applyAudioSettings(settings);
    return { success: true };
  } catch (err) {
    console.error('Error applying audio settings:', err);
    return { success: false, error: err.message };
  }
});

// File System Watcher: always watches the folders saved in Settings
ipcMain.handle('start-watching', async () => {
  try {
    const folders = getLibraryRoots();
    const key = JSON.stringify(folders);
    if (folderWatcher && key === currentlyWatchedKey) return { success: true, skipped: true };
    if (folderWatcher) { folderWatcher.stop(); folderWatcher = null; }
    currentlyWatchedKey = key;
    if (!folders.length) return { success: false, error: 'No folders provided' };
    folderWatcher = new MusicFolderWatcher(folders, () => backgroundRefresh());
    folderWatcher.start();
    return { success: true };
  } catch (err) {
    console.error('[Main] Error starting file watcher:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-watching', async () => {
  if (folderWatcher) { folderWatcher.stop(); folderWatcher = null; }
  currentlyWatchedKey = null;
  return { success: true };
});

// Clear database and cache - start fresh
ipcMain.handle('clear-database-and-cache', async () => {
  try {
    database.clearDatabase();
    database.closeDatabase();
    const dbPath = path.join(app.getPath('userData'), 'music-library.db');
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(COVER_CACHE_DIR, { recursive: true, force: true });
    fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
    covers.clearMissing();
    return { success: true };
  } catch (err) {
    console.error('[Database] Error clearing database:', err);
    return { success: false, error: err.message };
  }
});

// No File / Edit / View menu: the app draws its own title bar with window buttons
Menu.setApplicationMenu(null);

// Custom title bar buttons (the window is frameless)
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle('window:minimize', (e) => { winOf(e)?.minimize(); });
ipcMain.handle('window:toggle-maximize', (e) => { const w = winOf(e); if (!w) return false; if (w.isMaximized()) w.unmaximize(); else w.maximize(); return w.isMaximized(); });
ipcMain.handle('window:close', (e) => { winOf(e)?.close(); });
ipcMain.handle('window:state', (e) => { const w = winOf(e); return { maximized: !!w?.isMaximized(), fullscreen: !!w?.isFullScreen(), focused: !!w?.isFocused() }; });

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#121214', // no white flash before the page paints
    icon: path.join(__dirname, isDev ? '../public/icon.png' : '../dist/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, // Recommended for security
      contextIsolation: true, // Recommended for security
      sandbox: true,
      spellcheck: false,
    },
  });

  require('./tray').attach(win);
  const sendState = () => { if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() }); };
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'restore'].forEach(ev => win.on(ev, sendState));

  // The app never opens its own windows or navigates away; external links go through 'open-external'
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  if (isDev) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  // Create cover cache directory if it doesn't exist
  if (!fs.existsSync(COVER_CACHE_DIR)) {
    fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
  }

  setupTeleCloudSyncHandlers();

  // Saved playback settings apply from the start, not only once the Settings page is opened
  try {
    const s = readSettings();
    applyAudioSettings({
      replayGain: s.replayGainEnabled ? s.replayGainMode : 'no',
      crossfade: s.crossfadeEnabled ? s.crossfadeDuration : 0,
      maxBitDepth: s.maxSamplingEnabled ? s.maxBitDepth : null,
      maxSampleRate: s.maxSamplingEnabled ? s.maxSampleRate : null,
      dsdMode: s.dsdMode,
      dopMax: s.dopMax,
      asioDriver: s.asioDriver,
    });
  } catch (err) {
    console.error('Could not apply saved audio settings:', err.message);
  }

  const typeOf = (buf) => (buf[0] === 0x89 ? 'image/png' : buf[0] === 0x52 ? 'image/webp' : buf[0] === 0x47 ? 'image/gif' : 'image/jpeg');
  const imageResponse = (buf) => new Response(buf, { headers: { 'Content-Type': typeOf(buf) } });

  /** The picture shown for a track, or null */
  const artFor = async (songPath) => {
    const row = database.getFileByPath(songPath);
    const stored = row?.cloud_cover ? await covers.readIfExists(covers.cloudCoverFile(row.cloud_cover)) : null;
    const original = isInLibrary(songPath) && fs.existsSync(songPath);
    // cloud-only: the album cover in TeleCloud comes first, even with a cached copy of the audio
    // (that copy's embedded art may be older than a cover chosen since)
    if (!original && stored) return stored;
    const candidates = [];
    if (row?.cache_path && isInAppStorage(row.cache_path)) candidates.push(row.cache_path);
    if (original) candidates.push(songPath);
    const source = candidates.find(p => fs.existsSync(p));
    return (source ? await covers.coverForFile(source) : null) || stored;
  };
  ipcMain.handle('covers:has', async (e, { path: p }) => {
    const art = await artFor(p).catch(() => null);
    if (!art) return false;
    // art that can't be drawn (a damaged tag) counts as no cover; WebP and GIF only the page can draw
    const riff = art.toString('latin1', 0, 4) === 'RIFF' || art.toString('latin1', 0, 3) === 'GIF';
    return riff || !nativeImage.createFromBuffer(art).isEmpty();
  });

  // A tiny copy of the cover for "Follow the cover". WebP and GIF can't be read here: no colour for those.
  ipcMain.handle('cover:thumb', async (event, p) => {
    const art = await artFor(p).catch(() => null);
    if (!art) return null;
    const img = nativeImage.createFromBuffer(art);
    return img.isEmpty() ? null : img.resize({ width: 32, height: 32, quality: 'good' }).toDataURL();
  });

  // media://<encoded track path>[?r=revision] serves cover art for library tracks only
  protocol.handle('media', async (request) => {
    try {
      const target = decodeURIComponent(request.url.slice('media://'.length).split('?')[0]);
      const art = target.startsWith('artist-motion:') ? await artistImages.motionFor(target.slice('artist-motion:'.length))
        : target.startsWith('artist:') ? await artistImages.pictureFor(target.slice('artist:'.length)) : await artFor(target);
      return art ? imageResponse(art) : new Response(null, { status: 404 });
    } catch (err) {
      console.error('[media://] Cover extraction error:', err.message);
      return new Response(null, { status: 404 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', async () => {
  // Cleanup TeleCloud Sync resources
  await cleanupTeleCloudSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
