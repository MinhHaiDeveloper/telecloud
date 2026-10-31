const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const dotenv = require('dotenv');

// Load .env from different locations in dev vs production
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')  // Production: resources/.env
  : path.join(__dirname, '..', '.env');        // Dev: project-root/.env
dotenv.config({ path: envPath });

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

// File system watcher instance
let folderWatcher = null;
let currentlyWatchedKey = null; // Folder list the watcher was started with
const covers = require('./covers');

const isDev = !app.isPackaged;

// Temporary download target for cloud tracks; the renderer only chooses the file name
ipcMain.handle('get-temp-path', async (event, filename) => {
  return path.join(getTempDir(), safeFileName(filename, `telecloud_${Date.now()}.flac`));
});

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, isDev ? '../public/icon.png' : '../dist/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, // Recommended for security
      contextIsolation: true, // Recommended for security
      sandbox: true,
    },
  });

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
    });
  } catch (err) {
    console.error('Could not apply saved audio settings:', err.message);
  }

  const typeOf = (buf) => (buf[0] === 0x89 ? 'image/png' : buf[0] === 0x52 ? 'image/webp' : 'image/jpeg');
  const imageResponse = (buf) => new Response(buf, { headers: { 'Content-Type': typeOf(buf) } });

  // media://<encoded track path> serves cover art for library tracks only
  protocol.handle('media', async (request) => {
    try {
      const songPath = decodeURIComponent(request.url.slice('media://'.length));
      const row = database.getFileByPath(songPath);
      const candidates = [];
      if (row?.cache_path && isInAppStorage(row.cache_path)) candidates.push(row.cache_path);
      if (isInLibrary(songPath)) candidates.push(songPath);
      const source = candidates.find(p => fs.existsSync(p));
      const art = source ? await covers.coverForFile(source) : null;
      if (art) return imageResponse(art);
      // cloud-only track (or a file without art): the album cover stored in TeleCloud
      const cloudArt = row?.cloud_cover ? await covers.readIfExists(covers.cloudCoverFile(row.cloud_cover)) : null;
      return cloudArt ? imageResponse(cloudArt) : new Response(null, { status: 404 });
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
