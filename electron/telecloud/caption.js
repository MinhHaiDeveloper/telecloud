// What TeleCloud writes next to every uploaded file. The "tc1:" marker tells our messages apart
// from anything else in the chat (so "Delete all" never touches the user's own messages).
//   plain:     "Artist – Title\ntc1:<base64url JSON>"
//   encrypted: "tc1:e.<key fingerprint>.<AES-GCM sealed JSON>"   (no readable track info)

const { sealJson, openJson, fingerprint } = require('./crypto');

const MAX_CAPTION = 1000; // Telegram allows 1024 characters for non-Premium accounts
const MARK = 'tc1:';

const clip = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : v);

/** Track info kept with the file (enough to show it in the library without downloading it) */
function trackInfo(row) {
  return {
    title: clip(row.title), artist: clip(row.artist), album: clip(row.album), albumArtist: clip(row.album_artist || row.albumArtist),
    year: row.year || null, genre: clip(row.genre, 60), track: row.track_number || row.trackNumber || null,
    disc: row.disc_number || row.discNumber || null, duration: row.duration || null, bitrate: row.bitrate || null,
    sampleRate: row.sample_rate || row.sampleRate || null, bitDepth: row.bit_depth || row.bitDepth || null,
    codec: clip(row.codec, 20), lossless: row.lossless ?? null,
  };
}

/**
 * @param {object} p  { name, size, sha256, info, enc: { iv } | null, master: Buffer | null }
 */
function buildCaption({ name, size, sha256, info, enc, master }) {
  const payload = { v: 1, name: clip(name, 180), size, sha256, info, ...(enc ? { iv: enc.iv } : {}) };
  const fit = (p) => {
    if (enc) return `${MARK}e.${fingerprint(master)}.${sealJson(master, p)}`;
    const label = [p.info?.artist, p.info?.title].filter(Boolean).join(' – ').slice(0, 200);
    return `${label ? `${label}\n` : ''}${MARK}${Buffer.from(JSON.stringify(p)).toString('base64url')}`;
  };
  let caption = fit(payload);
  // Too long (very long titles): drop the least useful fields until it fits
  for (const k of ['genre', 'albumArtist', 'codec', 'album']) {
    if (caption.length <= MAX_CAPTION) break;
    delete payload.info[k];
    caption = fit(payload);
  }
  if (caption.length > MAX_CAPTION) { payload.name = payload.name.slice(0, 60); payload.info.title = clip(payload.info.title, 60); caption = fit(payload); }
  return caption;
}

// Non-track files TeleCloud keeps in the chat:
//   "tcm1:<enc>"         the library manifest (all tags, lyrics, cover references)
//   "tcc1:<key>:<enc>"   an album cover, shared by every track that uses it,
//                        or an artist's GIF when the key starts with "g"
// where <enc> is "p" (plain) or "e.<key fingerprint>.<iv>" (encrypted with the user's key).
// The manifest's checksum (sha256 of the gzipped index) follows after a space, " s.<sha256>", sealed with the key
// (AES-GCM) when encrypted, so it cannot be changed without the key. Versions before 1.1.0-beta.18 read only the
// first word and still read the manifest; manifests they wrote have no checksum and are read as before.
const encPart = (iv, master) => (iv ? `e.${fingerprint(master)}.${iv}` : 'p');
const buildManifestCaption = ({ iv, master, sha256 }) => `tcm1:${encPart(iv, master)}${sha256 ? ` s.${iv ? sealJson(master, { sha256 }) : sha256}` : ''}`;
/** The checksum in a manifest caption: null when there is none, 'invalid' when it was changed or sealed with another key */
function manifestSha(sealed, encrypted, master) {
  if (!sealed) return null;
  if (!encrypted) return /^[0-9a-f]{64}$/.test(sealed) ? sealed : 'invalid';
  try { return openJson(master, sealed).sha256 || 'invalid'; } catch { return 'invalid'; }
}
const buildCoverCaption = ({ key, iv, master }) => `tcc1:${key}:${encPart(iv, master)}`;

function parseEnc(enc, master) {
  if (!enc || enc === 'p') return { iv: null };
  const [, fp, iv] = enc.split('.');
  if (!master) return { needsKey: true };
  if (fp !== fingerprint(master)) return { wrongKey: true };
  return { iv };
}

/**
 * @returns {{ ours: boolean, kind?: 'track'|'manifest'|'cover', data?: object, key?: string, iv?: string,
 *             needsKey?: boolean, wrongKey?: boolean, legacy?: boolean }}
 */
function parseCaption(text, master) {
  const s = String(text || '');
  const m = s.match(/^tcm1:(\S+)(?:\s+s\.(\S+))?/);
  if (m) {
    const enc = parseEnc(m[1], master);
    return { ours: true, kind: 'manifest', ...enc, sha256: enc.needsKey || enc.wrongKey ? null : manifestSha(m[2], !!enc.iv, master) };
  }
  const c = s.match(/^tcc1:(g?[0-9a-f]+):(\S+)/);
  if (c) return { ours: true, kind: 'cover', key: c[1], ...parseEnc(c[2], master) };
  return { kind: 'track', ...parseTrackCaption(s, master) };
}

function parseTrackCaption(s, master) {
  const at = s.lastIndexOf(MARK);
  if (at >= 0) {
    const body = s.slice(at + MARK.length).trim();
    if (body.startsWith('e.')) {
      const [, fp, sealed] = body.split('.');
      if (!master) return { ours: true, needsKey: true, fingerprint: fp };
      if (fp !== fingerprint(master)) return { ours: true, wrongKey: true, fingerprint: fp };
      try { return { ours: true, data: { ...openJson(master, sealed), encrypted: true } }; } catch { return { ours: true, wrongKey: true, fingerprint: fp }; }
    }
    try { return { ours: true, data: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) }; } catch { return { ours: false }; }
  }
  // Captions written by earlier versions: plain JSON with a checksum
  try {
    const old = JSON.parse(s);
    if (old && old.checksum) {
      return { ours: true, legacy: true, data: { v: 0, sha256: old.checksum, info: { title: old.title, artist: old.artist, album: old.album, duration: old.duration } } };
    }
  } catch { /* not ours */ }
  return { ours: false };
}

module.exports = { buildCaption, buildManifestCaption, buildCoverCaption, parseCaption, trackInfo, MAX_CAPTION };
