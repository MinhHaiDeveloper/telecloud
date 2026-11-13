// Settings > Sound: tone, space, effects, room or headphone correction, A/B and the clip meter.
// Pure functions: the renderer's settings are checked here and turned into mpv filters built from
// numbers only, never from a raw string out of the renderer. player.js puts them in its chain.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, lo, hi, def = 0) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : def);
const round = (v, step) => Math.round(v / step) * step;

// Night mode: quiet passages come up, loud ones go down (a compressor; levels measured on pink noise)
const NIGHT = {
  light: 'acompressor=threshold=0.063:ratio=2:attack=15:release=300:knee=4:makeup=1.6',
  strong: 'acompressor=threshold=0.032:ratio=4:attack=10:release=250:knee=4:makeup=2.5',
};
const CHANNELS = ['normal', 'mono', 'swap'];
const POLARITY = ['normal', 'left', 'right', 'both'];

/** The renderer's sound settings, checked; null when nothing changes the sound */
function normalizeSound(s) {
  if (!s || typeof s !== 'object') return null;
  const ir = Array.isArray(s.ir?.points)
    ? s.ir.points.slice(0, 400)
      .map(p => [Number(p?.[0]), Number(p?.[1])])
      .filter(([f, g]) => Number.isFinite(f) && Number.isFinite(g) && f > 0 && f <= 96000)
      .map(([f, g]) => [Number(f.toFixed(1)), Number(clamp(g, -30, 30).toFixed(2))])
    : [];
  return {
    warmth: round(num(s.warmth, -6, 6), 0.5),
    bass: round(num(s.bass, -12, 12), 0.5),
    treble: round(num(s.treble, -12, 12), 0.5),
    loudness: !!s.loudness,
    width: Math.round(num(s.width, 0, 200, 100)),
    channels: CHANNELS.includes(s.channels) ? s.channels : 'normal',
    polarity: POLARITY.includes(s.polarity) ? s.polarity : 'normal',
    night: NIGHT[s.night] ? s.night : 'off',
    air: Math.round(num(s.air, 0, 100)),
    tube: Math.round(num(s.tube, 0, 100)),
    ir: ir.length >= 2 ? ir : null,
    guard: Number(num(s.guard, -30, 0).toFixed(1)), // dB taken off so the boosts can't clip
    bypass: s.bypass ? { gain: Number(num(s.bypass.gain, -30, 30).toFixed(2)) } : null,
  };
}

/** Software volume in dB (mpv's volume is cubic): the loudness boost follows it */
const volumeDb = (vol) => (vol > 0 ? 60 * Math.log10(Math.min(100, vol) / 100) : -120);

/**
 * Loudness: at low volume the ear hears less bass and a little less treble (equal-loudness
 * curves, ISO 226), so they come up as the volume goes down. Nothing at full volume.
 */
function loudnessGains(vol) {
  const down = Math.max(0, -volumeDb(vol));
  return { bass: Number(Math.min(12, down * 0.35).toFixed(2)), treble: Number(Math.min(4, down * 0.1).toFixed(2)) };
}

/** Left/right matrix for mono, swap and polarity, as pan coefficients */
function channelMatrix(n) {
  let l = [1, 0], r = [0, 1]; // output = a*in.L + b*in.R
  if (n.channels === 'mono') { l = [0.5, 0.5]; r = [0.5, 0.5]; }
  if (n.channels === 'swap') { l = [0, 1]; r = [1, 0]; }
  if (n.polarity === 'left' || n.polarity === 'both') l = l.map(x => -x);
  if (n.polarity === 'right' || n.polarity === 'both') r = r.map(x => -x);
  const term = (a, b) => [a ? `${a}*c0` : '', b ? `${b}*c1` : ''].filter(Boolean).join('+').replace(/\+-/g, '-');
  return `pan=stereo|c0=${term(...l)}|c1=${term(...r)}`;
}

/** Room or headphone correction: the measured curve as a linear-phase FIR */
function correctionFilter(points) {
  const entries = points.map(([f, g]) => `entry(${f},${g})`).join(';');
  return `firequalizer=gain='cubic_interpolate(f)':gain_entry='${entries}':delay=0.02:accuracy=4:zero_phase=on`;
}

/** Does this change the samples (so playback isn't bit-perfect)? `exclusive` keeps the volume at 100 */
function soundActive(n, { exclusive = false } = {}) {
  if (!n) return false;
  if (n.bypass) return n.bypass.gain !== 0;
  return !!(n.warmth || n.bass || n.treble || (n.loudness && !exclusive) || n.width !== 100 || n.channels !== 'normal'
    || n.polarity !== 'normal' || n.night !== 'off' || n.air || n.tube || n.ir || n.guard);
}

/** What is on, in a few words, for the signal path */
function soundSummary(n, opts) {
  if (!soundActive(n, opts)) return [];
  if (n.bypass) return ['A/B: original'];
  const out = [];
  if (n.warmth) out.push(n.warmth > 0 ? `Warm +${n.warmth}` : `Bright +${-n.warmth}`);
  if (n.bass) out.push(`Bass ${n.bass > 0 ? '+' : ''}${n.bass}`);
  if (n.treble) out.push(`Treble ${n.treble > 0 ? '+' : ''}${n.treble}`);
  if (n.loudness && !opts?.exclusive) out.push('Loudness');
  if (n.ir) out.push('Correction');
  if (n.width !== 100) out.push(n.width === 0 ? 'Width 0%' : `Width ${n.width}%`);
  if (n.channels !== 'normal') out.push(n.channels === 'mono' ? 'Mono' : 'L/R swapped');
  if (n.polarity !== 'normal') out.push(`Polarity ${n.polarity === 'both' ? 'inverted' : `${n.polarity} inverted`}`);
  if (n.night !== 'off') out.push(`Night ${n.night}`);
  if (n.air) out.push(`Air ${n.air}%`);
  if (n.tube) out.push(`Tube ${n.tube}%`);
  if (n.guard) out.push(`Headroom ${n.guard} dB`);
  return out;
}

/**
 * The sound's part of the chain, in two pieces around the EQ: `pre` goes before it (headroom),
 * `post` after it. Each filter whose value can move while you drag has its own label, so the drag
 * is sent as af-command instead of a rebuild (which would click). `live` holds those values.
 */
function soundFilters(n, { volume = 100, exclusive = false } = {}) {
  const pre = [];
  const post = [];
  const live = {};
  if (!soundActive(n, { exclusive })) return { pre, post, live, key: '' };
  if (n.bypass) {
    // the original, as loud as the processed sound so the louder one doesn't win by being louder
    post.push(`@ab:lavfi=[volume=volume=${n.bypass.gain}dB]`);
    live.ab = { filter: 'volume', param: 'volume', value: `${n.bypass.gain}dB` };
    return { pre, post, live, key: 'ab' };
  }
  if (n.guard) { pre.push(`@guard:lavfi=[volume=volume=${n.guard}dB]`); live.guard = { filter: 'volume', param: 'volume', value: `${n.guard}dB` }; }
  // tone
  if (n.warmth) { post.push(`@warm:lavfi=[tiltshelf=f=1000:g=${n.warmth}]`); live.warm = { filter: 'tiltshelf', param: 'g', value: String(n.warmth) }; }
  if (n.bass) { post.push(`@bass:lavfi=[bass=f=100:w=0.7:g=${n.bass}]`); live.bass = { filter: 'bass', param: 'g', value: String(n.bass) }; }
  if (n.treble) { post.push(`@treb:lavfi=[treble=f=8000:w=0.7:g=${n.treble}]`); live.treb = { filter: 'treble', param: 'g', value: String(n.treble) }; }
  if (n.loudness && !exclusive) {
    const g = loudnessGains(volume);
    post.push(`@loudb:lavfi=[bass=f=70:w=0.6:g=${g.bass}]`, `@loudt:lavfi=[treble=f=10000:w=0.6:g=${g.treble}]`);
    live.loudb = { filter: 'bass', param: 'g', value: String(g.bass) };
    live.loudt = { filter: 'treble', param: 'g', value: String(g.treble) };
  }
  if (n.ir) post.push(`@corr:lavfi=[${correctionFilter(n.ir)}]`);
  // effects
  if (n.tube) post.push(`@tube:lavfi=[aeval=val(ch)+${(n.tube / 250).toFixed(3)}*val(ch)*val(ch):c=same,highpass=f=8]`);
  if (n.air) { post.push(`@air:lavfi=[aexciter=amount=${(n.air / 100).toFixed(2)}:drive=8.5:blend=0:freq=6000]`); live.air = { filter: 'aexciter', param: 'amount', value: (n.air / 100).toFixed(2) }; }
  if (n.night !== 'off') post.push(`@night:lavfi=[${NIGHT[n.night]}]`);
  // space: two channels from here on
  const stereo = n.width !== 100 || n.channels !== 'normal' || n.polarity !== 'normal';
  if (stereo) post.push('@sstereo:lavfi=[aformat=channel_layouts=stereo]');
  if (n.channels !== 'normal' || n.polarity !== 'normal') post.push(`@chan:lavfi=[${channelMatrix(n)}]`);
  if (n.width !== 100) {
    const m = (n.width / 100).toFixed(2);
    post.push(`@width:lavfi=[extrastereo=m=${m}:c=false]`);
    live.width = { filter: 'extrastereo', param: 'm', value: m };
  }
  // the structure: anything else is a rebuild
  const key = JSON.stringify([!!n.guard, !!n.warmth, !!n.bass, !!n.treble, n.loudness && !exclusive, n.ir, n.tube, !!n.air, n.night, stereo, n.channels, n.polarity, n.width !== 100]);
  return { pre, post, live, key };
}

/** Float from here on, so a boost above 0 dBFS is kept (and can be seen) instead of clipping inside a filter */
const FLOAT = '@float:lavfi=[aformat=sample_fmts=fltp|flt|dblp|dbl]';
/** The peak after everything: read a few times a second for the clip light */
const METER = '@meter:lavfi=[astats=metadata=1:reset=4:measure_perchannel=none:measure_overall=Peak_level]';
const METER_KEY = 'lavfi.astats.Overall.Peak_level';

/**
 * Is it clipping? The chain runs in float, so a sample above 0 dBFS only clips where it turns
 * into the device's format, after the software volume: in shared mode the volume gives room.
 */
function clips(peakDb, { volume = 100, exclusive = false } = {}) {
  if (!Number.isFinite(peakDb)) return false;
  const room = exclusive ? 0 : Math.max(0, -volumeDb(volume));
  return peakDb > room + 0.05;
}

module.exports = { normalizeSound, soundFilters, soundActive, soundSummary, loudnessGains, channelMatrix, correctionFilter, clips, volumeDb, FLOAT, METER, METER_KEY, NIGHT };
