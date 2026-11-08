import { albumIndex, albumArtistsOf, splitArtists, UNKNOWN_ALBUM } from './albums';
// Shared helpers for presenting tracks: time, quality labels, storage badges, signal path

export const formatTime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

export const formatDuration = (sec) => {
  const s = Math.floor(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h && !m) return `${s} sec`;
  return h ? `${h} h ${m} min` : `${m} min`;
};

export const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
};

// A cover that was just saved gets a new address (the old one stays in the browser's image cache);
// a cover found online but not saved yet shows for its album until it is saved or dropped.
const coverRevisions = new Map();
const coverPreviews = new Map();
const coversChanged = () => window.dispatchEvent(new Event('telecloud:covers'));
const artistRevisions = new Map();
/** Same scheme as covers. The name is part of the address, so the page can't reach anything else. */
export const artistImageUrl = (name) => {
  const rev = artistRevisions.get(name);
  return `media://${encodeURIComponent(`artist:${name}`)}${rev ? `?r=${rev}` : ''}`;
};
export const bumpArtist = (name) => {
  artistRevisions.set(name, Date.now());
  window.dispatchEvent(new CustomEvent('telecloud:artists', { detail: name }));
};
export const bumpCovers = (paths) => { const r = Date.now(); (paths || []).forEach(p => { coverRevisions.set(p, r); coverPreviews.delete(p); }); coversChanged(); };
export const setCoverPreview = (paths, url) => { coverPreviews.clear(); (paths || []).forEach(p => coverPreviews.set(p, url)); coversChanged(); };
export const clearCoverPreview = () => { if (coverPreviews.size) { coverPreviews.clear(); coversChanged(); } };
export const coverUrl = (file) => {
  if (!file?.path) return file?.cover || null;
  const preview = coverPreviews.get(file.path);
  if (preview) return preview;
  const rev = coverRevisions.get(file.path);
  return `media://${encodeURIComponent(file.path)}${rev ? `?r=${rev}` : ''}`;
};
const firstCredit = (a) => splitArtists(a)[0] || '';
const hasAlbum = (f) => { const a = f?.metadata?.album; return !!a && a !== UNKNOWN_ALBUM; };
/** Every track a cover applies to: the album (including copies elsewhere), or just the given tracks when they span albums */
export const coverTargets = (files, all) => {
  if (!files?.length) return [];
  if (!all || !hasAlbum(files[0])) return files;
  const idx = albumIndex(all);
  const album = idx.byPath.get(files[0].path);
  if (!album || files.some(f => idx.byPath.get(f.path) !== album)) return files;
  return album.songs;
};
/** Album and main artist to search for ("Various" albums search by name only) */
export const albumQuery = (files) => {
  const first = files?.[0];
  if (!first) return { album: '', artist: '' };
  const tagged = albumArtistsOf(first)[0];
  if (tagged) return { album: hasAlbum(first) ? first.metadata.album : '', artist: /^various/i.test(tagged) ? '' : tagged };
  const counts = new Map();
  files.forEach(f => { const a = firstCredit(f.metadata?.artist); if (a && a !== 'Unknown Artist') counts.set(a, (counts.get(a) || 0) + 1); });
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  return { album: hasAlbum(first) ? first.metadata.album : '', artist: n * 2 > files.length ? top : '' };
};

const LOSSLESS_EXT = new Set(['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv', 'tta']);
const DSD_EXT = new Set(['dsf', 'dff']);

const khz = (rate) => {
  const k = rate / 1000;
  return Number.isInteger(k) ? String(k) : k.toFixed(1);
};

/**
 * Describe a track's quality.
 * tier: 'hires' (> 16-bit or > 48 kHz, or DSD), 'lossless' (CD quality), 'lossy'
 */
export const qualityOf = (file) => {
  const ext = (file?.ext || file?.path?.split('.').pop() || '').replace('.', '').toLowerCase();
  const m = file?.metadata || {};
  const bits = m.bitsPerSample || m.bit_depth || 0;
  const rate = m.sampleRate || 0;
  const EXT = ext.toUpperCase() || '?';

  if (DSD_EXT.has(ext)) {
    const mult = rate ? Math.round(rate / 44100) : 64;
    return { label: `DSD${mult}`, tier: 'hires', lossless: true, ext: EXT, bits: 1, rate };
  }
  // ALAC usually lives in .m4a; AAC in .m4a reports no bit depth
  const lossless = LOSSLESS_EXT.has(ext) || (ext === 'm4a' && bits > 0);
  if (lossless) {
    const fmt = ext === 'm4a' ? 'ALAC' : EXT;
    const spec = bits && rate ? `${bits}/${khz(rate)}` : rate ? khz(rate) : '';
    const hires = bits > 16 || rate > 48000;
    return { label: `${fmt}${spec ? ' ' + spec : ''}`, tier: hires ? 'hires' : 'lossless', lossless: true, ext: fmt, bits, rate };
  }
  const kbps = m.bitrate ? Math.round(m.bitrate / 1000) : 0;
  return { label: `${EXT}${kbps ? ' ' + kbps : ''}`, tier: 'lossy', lossless: false, ext: EXT, bits, rate };
};

/** Where a track lives: any of 'local', 'cloud', 'cached'. */
export const storageOf = (file) => {
  const type = file?.storage_type || 'local';
  const out = [];
  if (type === 'local' || type === 'both') out.push('local');
  if (type === 'cloud' || type === 'both' || file?.telegram_message_id) out.push('cloud');
  if (file?.cache_path && type === 'cloud') out.push('cached');
  return out;
};

export const matchesSource = (file, source) => {
  if (source === 'all') return true;
  const s = storageOf(file);
  return source === 'local' ? s.includes('local') : s.includes('cloud');
};

/**
 * Build the signal path shown in the player and right panel.
 * Bit-perfect needs: lossless source, exclusive device, no DSP, no resampling cap below the
 * source, and software volume at 100%.
 */
export const computeSignalPath = ({ file, selectedDevice, devices = [], eqEnabled, volume, audioSettings = {}, audioOut = null, stream = null, dsd = null, output = null }) => {
  const q = qualityOf(file);
  const exclusive = selectedDevice && selectedDevice !== '-1';
  const chosen = exclusive ? devices.find(d => d.id === selectedDevice) : null;
  // "System default" names the device Windows really uses, when it could be found
  const deviceName = exclusive ? (chosen?.name || 'Output device') : output?.name ? `System default: ${output.name}` : 'System default';
  const bluetooth = exclusive ? !!chosen?.bluetooth : !!output?.bluetooth;
  const rg = audioSettings.replayGain && audioSettings.replayGain !== 'no';
  const crossfade = audioSettings.crossfade > 0;
  const capRate = audioSettings.maxSampleRate ? audioSettings.maxSampleRate * 1000 : 0;
  const capBits = audioSettings.maxBitDepth || 0;
  const volFull = exclusive || volume >= 100;

  // Prefer what mpv actually sends to the device; fall back to what the settings imply
  let outRate, outBits, resampled;
  if (audioOut && audioOut.samplerate) {
    outRate = audioOut.samplerate;
    const fmt = String(audioOut.format).replace(/p$/, '');
    outBits = { s16: 16, s24: 24, s32: 32, float: 32, double: 64, u8: 8 }[fmt] || q.bits;
    // 24-bit PCM travels in 32-bit words; untouched it is still 24-bit audio
    if (fmt === 's32' && q.bits > 1 && q.bits <= 24 && !eqEnabled && !rg) outBits = q.bits;
    resampled = !q.ext.startsWith('DSD') && q.rate > 0 && (outRate !== q.rate || (!!capBits && q.bits > capBits && outBits < q.bits));
  } else {
    resampled = (capRate && q.rate > capRate) || (capBits && q.bits > capBits);
    outRate = resampled && capRate ? Math.min(q.rate, capRate) : q.rate;
    outBits = resampled && capBits ? Math.min(q.bits, capBits) : q.bits;
  }
  const floatOut = audioOut && /^(float|double)/.test(String(audioOut.format));
  // say why the rate or depth changed: Windows' mixer, the output limit, or a device that can't take it
  const resampleWhy = () => {
    if (!exclusive) return `Resampling · Windows mixes everything in shared mode at the device's ${outBits && outRate ? `${outBits}-bit ${khz(outRate)} kHz` : 'own format'}`;
    if ((capRate && q.rate > capRate) || (capBits && q.bits > capBits)) return 'Resampling · your output limit';
    return 'Resampling · the device doesn\'t take this format';
  };
  const isDsd = q.label.startsWith('DSD');
  const dop = isDsd && dsd?.mode === 'dop';
  const nativeDsd = isDsd && dsd?.mode === 'native';
  const outSpec = nativeDsd ? q.label : isDsd && !audioOut ? 'PCM'
    : (outBits && outRate ? `${floatOut ? 'f32' : outBits}/${khz(outRate)}` : '');

  const steps = [
    { label: `${q.ext}${file?.metadata?.bitrate ? ` · ${Math.round(file.metadata.bitrate / 1000)} kbps` : ''}`, value: q.label.replace(q.ext, '').trim() || '—', state: q.lossless ? 'ok' : 'warn' },
    // streaming hands mpv the original bytes, so it doesn't change the samples
    ...(stream ? [{ label: stream.complete ? 'TeleCloud cache' : 'TeleCloud stream', value: stream.complete ? 'On disk' : stream.speed ? `${(stream.speed / 1048576).toFixed(1)} MB/s` : 'Buffering…', state: 'ok' }] : []),
    { label: 'Parametric EQ', value: eqEnabled ? 'On' : 'Off', state: eqEnabled ? 'warn' : 'off', key: 'eq' },
    { label: 'ReplayGain', value: !rg ? 'Off' : audioSettings.replayGain === 'auto' ? `Auto · ${audioSettings.autoGain || 'track'}` : audioSettings.replayGain, state: rg ? 'warn' : 'off' },
    ...(crossfade ? [{ label: 'Crossfade', value: `${audioSettings.crossfade}s`, state: 'warn' }] : []),
    ...(nativeDsd ? [{ label: 'Native DSD through ASIO', value: `${(dsd.rate / 1e6).toFixed(4)} MHz`, state: 'ok' }]
      : dop ? [{ label: dsd?.nativeWhy ? `DSD over PCM (DoP) · native not used: ${dsd.nativeWhy}` : 'DSD over PCM (DoP)', value: `${q.label} in ${khz(dsd.rate)}`, state: 'ok' }]
      : isDsd ? [{ label: [dsd?.nativeWhy && `native not used: ${dsd.nativeWhy}`, dsd?.reason].filter(Boolean).length ? `DSD to PCM · ${[dsd?.nativeWhy && `native not used: ${dsd.nativeWhy}`, dsd?.reason].filter(Boolean).join(' · ')}` : 'DSD to PCM', value: outSpec || 'PCM', state: 'warn' }]
        : resampled ? [{ label: resampleWhy(), value: outSpec, state: 'warn' }] : []),
    { label: 'Software volume', value: exclusive || nativeDsd ? 'Bypassed' : `${volume}%`, state: volFull || nativeDsd ? 'ok' : 'warn' },
    // Bluetooth sends no PCM: the headphones' codec (SBC, AAC, aptX, LDAC) compresses it again
    ...(bluetooth && !nativeDsd ? [{ label: 'Bluetooth · compressed again by the headphones\' codec', value: 'Lossy', state: 'warn' }] : []),
    nativeDsd ? { label: `${dsd.driver} · ASIO`, value: q.label, state: 'ok' }
      : { label: `${deviceName}${exclusive ? ' · WASAPI Exclusive' : ' · Shared'}`, value: outSpec, state: exclusive ? 'ok' : 'warn' },
  ];

  // DSD is turned into PCM before it leaves the app, so it is never the original bits
  const bitPerfect = !!file && nativeDsd && !eqEnabled ? true : !!file && !bluetooth && (!isDsd || dop) && q.lossless && exclusive && !eqEnabled && !rg && !crossfade && !resampled && volFull;
  let verdict = 'Idle';
  if (file) {
    if (bitPerfect) verdict = 'Bit-perfect';
    else if (!q.lossless) verdict = 'Lossy source';
    else if (bluetooth) verdict = 'Bluetooth';
    else if (!exclusive) verdict = 'Shared mode';
    else verdict = 'Processed';
  }
  return { steps, bitPerfect, verdict, quality: q, deviceName, exclusive, outSpec, bluetooth };
};

// ---- Duplicate tracks: the same album in two folders must not play or list every song twice

const dupKey = (f) => {
  const m = f?.metadata || {};
  return [m.title || f?.name || '', m.album || '', m.disc || 1, m.track || 0].join('\u0000').toLowerCase();
};
// which copy to keep: a file on this computer, then the better quality
const copyRank = (f) => {
  const q = qualityOf(f);
  const local = (f.storage_type || 'local') !== 'cloud' && !f.path?.startsWith('tc://');
  return (local ? 4e9 : 0) + (q.tier === 'hires' ? 2e9 : q.tier === 'lossless' ? 1e9 : 0) + (q.bits || 0) * 1e6 + (q.rate || 0) + (f.metadata?.bitrate || 0) / 1e3;
};

/**
 * Finds extra copies: same title, album, disc and track number, and a length within 2 s.
 * Returns path of each extra copy → the copy that is kept. `prefer` wins (the track you clicked).
 */
export function findDuplicates(files, prefer) {
  const groups = new Map();
  for (const f of files) {
    if (!f?.path) continue;
    const k = dupKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const extra = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => (b.path === prefer) - (a.path === prefer) || copyRank(b) - copyRank(a));
    const kept = [];
    for (const f of ranked) {
      const twin = kept.find(k => Math.abs((k.metadata?.duration || 0) - (f.metadata?.duration || 0)) <= 2);
      if (twin) extra.set(f.path, twin.path); else kept.push(f);
    }
  }
  return extra;
}

/** The list without extra copies, order kept */
export function dedupeTracks(files, prefer) {
  const extra = findDuplicates(files, prefer);
  return extra.size ? files.filter(f => !extra.has(f.path)) : files;
}

/** Album order: disc, then track number, then name (a missing disc number counts as disc 1) */
export const sortAlbumTracks = (songs) => [...songs].sort((a, b) => {
  const da = a.metadata?.disc || 1, db = b.metadata?.disc || 1;
  if (da !== db) return da - db;
  const ta = a.metadata?.track || 0, tb = b.metadata?.track || 0;
  return ta !== tb ? ta - tb : (a.name || '').localeCompare(b.name || '');
});
