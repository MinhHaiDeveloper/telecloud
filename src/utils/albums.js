// Which tracks form one album, and who it belongs to. Every page uses this, so they all agree.
//  - Same name and overlapping album artists: one album, however many guests the tracks have.
//  - Same name, different album artists: two albums (two "Greatest Hits").
//  - No album artist tag: tracks in one folder stay together; across folders they join when the
//    main artist matches. Partly tagged albums join the tagged part the same way.
//  - Various Artists or no artist at all says nothing about who made it, so the same name isn't
//    enough: two folders join only when their disc numbers show they are discs of one album.

export const UNKNOWN_ALBUM = 'Unknown Album';
export const UNKNOWN_ARTIST = 'Unknown Artist';
export const VARIOUS_ARTISTS = 'Various Artists';
const VARIOUS = /^(various( artists)?|va|v\.a\.?|compilations?)$/i;
const UNKNOWN = /^unknown( artist)?$/i;
/** "Various Artists" and "Unknown Artist" are labels for many artists, not somebody with a picture and a bio */
export const artistLabel = (name) => {
  const n = (name || '').trim();
  if (VARIOUS.test(n)) return VARIOUS_ARTISTS;
  return UNKNOWN.test(n) ? UNKNOWN_ARTIST : null;
};

const norm = (s) => (s || '').trim().toLowerCase();
const folderOf = (p) => (!p || p.startsWith('tc://') ? '' : p.replace(/[\\/][^\\/]*$/, '').replace(/[\\/](?:cd|disc|disk)\s*[-_.]?\s*\d{1,2}$/i, '').toLowerCase());

// "A, B & C feat. D" → each artist on its own
export const splitArtists = (s) => (s || '').split(/[,;、]|\s+[&/]\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i).map(a => a.trim()).filter(Boolean);
/** Album artists are stored one per value, so "Earth, Wind & Fire" stays one name */
export const albumArtistsOf = (f) => (f?.metadata?.albumArtist || '').split(/\s*[;、]\s*/).map(a => a.trim()).filter(Boolean);
/** The artists of a track. When it equals the album artist tag, the tag says where to split. */
export const artistsOf = (f) => {
  const artist = f?.metadata?.artist || '';
  const aa = f?.metadata?.albumArtist || '';
  return aa && norm(artist) === norm(aa) ? albumArtistsOf(f) : splitArtists(artist);
};

const overlap = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

const disjoint = (a, b) => { for (const x of a) if (b.has(x)) return false; return true; };
/** Same album name, nobody named: is it still one album? A track with no folder (cloud-only) can't say otherwise. */
const sameNamelessAlbum = (a, b) => (
  !a.folder || !b.folder || a.folder === b.folder || (a.discs.size > 0 && b.discs.size > 0 && disjoint(a.discs, b.discs))
);

const shouldJoin = (a, b) => {
  const sameFolder = !!a.folder && a.folder === b.folder;
  const aTagged = a.owners.size > 0 || a.various;
  const bTagged = b.owners.size > 0 || b.various;
  if (aTagged && bTagged) return overlap(a.owners, b.owners) || (a.various && b.various && sameNamelessAlbum(a, b));
  if (aTagged || bTagged) {
    const [tagged, plain] = aTagged ? [a, b] : [b, a];
    return sameFolder || overlap(tagged.owners, plain.mains);
  }
  if (!a.mains.size && !b.mains.size) return sameNamelessAlbum(a, b);
  return sameFolder || overlap(a.mains, b.mains);
};

const mostCommon = (counts) => [...counts.entries()].sort((x, y) => y[1] - x[1])[0] || ['', 0];

function buildIndex(files) {
  const groups = new Map();
  for (const f of files) {
    if (!f?.path) continue;
    const name = (f.metadata?.album || UNKNOWN_ALBUM).trim() || UNKNOWN_ALBUM;
    const aa = albumArtistsOf(f);
    const various = aa.some(x => VARIOUS.test(x));
    const owners = aa.filter(x => !VARIOUS.test(x)).map(norm);
    const folder = folderOf(f.path);
    const k = `${norm(name)}\u0000${folder}\u0000${various ? '*' : [...owners].sort().join('|')}`;
    if (!groups.has(k)) groups.set(k, { nameKey: norm(name), folder, various, owners: new Set(owners), mains: new Set(), discs: new Set(), files: [] });
    const g = groups.get(k);
    g.files.push({ f, name });
    const main = artistsOf(f)[0];
    if (main && !UNKNOWN.test(main)) g.mains.add(norm(main));
    if (f.metadata?.disc > 0) g.discs.add(f.metadata.disc);
  }

  // join groups of the same album name
  const byName = new Map();
  for (const g of groups.values()) {
    if (!byName.has(g.nameKey)) byName.set(g.nameKey, []);
    byName.get(g.nameKey).push(g);
  }
  const albums = [];
  for (const list of byName.values()) {
    const parent = list.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    if (list.length <= 1500) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (find(i) !== find(j) && shouldJoin(list[i], list[j])) parent[find(j)] = find(i);
    }
    const sets = new Map();
    list.forEach((g, i) => { const r = find(i); if (!sets.has(r)) sets.set(r, []); sets.get(r).push(g); });
    for (const set of sets.values()) albums.push(set);
  }

  const list = [];
  const byKey = new Map();
  const byPath = new Map();
  for (const set of albums) {
    const songs = [];
    const names = new Map();
    const tagged = new Map();
    const credits = new Map();
    let owners = new Set();
    let ownerNames = new Map();
    let tagVarious = false;
    for (const g of set) {
      g.owners.forEach(o => owners.add(o));
      tagVarious = tagVarious || g.various;
      for (const { f, name } of g.files) {
        songs.push(f);
        names.set(name, (names.get(name) || 0) + 1);
        const aa = albumArtistsOf(f);
        if (aa.length) { const label = aa.join(', '); tagged.set(label, (tagged.get(label) || 0) + 1); }
        aa.filter(x => !VARIOUS.test(x)).forEach(x => { if (!ownerNames.has(norm(x))) ownerNames.set(norm(x), x); });
        const main = artistsOf(f)[0];
        if (main) credits.set(main, (credits.get(main) || 0) + 1);
      }
    }
    let artist;
    if (tagged.size) {
      artist = mostCommon(tagged)[0];
      if (tagVarious && !owners.size) artist = VARIOUS_ARTISTS;
    } else {
      // no tag at all: one artist on most tracks owns it, otherwise it is a compilation
      const [top, n] = mostCommon(credits);
      if (!top || same(top, UNKNOWN_ARTIST)) artist = credits.size > 1 ? VARIOUS_ARTISTS : UNKNOWN_ARTIST;
      else if (n * 2 > songs.length) { artist = top; owners = new Set([norm(top)]); ownerNames = new Map([[norm(top), top]]); } else artist = VARIOUS_ARTISTS;
    }
    const name = mostCommon(names)[0];
    let key = `${norm(name)}\u0000${norm(artist)}`;
    if (byKey.has(key)) key = `${key}\u0000${set[0].folder}`;
    const album = { key, name, artist, owners, ownerNames: [...ownerNames.values()], file: songs[0], songs, year: songs.find(f => f.metadata?.year)?.metadata?.year || 0 };
    list.push(album);
    byKey.set(key, album);
    songs.forEach(f => byPath.set(f.path, album));
  }
  return { list, byKey, byPath };
}
const same = (a, b) => norm(a) === norm(b);

/** When each album came into the library: oldest first. Tracks added in one scan share a time: their order in the library decides. */
export const arrivals = (files, albums) => {
  const pos = new Map(files.map((f, i) => [f.path, i]));
  const at = new Map();
  albums.forEach((a) => {
    const time = Math.min(...a.songs.map(s => new Date(s.added_at || 0).getTime() || 0));
    at.set(a, [time, Math.min(...a.songs.map(s => pos.get(s.path) ?? 0))]);
  });
  return (a, b) => (at.get(a)[0] - at.get(b)[0]) || (at.get(a)[1] - at.get(b)[1]);
};

export const trackCount = (n) => `${n.toLocaleString()} ${n === 1 ? 'track' : 'tracks'}`;

const cache = new WeakMap();
/** The albums of a list of tracks: { list, byKey, byPath }. The same list is only worked out once. */
export function albumIndex(files) {
  let idx = cache.get(files);
  if (!idx) { idx = buildIndex(files); cache.set(files, idx); }
  return idx;
}

const noThe = (s) => String(s || '').toLowerCase().replace(/^the /, '');
/** The Albums page's order for each of its sorts */
export function sortAlbums(albums, sortBy, files) {
  const list = [...albums];
  switch (sortBy) {
    case 'name-desc': return list.sort((a, b) => noThe(b.name).localeCompare(noThe(a.name)));
    case 'artist': return list.sort((a, b) => noThe(a.artist).localeCompare(noThe(b.artist)));
    case 'tracks': return list.sort((a, b) => b.songs.length - a.songs.length);
    case 'latest': { const older = arrivals(files, list); return list.sort((a, b) => older(b, a)); }
    case 'oldest': return list.sort(arrivals(files, list));
    default: return list.sort((a, b) => noThe(a.name).localeCompare(noThe(b.name)));
  }
}

// ---------- after an album: what plays next
const trackKey = (f) => `${f.metadata?.disc || 1}|${f.metadata?.track || 0}|${noThe(f.metadata?.title || f.name)}`;

/** The album the queue ends with, when all of it is there (in any order, so also shuffled). Null otherwise. */
export function albumAtEnd(queue, files) {
  if (!queue?.length) return null;
  const { byPath } = albumIndex(files);
  const album = byPath.get(queue[queue.length - 1].path);
  if (!album) return null;
  const have = new Set();
  for (let i = queue.length - 1; i >= 0 && byPath.get(queue[i].path) === album; i--) have.add(trackKey(queue[i]));
  const all = new Set(album.songs.map(trackKey));
  return have.size >= all.size ? album : null;
}

/**
 * The album to play after `album`: the same artist's next one by year, then the one beside it in the
 * Albums list (in the order chosen there), going round to the start. Albums in `played` are skipped.
 */
export function nextAlbum(album, files, { sortBy = 'name', played = new Set() } = {}) {
  const { list } = albumIndex(files);
  const skip = (a) => a === album || played.has(a.key) || !a.songs.length;
  if (album.owners.size && album.artist !== VARIOUS_ARTISTS) {
    const mine = list.filter(a => [...album.owners].some(o => a.owners.has(o)))
      .sort((a, b) => (a.year || 0) - (b.year || 0) || noThe(a.name).localeCompare(noThe(b.name)));
    const later = mine.slice(mine.indexOf(album) + 1).find(a => !skip(a));
    if (later) return later;
  }
  const order = sortAlbums(list, sortBy, files);
  const at = order.indexOf(album);
  for (let i = 1; i < order.length; i++) {
    const a = order[(at + i) % order.length];
    if (!skip(a)) return a;
  }
  return null;
}
