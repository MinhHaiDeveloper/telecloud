// TeleCloud Remote, on the host side: what a remote may browse, worked out from what the app already
// holds in memory (the library, favourites, recently played, playlists). Results carry file paths;
// electron/remote.js swaps them for opaque ids before anything leaves this computer.
import { albumIndex, artistsOf, artistLabel, arrivals } from '../utils/albums';
import { qualityOf, mqaOf, sortAlbumTracks, storageOf } from '../utils/audio';

const noThe = (s) => String(s || '').replace(/^the\s+/i, '').toLowerCase();
const byName = (a, b) => noThe(a).localeCompare(noThe(b));
const PAGE = 60;
const page = (list, req) => {
  const offset = Math.max(0, Math.min(list.length, Number(req.offset) || 0));
  const limit = Math.max(1, Math.min(PAGE, Number(req.limit) || PAGE));
  return { items: list.slice(offset, offset + limit), total: list.length, offset };
};

/** A track as remotes see it (the path is replaced by an id on the way out). */
export const trackOut = (f, favs) => {
  if (!f) return null;
  const m = f.metadata || {};
  const q = qualityOf(f);
  // only in TeleCloud: streamed from Telegram, or already in the cache
  const st = storageOf(f);
  const where = st.includes('local') ? undefined : st.includes('cached') ? 'cached' : st.includes('cloud') ? 'cloud' : undefined;
  return { where, path: f.path, title: m.title || f.name, artist: m.artist, album: m.album, duration: m.duration || 0, quality: q.label, tier: q.tier, mqa: mqaOf(f), fav: favs ? favs.has(f.path) : undefined };
};
const albumOut = (a, dedupe) => ({ key: a.key, name: a.name, artist: a.artist, year: a.year || 0, count: (dedupe ? dedupe(a.songs) : a.songs).length, coverPath: a.file?.path });

// worked out once per library list
const artistCache = new WeakMap();
function artistIndex(files) {
  let out = artistCache.get(files);
  if (out) return out;
  const map = new Map();
  files.forEach(f => {
    artistsOf(f).forEach(name => {
      if (artistLabel(name)) return;
      const k = name.toLowerCase();
      if (!map.has(k)) map.set(k, { name, songs: [] });
      map.get(k).songs.push(f);
    });
  });
  const idx = albumIndex(files);
  // the grid shows album artists, as the app does by default
  const owners = new Set(idx.list.flatMap(a => [...a.owners]));
  idx.list.forEach(a => a.ownerNames.forEach(n => { if (!map.has(n.toLowerCase())) map.set(n.toLowerCase(), { name: n, songs: [...a.songs] }); }));
  const list = [...map.values()].filter(a => owners.has(a.name.toLowerCase())).sort((a, b) => byName(a.name, b.name));
  out = { list, byLow: map };
  artistCache.set(files, out);
  return out;
}
const searchCache = new WeakMap();
function haystack(files) {
  let h = searchCache.get(files);
  if (!h) {
    h = files.map(f => { const m = f.metadata || {}; return `${m.title || f.name || ''}\u0001${m.artist || ''}\u0001${m.album || ''}\u0001${m.albumArtist || ''}`.toLowerCase(); });
    searchCache.set(files, h);
  }
  return h;
}
function searchTracks(files, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const h = haystack(files);
  const out = [];
  for (let i = 0; i < files.length && out.length < 500; i++) if (words.every(w => h[i].includes(w))) out.push(files[i]);
  return out;
}

function artistSongs(ctx, name) {
  const a = artistIndex(ctx.files).byLow.get(String(name || '').toLowerCase());
  if (!a) return [];
  const idx = albumIndex(ctx.files);
  const albums = [...new Set(a.songs.map(f => idx.byPath.get(f.path)).filter(Boolean))].sort((x, y) => (y.year - x.year) || byName(x.name, y.name));
  const mine = new Set(a.songs.map(f => f.path));
  return albums.flatMap(al => sortAlbumTracks(al.songs.filter(f => mine.has(f.path))));
}

/** The tracks a "play this" from a remote means, in order. */
export function resolveSource(ctx, source = {}) {
  const dd = (l) => (ctx.dedupe ? ctx.dedupe(l) : l);
  switch (source.kind) {
    case 'album': { const a = albumIndex(ctx.files).byKey.get(source.key); return a ? sortAlbumTracks(dd(a.songs)) : []; }
    case 'artist': return dd(artistSongs(ctx, source.key));
    case 'playlist': return ctx.playlists.find(p => String(p.id) === String(source.key))?.songs || [];
    case 'favorites': return ctx.favorites;
    case 'recent': return ctx.recent;
    case 'search': return searchTracks(ctx.files, String(source.key || ''));
    default: return [];
  }
}

/** One question from a remote: { kind, ... } → plain data with paths. */
export function answer(ctx, req = {}) {
  const favs = new Set(ctx.favorites.map(f => f.path));
  const tracks = (l) => l.map(f => trackOut(f, favs));
  const idx = albumIndex(ctx.files);
  switch (req.kind) {
    case 'home': return {
      albums: idx.list.length, artists: artistIndex(ctx.files).list.length, playlists: ctx.playlists.length,
      favorites: ctx.favorites.length, recent: ctx.recent.length, tracks: ctx.files.length,
    };
    case 'search': {
      const q = String(req.q || '').trim().toLowerCase();
      if (!q) return { tracks: [], albums: [], artists: [] };
      const words = q.split(/\s+/);
      const hit = (s) => words.every(w => String(s || '').toLowerCase().includes(w));
      return {
        tracks: tracks(searchTracks(ctx.files, q).slice(0, 40)),
        albums: idx.list.filter(a => hit(`${a.name} ${a.artist}`)).sort((a, b) => byName(a.name, b.name)).slice(0, 12).map(a => albumOut(a, ctx.dedupe)),
        artists: artistIndex(ctx.files).list.filter(a => hit(a.name)).slice(0, 12).map(a => ({ name: a.name, count: a.songs.length, coverPath: a.songs[0]?.path, pictureOf: a.name })),
      };
    }
    case 'albums': {
      const list = [...idx.list];
      if (req.sort === 'artist') list.sort((a, b) => byName(a.artist, b.artist) || (a.year - b.year));
      // added to the library, as Albums sorts them in the app
      else if (req.sort === 'latest') { const older = arrivals(ctx.files, list); list.sort((a, b) => older(b, a)); }
      else if (req.sort === 'oldest') list.sort(arrivals(ctx.files, list));
      else list.sort((a, b) => byName(a.name, b.name));
      const p = page(list, req);
      return { ...p, items: p.items.map(a => albumOut(a, ctx.dedupe)) };
    }
    case 'album': {
      const a = idx.byKey.get(req.key);
      if (!a) return { missing: true };
      return { album: albumOut(a, ctx.dedupe), tracks: tracks(resolveSource(ctx, { kind: 'album', key: a.key })) };
    }
    case 'artists': {
      const p = page(artistIndex(ctx.files).list, req);
      return { ...p, items: p.items.map(a => ({ name: a.name, count: a.songs.length, coverPath: (idx.byPath.get(a.songs[0]?.path)?.file || a.songs[0])?.path, pictureOf: a.name })) };
    }
    case 'artist': {
      const a = artistIndex(ctx.files).byLow.get(String(req.key || '').toLowerCase());
      if (!a) return { missing: true };
      const albums = [...new Set(a.songs.map(f => idx.byPath.get(f.path)).filter(Boolean))].sort((x, y) => (y.year - x.year) || byName(x.name, y.name));
      return { artist: { name: a.name, count: a.songs.length, coverPath: albums[0]?.file?.path, pictureOf: a.name }, albums: albums.map(al => albumOut(al, ctx.dedupe)) };
    }
    case 'playlists': return { items: ctx.playlists.map(p => ({ key: String(p.id), name: p.name, count: p.songs.length, coverPath: p.songs[0]?.path })) };
    case 'playlist': {
      const p = ctx.playlists.find(x => String(x.id) === String(req.key));
      if (!p) return { missing: true };
      return { playlist: { key: String(p.id), name: p.name, count: p.songs.length, coverPath: p.songs[0]?.path }, tracks: tracks(p.songs) };
    }
    case 'favorites': { const p = page(ctx.favorites, req); return { ...p, items: tracks(p.items) }; }
    case 'recent': { const p = page(ctx.recent, req); return { ...p, items: tracks(p.items) }; }
    default: return { error: 'unknown' };
  }
}
