// Cover art for library tracks: embedded art first, then a cover image next to the file.
// Results are cached as ≤600 px images (the UI never shows them bigger). Cloud-only tracks use
// the album cover TeleCloud stored with the library ("cloud-<key>.jpg").

const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const fsp = fs.promises;
const FOLDER_ART = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', 'album.jpg', 'albumart.jpg'];
const coverDir = () => path.join(app.getPath('userData'), 'cover-cache');
const noCover = new Set();
const pending = new Map();

const readIfExists = (file) => fsp.readFile(file).catch(() => null);
const isJpeg = (buf) => buf && buf[0] === 0xff && buf[1] === 0xd8;

// A file can hold several pictures. An "Artist" one is about the performer, never the album's cover.
const isArtistPictureType = (type) => /^(artist|lead artist|band)/i.test(type || '');
// (selectCover fails on an empty list, so "none" has to stay undefined)
const coverPictures = (pictures) => {
  const list = (pictures || []).filter(p => !isArtistPictureType(p.type));
  return list.length ? list : undefined;
};
/** The same test on a picture read by node-taglib-sharp: LeadArtist 7, Artist 8, Band 10 */
const isArtistTagPicture = (p) => [7, 8, 10].includes(p?.type);

/** Shrink to 600 px and store; concurrent requests for the same image share one resize */
function cacheCover(cacheFile, data) {
  if (pending.has(cacheFile)) return pending.get(cacheFile);
  const job = (async () => {
    const img = nativeImage.createFromBuffer(data);
    if (!img.isEmpty()) {
      const { width, height } = img.getSize();
      if (Math.max(width, height) > 600) {
        data = (width >= height ? img.resize({ width: 600, quality: 'good' }) : img.resize({ height: 600, quality: 'good' })).toJPEG(88);
      }
    }
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(cacheFile, data);
    return data;
  })().finally(() => pending.delete(cacheFile));
  pending.set(cacheFile, job);
  return job;
}

/** Cover image (≤600 px) for an audio file on disk, or null */
async function coverForFile(source) {
  const stat = await fsp.stat(source);
  const key = crypto.createHash('sha1').update(`${source}|${stat.mtimeMs}|${stat.size}`).digest('hex');
  if (noCover.has(key)) return null;
  const cacheFile = path.join(coverDir(), `${key}.img`);
  const cached = await readIfExists(cacheFile);
  if (cached) return cached;

  const mm = await import('music-metadata');
  const meta = await mm.parseFile(source, { duration: false, skipCovers: false, skipPostHeaders: true });
  const embedded = mm.selectCover(coverPictures(meta.common.picture))?.data;
  if (embedded) return cacheCover(cacheFile, Buffer.from(embedded));

  // Folder art is shared by the whole album: cache it once under the image's own key
  const dir = path.dirname(source);
  const names = new Map((await fsp.readdir(dir)).map(n => [n.toLowerCase(), n]));
  const hit = FOLDER_ART.find(n => names.has(n));
  if (!hit) { noCover.add(key); return null; }
  const artPath = path.join(dir, names.get(hit));
  const artStat = await fsp.stat(artPath);
  const artKey = crypto.createHash('sha1').update(`folder|${artPath}|${artStat.mtimeMs}|${artStat.size}`).digest('hex');
  const artFile = path.join(coverDir(), `${artKey}.img`);
  return (await readIfExists(artFile)) || cacheCover(artFile, await fsp.readFile(artPath));
}

/** The cover as a JPEG plus a content key (same picture → same key, so an album uploads it once) */
async function coverJpeg(source) {
  let buf = await coverForFile(source).catch(() => null);
  if (!buf) return null;
  if (!isJpeg(buf)) {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    buf = img.toJPEG(88);
  }
  return { key: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20), buffer: buf };
}

const cloudCoverFile = (key) => path.join(coverDir(), `cloud-${String(key).replace(/[^0-9a-f]/g, '')}.jpg`);

module.exports = { isArtistPictureType, isArtistTagPicture, coverPictures, coverForFile, coverJpeg, cloudCoverFile, coverDir, readIfExists, clearMissing: () => noCover.clear() };
