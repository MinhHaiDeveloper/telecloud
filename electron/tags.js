// Tag reading shared by the main process and the scan worker (no Electron imports).

const path = require('path');
const fs = require('fs');


function extractLyrics(parsed) {
  const common = parsed.common.lyrics || [];
  if (common.length) {
    const text = common.map(l => {
      if (typeof l === 'string') return l;
      if (l && Array.isArray(l.syncText) && l.syncText.length) {
        return l.syncText.map(t => {
          const ts = (t.timestamp || 0) / 1000;
          const min = String(Math.floor(ts / 60)).padStart(2, '0');
          const sec = (ts % 60).toFixed(2).padStart(5, '0');
          return `[${min}:${sec}]${t.text}`;
        }).join('\n');
      }
      return l && l.text ? l.text : '';
    }).filter(Boolean).join('\n');
    if (text) return text;
  }
  for (const tags of Object.values(parsed.native || {})) {
    for (const tag of tags) {
      const id = String(tag.id || '').toUpperCase();
      if (['UNSYNCEDLYRICS', 'UNSYNCED LYRICS', 'USLT', 'LYRICS', '©LYR'].includes(id)) {
        if (typeof tag.value === 'string') return tag.value;
        if (tag.value && tag.value.text) return tag.value.text;
      }
    }
  }
  return '';
}

/** Parse one file into the flat shape stored in the database. */
async function parseTrack(filePath, stat) {
  const mm = await import('music-metadata');
  const base = {
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    mtime: Math.round(stat.mtimeMs),
    size: stat.size,
  };
  try {
    // Read tags and stream info only; artwork is loaded on demand by the media:// protocol
    const parsed = await mm.parseFile(filePath, { duration: true, skipCovers: true });
    const c = parsed.common;
    const f = parsed.format;
    return {
      ...base,
      title: c.title || path.basename(filePath, base.ext),
      // several ARTIST tags (e.g. "Yu-Peng Chen" + "HOYO-MiX") all count, not only the first
      artist: (c.artists && c.artists.length > 1 ? c.artists.join(', ') : c.artist) || (c.artists && c.artists.join(', ')) || 'Unknown Artist',
      album: c.album || 'Unknown Album',
      year: c.year || null,
      genre: c.genre && c.genre.length ? c.genre.join(', ') : null,
      trackNumber: c.track?.no || null,
      discNumber: c.disk?.no || null,
      duration: f.duration || 0,
      bitrate: f.bitrate || 0,
      sampleRate: f.sampleRate || 0,
      bitDepth: f.bitsPerSample || 0,
      codec: f.codec || null,
      lossless: f.lossless === true ? 1 : f.lossless === false ? 0 : null,
      // no lyrics in the tags: a .lrc with the same name next to the file counts too
      lyrics: extractLyrics(parsed) || sidecarLyrics(filePath),
    };
  } catch (err) {
    console.error(`[Library] Could not parse ${filePath}: ${err.message}`);
    return { ...base, title: path.basename(filePath, base.ext), artist: 'Unknown Artist', album: 'Unknown Album', duration: 0 };
  }
}

function sidecarLyrics(filePath) {
  try {
    const p = path.parse(filePath);
    const lrc = path.join(p.dir, `${p.name}.lrc`);
    const text = fs.existsSync(lrc) ? fs.readFileSync(lrc, 'utf8').trim() : '';
    return text || null;
  } catch { return null; }
}

module.exports = { parseTrack, extractLyrics };
