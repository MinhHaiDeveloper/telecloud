// Listening history: one row per play, kept even if the track later leaves the library
// (title/artist/album are stored with the play). Feeds play counts, the Dashboard and Last.fm.
const { ipcMain, BrowserWindow } = require('electron');
const database = require('./database');

let ready = null;
function db() {
  const d = database.initDatabase();
  if (ready !== d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        listened_ms INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        title TEXT, artist TEXT, album TEXT,
        quality TEXT,
        scrobbled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS plays_at ON plays(played_at);
      CREATE INDEX IF NOT EXISTS plays_path ON plays(path);
    `);
    ready = d;
  }
  return d;
}

/**
 * A play counts like a Last.fm scrobble: the track is longer than 30 s and was heard for
 * half its length or 4 minutes, whichever comes first.
 */
const counts = ({ listenedMs, durationMs }) => durationMs > 30000 && listenedMs >= Math.min(durationMs / 2, 240000);

const listeners = new Set();
function addPlay(p) {
  if (!p?.path || !counts(p)) return null;
  const row = {
    path: String(p.path), played_at: Number(p.startedAt) || Date.now(), listened_ms: Math.round(p.listenedMs), duration_ms: Math.round(p.durationMs),
    title: p.title || null, artist: p.artist || null, album: p.album || null, quality: p.quality || null,
  };
  const r = db().prepare(`INSERT INTO plays (path, played_at, listened_ms, duration_ms, title, artist, album, quality)
    VALUES (@path, @played_at, @listened_ms, @duration_ms, @title, @artist, @album, @quality)`).run(row);
  const play = { id: Number(r.lastInsertRowid), ...row };
  listeners.forEach(fn => { try { fn(play); } catch { /* a listener must not break counting */ } });
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('stats:changed', { path: play.path }));
  return play;
}

/**
 * Plays are kept by file path. A file that was moved or renamed comes back with a new path, so plays
 * whose path is no longer in the library are re-attached to the library track with the same title,
 * artist and album (and a length within 2 s). Cheap: only orphaned plays are looked at.
 */
function relink() {
  const d = db();
  const orphans = d.prepare('SELECT DISTINCT path, title, artist, album, duration_ms FROM plays WHERE path NOT IN (SELECT path FROM music_files)').all();
  if (!orphans.length) return 0;
  const find = d.prepare(`SELECT path FROM music_files
    WHERE lower(title) = lower(@title) AND lower(ifnull(artist, '')) = lower(ifnull(@artist, '')) AND lower(ifnull(album, '')) = lower(ifnull(@album, ''))
      AND (@dur = 0 OR abs(ifnull(duration, 0) * 1000 - @dur) <= 2000)
    ORDER BY (name = @base) DESC, created_at DESC LIMIT 1`);
  const move = d.prepare('UPDATE plays SET path = ? WHERE path = ?');
  let n = 0;
  d.transaction(() => {
    for (const o of orphans) {
      if (!o.title) continue;
      // same tags, and preferably the same file name (two tracks of an album can share a title)
      const hit = find.get({ title: o.title, artist: o.artist, album: o.album, dur: o.duration_ms || 0, base: require('path').basename(o.path) });
      if (hit) n += move.run(hit.path, o.path).changes;
    }
  })();
  return n;
}

const playCounts = () => relink() >= 0 && Object.fromEntries(db().prepare('SELECT path, COUNT(*) n FROM plays GROUP BY path').all().map(r => [r.path, r.n]));

const splitArtists = (s) => (s || '').split(/[,;、]|\s+[&/]\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i).map(a => a.trim()).filter(Boolean);

/**
 * Everything the Dashboard shows for [from, to): totals, a time series in local buckets
 * (hour / day / month), top tracks / artists / albums, listening by quality and by hour of day.
 */
function summary({ from, to, bucket = 'day' }) {
  relink();
  const rows = db().prepare('SELECT * FROM plays WHERE played_at >= ? AND played_at < ? ORDER BY played_at').all(from, to);
  const totals = { plays: rows.length, ms: 0, tracks: new Set(), artists: new Set(), albums: new Set() };
  const series = new Map();
  const tracks = new Map(), artists = new Map(), albums = new Map();
  const quality = { hires: 0, lossless: 0, lossy: 0 };
  const hours = Array.from({ length: 24 }, () => 0);
  // buckets in the computer's local time (main and window share it)
  const keyOf = (t) => {
    const d = new Date(t);
    if (bucket === 'hour') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    if (bucket === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const bump = (map, key, extra, ms) => { const e = map.get(key) || { ...extra, plays: 0, ms: 0 }; e.plays++; e.ms += ms; map.set(key, e); };
  // one album stays one album, however many guests its tracks have
  let albumArtistOf = new Map();
  try { albumArtistOf = new Map(db().prepare("SELECT path, album_artist FROM music_files WHERE album_artist IS NOT NULL AND album_artist != ''").all().map(x => [x.path, x.album_artist])); } catch { /* older database */ }
  for (const r of rows) {
    totals.ms += r.listened_ms;
    totals.tracks.add(r.path);
    if (r.album) totals.albums.add(r.album);
    const k = keyOf(r.played_at);
    const s = series.get(k) || { t: k, plays: 0, ms: 0 }; s.plays++; s.ms += r.listened_ms; series.set(k, s);
    bump(tracks, r.path, { path: r.path, title: r.title, artist: r.artist, album: r.album }, r.listened_ms);
    splitArtists(r.artist).forEach(a => { totals.artists.add(a); bump(artists, a, { name: a }, r.listened_ms); });
    if (r.album) {
      const owner = (albumArtistOf.get(r.path) || '').replace(/\s*;\s*/g, ', ') || splitArtists(r.artist)[0] || '';
      bump(albums, `${r.album}\u0000${owner.toLowerCase()}`, { name: r.album, artist: owner, path: r.path }, r.listened_ms);
    }
    if (quality[r.quality] !== undefined) quality[r.quality] += r.listened_ms;
    hours[new Date(r.played_at).getHours()] += r.listened_ms;
  }
  const top = (map, n = 10) => [...map.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms).slice(0, n);
  return {
    totals: { plays: totals.plays, ms: totals.ms, tracks: totals.tracks.size, artists: totals.artists.size, albums: totals.albums.size },
    series: [...series.values()],
    topTracks: top(tracks), topArtists: top(artists), topAlbums: top(albums, 8),
    quality, hours,
    first: db().prepare('SELECT MIN(played_at) t FROM plays').get().t || null,
  };
}

ipcMain.handle('stats:add-play', (e, p) => addPlay(p));
ipcMain.handle('stats:counts', () => playCounts());
ipcMain.handle('stats:summary', (e, q) => summary(q || {}));

module.exports = { addPlay, playCounts, summary, relink, onPlay: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, db, counts };
