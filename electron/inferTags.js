// What to show when a file's tags are missing (CD rips, WAVs, old downloads): the file name and
// its folders say a lot. Nothing is written to the file; the library only displays these values.
// No Electron imports: pure, so it is easy to test.
const path = require('path');

const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_ALBUM = 'Unknown Album';
const GENERIC = /^(my )?music$|^(downloads?|desktop|documents|audio|songs?|tracks?|new folder|untitled|unknown( album| artist)?|albums?|artists?|singles?|flac|mp3|wav|cd rips?|rips?|telecloud)$/i;
const DISC = /^(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})$/i;
const NOT_AN_ARTIST = /remaster|\blive\b|version|\bedit\b|\bmix\b|acoustic|instrumental/i;
const FOLDER_NOISE = /\s*[[(](?:(?:19|20)\d{2}|flac|mp3|wav|ape|alac|aac|lossless|cd|web|vinyl|\d{2,3}\s*kbps|(?:16|24)\s*-?\s*bit[^\])]*|(?:44|48|88|96|176|192)(?:[.,]\d)?\s*khz)[\])]\s*$/i;

const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
const known = (v, unknown) => !!v && !same(v, unknown);

/** The folders from the music folder down to the file, outermost first */
function foldersOf(filePath, roots = []) {
  if (!filePath || filePath.startsWith('tc://')) return [];
  let rel = null;
  for (const root of roots) {
    const r = path.relative(root, filePath);
    if (r && !r.startsWith('..') && !path.isAbsolute(r) && (rel === null || r.length < rel.length)) rel = r;
  }
  if (rel === null) rel = filePath.slice(path.parse(filePath).root.length);
  return rel.split(/[\\/]/).slice(0, -1).filter(Boolean);
}

/** "Discovery (2001) [FLAC]" -> { name: "Discovery", year: 2001 }; "2001 - Discovery" too */
function cleanFolder(name) {
  let s = name.trim();
  let year = null;
  const note = (y) => { if (!year && y) year = Number(y); };
  for (let i = 0; i < 4 && FOLDER_NOISE.test(s); i++) {
    note(/(19|20)\d{2}/.exec(s.match(FOLDER_NOISE)[0])?.[0]);
    s = s.replace(FOLDER_NOISE, '');
  }
  const lead = /^((?:19|20)\d{2})\s*[-.]\s*(.+)$/.exec(s);
  if (lead) { note(lead[1]); s = lead[2]; }
  return { name: s.trim(), year };
}

/** "1-03 Artist - Title" -> { disc, track, artist, album, title } as far as it can tell */
function parseName(base, knownArtist) {
  let s = base.includes(' ') ? base : base.replace(/_/g, ' ');
  let disc = 0;
  let track = 0;
  let m = /^(\d)-(\d{2})\s+(.+)$/.exec(s);
  if (m) { disc = Number(m[1]); track = Number(m[2]); s = m[3]; }
  else if ((m = /^(?:audio\s*)?track\s*[-_ ]?(\d{1,3})$/i.exec(s))) return { track: Number(m[1]), title: s };
  else if ((m = /^(\d{1,3})\s*[-.)]\s*(.+)$/.exec(s)) || (m = /^(0\d)\s+(.+)$/.exec(s))) { track = Number(m[1]); s = m[2]; }
  const parts = s.split(/\s+-\s+/);
  const out = { disc, track, title: s };
  if (parts.length >= 3) {
    out.artist = parts[0];
    out.album = parts[1];
    out.title = parts.slice(2).join(' - ');
  } else if (parts.length === 2 && !NOT_AN_ARTIST.test(parts[1])) {
    // with a known artist, only a matching first part is the artist: "Song - Part 2" stays whole
    if (!knownArtist || same(parts[0], knownArtist)) { out.artist = parts[0]; out.title = parts[1]; }
  }
  return out;
}

/**
 * A database row with the gaps filled in. Returns the row itself when nothing is missing.
 * `inferred` lists the fields that did not come from the tags.
 */
function inferRow(row, roots = []) {
  const name = row.name || path.basename(row.path || '');
  const base = name.replace(/\.[^.\\/]+$/, '');
  const hasTitle = !!row.title && row.title !== base && row.title !== name;
  const hasArtist = known(row.artist, UNKNOWN_ARTIST);
  const hasAlbum = known(row.album, UNKNOWN_ALBUM);
  if (hasTitle && hasArtist && hasAlbum) return row;

  const inferred = [];
  const out = { ...row };
  let artist = hasArtist ? row.artist : '';
  // the album artist is the next best thing to a track artist
  const albumArtist = (row.album_artist || '').split(';')[0].trim();
  if (!artist && albumArtist) { artist = albumArtist; out.artist = artist; inferred.push('artist'); }

  const parsed = parseName(base, artist);
  const folders = foldersOf(row.path, roots);
  let disc = 0;
  if (folders.length && DISC.test(folders[folders.length - 1])) disc = Number(DISC.exec(folders.pop())[1]);
  const albumFolder = folders.length ? cleanFolder(folders[folders.length - 1]) : null;
  const artistFolder = folders.length > 1 ? folders[folders.length - 2].trim() : '';

  if (!hasTitle) {
    if (parsed.title && parsed.title !== row.title) { out.title = parsed.title; inferred.push('title'); }
    else if (!row.title) { out.title = base; inferred.push('title'); }
    if (!row.track_number && parsed.track) out.track_number = parsed.track;
    if (!row.disc_number && parsed.disc) out.disc_number = parsed.disc;
  }
  if (!row.disc_number && !out.disc_number && disc) out.disc_number = disc;
  if (!artist && parsed.artist) artist = parsed.artist;

  let album = hasAlbum ? row.album : '';
  if (!album && parsed.album) album = parsed.album;
  if (!album && albumFolder && !GENERIC.test(albumFolder.name)) {
    // "Daft Punk - Discovery": the artist's part only comes off when it fits
    const pair = /^(.+?)\s+-\s+(.+)$/.exec(albumFolder.name);
    if (pair && (!artist || same(pair[1], artist))) { if (!artist) artist = pair[1].trim(); album = pair[2].trim(); }
    else if (!same(albumFolder.name, artist)) album = albumFolder.name;
    if (album && !row.year && albumFolder.year) out.year = albumFolder.year;
  }
  if (!artist && artistFolder && !GENERIC.test(artistFolder)) artist = cleanFolder(artistFolder).name;

  if (!hasArtist && artist && !inferred.includes('artist')) { out.artist = artist; inferred.push('artist'); }
  if (!hasArtist && !artist) out.artist = UNKNOWN_ARTIST;
  if (!hasAlbum && album) { out.album = album; inferred.push('album'); }
  if (!hasAlbum && !album) out.album = UNKNOWN_ALBUM;
  if (inferred.length) out.inferred = inferred;
  return out;
}

module.exports = { inferRow, foldersOf, cleanFolder, parseName, UNKNOWN_ARTIST, UNKNOWN_ALBUM };
