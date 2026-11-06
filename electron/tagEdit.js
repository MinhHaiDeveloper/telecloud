// Editing track tags (title, artists, album, …) from the app, for one track or many at once.
// Files on this computer are rewritten with node-taglib-sharp; cloud-only tracks only change in the
// library and the TeleCloud index. Backed-up files are re-uploaded by the watcher (their bytes changed).
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const database = require('./database');
const { describeWriteError, withWritable } = require('./fileWrite');

const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'track', 'disc'];
const list = (s) => String(s || '').split(/\s*[;,]\s*/).map(x => x.trim()).filter(Boolean);
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const isLocal = (p) => p && !p.startsWith('tc://') && fs.existsSync(p);

/** Everything editable, read from the file itself when there is one (album artist isn't in the DB) */
function read(p) {
  const row = database.getFileByPath(p);
  const out = {
    // a title that is only the file name, and the "Unknown" labels, are not tags: leave those empty
    title: row?.title && row.title !== path.basename(p).replace(/\.[^.]+$/, '') ? row.title : '',
    artist: row?.artist && row.artist !== 'Unknown Artist' ? row.artist : '',
    album: row?.album && row.album !== 'Unknown Album' ? row.album : '',
    albumArtist: (row?.album_artist || '').split(/\s*;\s*/).filter(Boolean).join(', '),
    year: row?.year || '', genre: row?.genre || '', track: row?.track_number || '', disc: row?.disc_number || '',
  };
  if (isLocal(p)) {
    const { File } = require('node-taglib-sharp');
    const f = File.createFromPath(p);
    try {
      const t = f.tag;
      Object.assign(out, {
        title: t.title || out.title, artist: (t.performers || []).join(', ') || out.artist, album: t.album || out.album,
        albumArtist: (t.albumArtists || []).join(', ') || out.albumArtist, year: t.year || out.year, genre: (t.genres || []).join(', ') || out.genre,
        track: t.track || out.track, disc: t.disc || out.disc,
      });
    } finally { f.dispose(); }
  }
  return out;
}

function writeFile(p, c) {
  const { File } = require('node-taglib-sharp');
  const f = File.createFromPath(p);
  try {
    const t = f.tag;
    if ('title' in c) t.title = c.title || undefined;
    if ('artist' in c) t.performers = list(c.artist);
    if ('album' in c) t.album = c.album || undefined;
    if ('albumArtist' in c) t.albumArtists = list(c.albumArtist);
    if ('year' in c) t.year = num(c.year);
    if ('genre' in c) t.genres = list(c.genre);
    if ('track' in c) t.track = num(c.track);
    if ('disc' in c) t.disc = num(c.disc);
    f.save();
  } finally { f.dispose(); }
}

function writeRow(p, c) {
  const set = [];
  const v = {};
  const col = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist', year: 'year', genre: 'genre', track: 'track_number', disc: 'disc_number' };
  for (const [k, column] of Object.entries(col)) {
    if (!(k in c)) continue;
    set.push(`${column} = @${k}`);
    if (k === 'albumArtist') v[k] = list(c[k]).join('; ');
    else v[k] = k === 'year' || k === 'track' || k === 'disc' ? (num(c[k]) || null) : (c[k] || null);
  }
  if (set.length) database.initDatabase().prepare(`UPDATE music_files SET ${set.join(', ')} WHERE path = @path`).run({ ...v, path: p });
}

async function edit({ paths, changes, allowReadOnly = false }) {
  const c = Object.fromEntries(Object.entries(changes || {}).filter(([k]) => FIELDS.includes(k)));
  if (!Object.keys(c).length) return { files: [], errors: [] };
  const { upsertSingleFile, toFrontend } = require('./music');
  const files = [];
  const errors = [];
  const cloudPaths = [];
  for (const p of paths || []) {
    try {
      if (isLocal(p)) {
        withWritable(p, allowReadOnly, () => writeFile(p, c));
        files.push(await upsertSingleFile(p));
      } else {
        writeRow(p, c);
        files.push(toFrontend(database.getFileByPath(p)));
      }
      const row = database.getFileByPath(p);
      if (row?.telegram_message_id) cloudPaths.push(p);
    } catch (err) {
      errors.push({ path: p, ...describeWriteError(err, p) });
    }
  }
  if (cloudPaths.length) { try { require('./telecloud/service').indexChanged(cloudPaths); } catch { /* TeleCloud not set up */ } }
  return { files, errors };
}

ipcMain.handle('tags:read', (e, { path: p }) => { try { return { success: true, tags: read(p) }; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('tags:edit', async (e, opts) => { try { return { success: true, ...(await edit(opts || {})) }; } catch (err) { return { success: false, error: err.message }; } });

module.exports = { read, edit };
