// Where files may be read, played, written or deleted from.
// Every IPC handler that receives a path from the renderer must go through these checks,
// so a compromised page can't touch anything outside the user's library and our own cache.

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.wav', '.aiff', '.aif', '.alac', '.m4a', '.ape', '.wv', '.tta',
  '.dsf', '.dff', '.mp3', '.ogg', '.opus', '.aac', '.wma', '.aifc', '.m4b', '.mka', '.mpc',
]);

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

const isWin = process.platform === 'win32';
const norm = (p) => {
  const resolved = path.resolve(p);
  return isWin ? resolved.toLowerCase() : resolved;
};

// Resolve symlinks/junctions where possible so "inside" can't be faked with a link
function real(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function isInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Music folders the user registered in Settings (the main process reads them itself). */
function getLibraryRoots() {
  const list = readSettings().musicFolderList;
  return Array.isArray(list) ? list.filter(f => typeof f === 'string' && path.isAbsolute(f)) : [];
}

function getDownloadFolder() {
  const f = readSettings().downloadFolder;
  return typeof f === 'string' && path.isAbsolute(f) ? f : null;
}

/** App-owned folders for downloaded cloud tracks and temporary files. */
function getCacheDir() {
  const dir = path.join(app.getPath('userData'), 'audio-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getTempDir() {
  const dir = path.join(os.tmpdir(), 'telecloud');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isAbsoluteFilePath(p) {
  // Reject URLs / mpv protocols ("lavfi://", "http://", "\\?\" device paths, etc.)
  return typeof p === 'string' && p.length < 4096 && path.isAbsolute(p) && !/^[a-z][a-z0-9+.-]+:\/\//i.test(p) && !p.startsWith('\\\\?\\') && !p.startsWith('\\\\.\\');
}

function isInLibrary(p) {
  if (!isAbsoluteFilePath(p)) return false;
  const r = real(p);
  return getLibraryRoots().some(root => isInside(r, real(root)));
}

function isInAppStorage(p) {
  if (!isAbsoluteFilePath(p)) return false;
  const r = real(p);
  return isInside(r, real(getCacheDir())) || isInside(r, real(getTempDir()));
}

/** A path the player / analyser may open: an audio file in the library or in our cache. */
function isPlayablePath(p) {
  if (!isAbsoluteFilePath(p)) return false;
  if (!AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase())) return false;
  return isInLibrary(p) || isInAppStorage(p);
}

function assertPlayable(p) {
  if (!isPlayablePath(p)) throw new Error('Path is outside the music library');
  return p;
}

/** Strip anything that could escape a folder from a file name. */
function safeFileName(name, fallback = 'track') {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 200) : fallback;
}

module.exports = {
  AUDIO_EXTENSIONS,
  readSettings,
  getLibraryRoots,
  getDownloadFolder,
  getCacheDir,
  getTempDir,
  isInside,
  isInLibrary,
  isInAppStorage,
  isPlayablePath,
  assertPlayable,
  safeFileName,
};
