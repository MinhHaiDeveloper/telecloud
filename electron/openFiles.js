// Opening music from Windows: "Open with TeleCloud", or a double-click when TeleCloud is the default
// player. The files come on the command line, the first time or to the TeleCloud already running; the
// window plays them and opens Now Playing. Files outside the music folders play too, only those ones.

const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { AUDIO_EXTENSIONS, allowOpened, isOpened, isInLibrary } = require('./paths');

let pending = [];

/** The music files in a command line (the exe, flags and Electron's own "." left out) */
function audioArgs(argv) {
  return (argv || []).slice(1).filter((a) => typeof a === 'string' && !a.startsWith('-') && path.isAbsolute(a)
    && AUDIO_EXTENSIONS.has(path.extname(a).toLowerCase()) && fs.existsSync(a));
}

function deliver(files) {
  const ok = files.filter(allowOpened);
  if (!ok.length) return;
  console.log(`[Open] ${ok.length} file${ok.length === 1 ? '' : 's'} from Windows`);
  pending.push(...ok);
  const win = require('./mainWindow').get();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('open:files');
  }
}

/** A track as the window knows tracks: from the library when it is there, else read from the file */
async function describe(p) {
  const row = require('./database').getFileByPath(p);
  if (row) return require('./music').toFrontend(row);
  const stat = await fs.promises.stat(p);
  const t = await require('./tags').parseTrack(p, stat);
  return {
    name: t.name, path: p, ext: t.ext, size: stat.size, mtime: t.mtime,
    metadata: {
      title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist || '', inferred: [],
      year: t.year, genre: t.genre, track: t.trackNumber || 0, disc: t.discNumber || 0, duration: t.duration,
      bitrate: t.bitrate, sampleRate: t.sampleRate, bitsPerSample: t.bitDepth, codec: t.codec, lossless: t.lossless,
      lyrics: t.lyrics || '',
    },
    hasCover: true, storage_type: 'local', added_at: null, mqa: t.mqa ?? null, mqaRate: t.mqaRate || null,
    opened: !isInLibrary(p), // not in the library: played, not listed
  };
}

// the window asks for what came in (at start, and each time it is told)
ipcMain.handle('open:take', async () => {
  const files = [...new Set(pending)];
  pending = [];
  const out = [];
  for (const f of files) {
    if (!isOpened(f)) continue;
    try { out.push(await describe(f)); } catch (err) { console.warn('[Open] could not read a file:', err.message); }
  }
  return out;
});

app.on('second-instance', (event, argv) => deliver(audioArgs(argv)));

/** The files TeleCloud was started with */
function init() { deliver(audioArgs(process.argv)); }

module.exports = { init, audioArgs, _pending: () => pending };
