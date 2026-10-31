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

export const coverUrl = (file) => (file?.path ? `media://${encodeURIComponent(file.path)}` : file?.cover || null);

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
export const computeSignalPath = ({ file, selectedDevice, devices = [], eqEnabled, volume, audioSettings = {}, audioOut = null, stream = null }) => {
  const q = qualityOf(file);
  const exclusive = selectedDevice && selectedDevice !== '-1';
  const deviceName = exclusive ? (devices.find(d => d.id === selectedDevice)?.name || 'Output device') : 'System default';
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
    if (fmt === 's32' && q.bits && q.bits <= 24 && !eqEnabled && !rg) outBits = q.bits;
    resampled = !q.ext.startsWith('DSD') && q.rate > 0 && (outRate !== q.rate || (!!capBits && q.bits > capBits && outBits < q.bits));
  } else {
    resampled = (capRate && q.rate > capRate) || (capBits && q.bits > capBits);
    outRate = resampled && capRate ? Math.min(q.rate, capRate) : q.rate;
    outBits = resampled && capBits ? Math.min(q.bits, capBits) : q.bits;
  }
  const floatOut = audioOut && /^(float|double)/.test(String(audioOut.format));
  const outSpec = q.ext.startsWith('DSD') && !audioOut ? 'DoP / PCM'
    : (outBits && outRate ? `${floatOut ? 'f32' : outBits}/${khz(outRate)}` : '');

  const steps = [
    { label: `${q.ext}${file?.metadata?.bitrate ? ` · ${Math.round(file.metadata.bitrate / 1000)} kbps` : ''}`, value: q.label.replace(q.ext, '').trim() || '—', state: q.lossless ? 'ok' : 'warn' },
    // streaming hands mpv the original bytes, so it doesn't change the samples
    ...(stream ? [{ label: stream.complete ? 'TeleCloud cache' : 'TeleCloud stream', value: stream.complete ? 'On disk' : stream.speed ? `${(stream.speed / 1048576).toFixed(1)} MB/s` : 'Buffering…', state: 'ok' }] : []),
    { label: 'Parametric EQ', value: eqEnabled ? 'On' : 'Off', state: eqEnabled ? 'warn' : 'off', key: 'eq' },
    { label: 'ReplayGain', value: rg ? audioSettings.replayGain : 'Off', state: rg ? 'warn' : 'off' },
    ...(crossfade ? [{ label: 'Crossfade', value: `${audioSettings.crossfade}s`, state: 'warn' }] : []),
    ...(resampled ? [{ label: 'Resampling', value: outSpec, state: 'warn' }] : []),
    { label: 'Software volume', value: exclusive ? 'Bypassed' : `${volume}%`, state: volFull ? 'ok' : 'warn' },
    { label: `${deviceName}${exclusive ? ' · WASAPI Exclusive' : ' · Shared'}`, value: outSpec, state: exclusive ? 'ok' : 'warn' },
  ];

  const bitPerfect = !!file && q.lossless && exclusive && !eqEnabled && !rg && !crossfade && !resampled && volFull;
  let verdict = 'Idle';
  if (file) {
    if (bitPerfect) verdict = 'Bit-perfect';
    else if (!q.lossless) verdict = 'Lossy source';
    else if (!exclusive) verdict = 'Shared mode';
    else verdict = 'Processed';
  }
  return { steps, bitPerfect, verdict, quality: q, deviceName, exclusive, outSpec };
};
