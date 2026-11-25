import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Dialog, Progress, Segmented } from './ui';
import Icon from './Icon';
import { formatTime, qualityOf } from '../utils/audio';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

// Quality check, in two tabs. Fidelity: is this file what it says it is? electron/spectrumCore.js measures and judges
// (ids and numbers only); this window words it, shows the evidence one line each, the spectrogram and the average
// spectrum. Mastering: how loud, how compressed, how much headroom: about the song's master, not the file.

// Perceptual "inferno"-like colormap: black → purple → red → orange → pale yellow
const STOPS = [
  [0, [0, 0, 4]], [0.15, [31, 12, 72]], [0.3, [85, 15, 109]], [0.45, [136, 34, 106]],
  [0.6, [186, 54, 85]], [0.72, [227, 89, 51]], [0.84, [249, 140, 10]], [0.93, [249, 201, 50]], [1, [252, 255, 164]],
];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && x > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1];
    const f = (x - t0) / (t1 - t0 || 1);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return lut;
})();
const GRADIENT = `linear-gradient(to top, ${STOPS.map(([x, c]) => `rgb(${c.join(',')}) ${x * 100}%`).join(', ')})`;

const TONE = { ok: 'ok', warn: 'warn', bad: 'danger', info: 'info' };
const STATUS_ICON = { good: 'check', bad: 'alert', warn: 'alert', neutral: 'info', na: 'info' };
const khz = (hz) => `${(hz / 1000).toFixed(1)} kHz`;
const pct = (x) => `${Math.round((x || 0) * 100)}%`;

/** The verdict in words */
function verdictText(v, r) {
  const p = v.params || {};
  switch (v.id) {
    case 'genuine': return [t('Looks genuinely lossless'), t('Content reaches {hz} (the limit at this sample rate is {limit}), and none of the signs of lossy encoding showed up.', { hz: khz(p.hz), limit: khz(p.nyquist) })];
    case 'genuine-padded': return [t('Lossless, but padded to {declared}-bit', { declared: r.declaredBits }), t('Full bandwidth with no sign of lossy encoding, but only {bits} bits carry data: it is {bits}-bit audio in a bigger container.', { bits: p.bits })];
    case 'rolloff': return [t('Probably lossless, with a natural roll-off'), t('The highs fade out around {hz} instead of stopping at a wall, and no sign of lossy encoding showed up. Common for older recordings, acoustic music and gentle masters.', { hz: khz(p.hz) }) + (p.padded ? ` ${t('Only {bits} bits carry data, though.', { bits: p.bits })}` : '')];
    case 'transcoded': return [t('Likely transcoded from a lossy file'), t('A brick-wall cutoff at {hz}, the mark of a {kbps} kbps MP3 or AAC encoder. Lossless audio usually goes on to about {limit}.', { hz: khz(p.hz), kbps: p.kbps, limit: khz(r.sampleRate / 2 * 0.95) })];
    case 'upsampled': return [t('Upsampled from {from} kHz', { from: p.from }), t('The file is {rate} kHz, but the music stops at an edge near {hz}: it was made at {from} kHz and converted up. It sounds the same as that original; it is just bigger.', { rate: (p.rate / 1000).toFixed(1), hz: khz(p.hz), from: p.from })];
    case 'upsampled-lossy': return [t('Upsampled from a lossy source'), t('The music stops at {hz} with the marks of lossy encoding, and the file was then converted up to {rate} kHz.', { hz: khz(p.hz), rate: (p.rate / 1000).toFixed(1) })];
    case 'lossy-format': return [t('Lossy by design'), t('This is a lossy format, so it is expected to stop early. It stops around {hz}, about what a {kbps} kbps encoder keeps.', { hz: khz(p.hz), kbps: p.kbps })];
    default: return [t('Inconclusive'), p.reason === 'quiet'
      ? t('There is too little signal in this file to judge it.')
      : t('The content reaches {hz} with no wall, which points to lossless, but some signs of lossy encoding showed up (below). A high-bitrate AAC or a carefully made transcode can look like this.', { hz: khz(p.hz) })];
  }
}

/** One piece of evidence: its name, what was measured, what it says here, and why it matters */
function evidenceText(e) {
  const p = e.params || {};
  switch (e.id) {
    case 'cutoff': return {
      label: t('Where the music stops'),
      value: `${khz(p.hz)} · ${p.sharp ? t('sharp') : t('gradual')}`,
      says: e.status === 'bad' ? (p.kbps ? t('A brick wall, as a {kbps} kbps encoder leaves.', { kbps: p.kbps }) : t('A wall at the limit of a lower-rate original.')) : e.status === 'good' ? t('It reaches the top of the range.') : p.kbps ? t('About what a {kbps} kbps encoder keeps.', { kbps: p.kbps }) : t('It fades out gradually.'),
      why: t('Lossy encoders throw away the highest frequencies first, with a filter that stops like a wall (about 16 kHz at 128 kbps, 19 kHz at 192, 20 kHz at 320). Real recordings either reach the top of the range or fade out slowly.'),
    };
    case 'upsample': return {
      label: t('Made at this sample rate'),
      value: e.status === 'bad' ? t('Edge at {hz}, {drop} dB', { hz: khz(p.hz), drop: Math.round(p.drop) }) : t('No edge at 22 or 24 kHz'),
      says: e.status === 'bad' ? t('The music stops where a {from} kHz file would.', { from: p.from }) : t('Content carries on past the CD range as it should.'),
      why: t('A file converted up from 44.1 or 48 kHz keeps the old limit: the level falls away at about 20 to 24 kHz and stays down. A real high-resolution recording fades out gradually instead.'),
    };
    case 'holes': return {
      label: t('Spectral holes'),
      value: e.status === 'na' ? '—' : t('{value} of loud moments', { value: pct(p.ratio) }),
      says: { bad: t('Bands drop out while the music is loud: an encoder running out of bits.'), warn: t('A few bands drop out now and then.'), good: t('The highs stay filled in.'), neutral: t('Expected in a lossy file.'), na: t('Too little high content to tell.') }[e.status],
      why: t('When a lossy encoder is short of bits it drops whole bands for a moment, which shows as dark gaps in the picture (marked on the strip under it). A real recording keeps at least its noise there.'),
    };
    case 'monoHighs': return {
      label: t('Stereo in the highs'),
      value: e.status === 'na' ? '—' : t('{value} mono above 12 kHz', { value: pct(p.fraction) }),
      says: { bad: t('The highs fall to mono, a trick encoders use to save bits.'), warn: t('The highs are often mono.'), good: t('Left and right stay apart up to the top.'), neutral: t('Expected in a lossy file.'), na: p.monoRecording ? t('A mono recording: nothing to compare.') : t('Too little high content to tell.') }[e.status],
      why: t('Encoders save bits by sending what left and right share and little of how they differ, least of all in the highs. Above 12 kHz the side (left minus right) then vanishes while the mid goes on. The second graph shows both.'),
    };
    case 'bits': return {
      label: t('Bit depth'),
      value: p.effective && p.declared ? t('{effective} of {declared} bits used', { effective: p.effective, declared: p.declared }) : '—',
      says: { bad: t('Padded with zeros: it is {effective}-bit audio.', { effective: p.effective }), good: t('Every declared bit carries data.'), na: t('Not measured.') }[e.status],
      why: t('A 24-bit file made from 16-bit audio has eight bits that are always zero. The first minute of samples is read to see how many bits ever change.'),
    };
    case 'clipping': return {
      label: t('Clipping'),
      value: p.count ? t('{n|# sample|# samples} at full scale · peak {peak} dBFS', { n: p.count, peak: p.peakDb }) : t('None · peak {peak} dBFS', { peak: p.peakDb }),
      says: p.count ? t('Peaks hit the ceiling: a loud master, or a lossy file decoded over 0 dBFS.') : t('Peaks stay below the ceiling.'),
      why: t('Two or more samples in a row at full scale mean the waveform was cut flat. It says nothing about lossless on its own, but transcodes often show it, because decoding a lossy file can go over 0 dBFS.'),
    };
    case 'dr': return {
      label: t('Dynamic range'),
      value: `DR${p.dr}`,
      says: p.dr >= 12 ? t('Plenty of room between quiet and loud.') : p.dr >= 8 ? t('Typical for modern releases.') : t('Heavily compressed, as much loud pop and EDM is.'),
      why: t('Measured as DR meters do: the peaks against the loudest fifth of the track. It is about the mastering, not about lossless, and the same song can differ from one release to another.'),
    };
    default: return { label: e.id, value: '', says: '', why: '' };
  }
}

const EvidenceRow = ({ e, x = evidenceText(e) }) => {
  return (
    <details className={`qc-row ${e.status}`}>
      <summary>
        <span className="qc-dot"><Icon name={STATUS_ICON[e.status] || 'info'} /></span>
        <span className="qc-label">{x.label}</span>
        <span className="qc-value mono">{x.value}</span>
        <span className="qc-says">{x.says}</span>
      </summary>
      {x.why && <p className="qc-why">{x.why}</p>}
    </details>
  );
};

// ---------- Mastering

const num = (x, d = 1) => (x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d).replace('-', '−'));
const db1 = (x) => (x == null ? '—' : x.toFixed(1).replace('-', '−'));
const MASTERING_IDS = new Set(['clipping', 'dr']); // judge() lists them; they show on the Mastering tab

/** The master in one line, from the numbers only: there is no score */
function masteringVerdict(m, dr) {
  const hot = m.truePeakDb > 0 || m.clipEvents > 0;
  const p = { dr, lufs: db1(m.lufs), tp: num(m.truePeakDb) };
  const though = hot ? ` ${t('The peaks reach {tp} dBTP, though.', p)}` : '';
  if (dr != null && dr < 8 && hot) return { level: 'warn', title: t('Loud master with no headroom'), text: t('Pushed hard: DR{dr} at {lufs} LUFS, and the peaks reach {tp} dBTP. Common in loud genres, but there is no headroom left.', p) };
  if (dr != null && dr < 8) return { level: 'info', title: t('Loud, compressed master'), text: t('DR{dr} at {lufs} LUFS: little difference between quiet and loud, as in much modern pop, rock and EDM.', p) };
  if (dr != null && dr < 12) return { level: 'info', title: t('Typical modern master'), text: t('DR{dr} at {lufs} LUFS: some room between quiet and loud.', p) + though };
  return { level: hot ? 'warn' : 'ok', title: t('Dynamic master'), text: t('DR{dr} at {lufs} LUFS: plenty of room between quiet and loud.', p) + though };
}

/** The mastering numbers as rows like the evidence: label, value, what it says here, why it matters */
function masteringRows(m, r) {
  const ev = (id) => r.verdict?.evidence?.find(e => e.id === id)?.params;
  const dr = ev('dr')?.dr ?? r.dr;
  const clip = ev('clipping') || { count: r.clipped, peakDb: r.peakDb };
  const rows = [];
  if (m.lufs != null) {
    rows.push({
      id: 'loudness', status: m.lufs > -9 ? 'warn' : m.lufs < -16 ? 'good' : 'neutral',
      label: t('Loudness'), value: `${db1(m.lufs)} LUFS · LRA ${m.lra == null ? '—' : m.lra.toFixed(1)} LU`,
      says: m.lufs > -9 ? t('Very loud: services that play at −14 LUFS turn it down by about {db} dB.', { db: (m.lufs + 14).toFixed(0) })
        : m.lufs < -16 ? t('Quiet enough to keep headroom; services may turn it up.') : t('About as loud as most current releases.'),
      why: t('Loudness as EBU R128 measures it: the level weighted for how the ear hears (K-weighting), leaving out silence and quiet passages. LRA (loudness range) is how much that level moves between the quieter and louder parts. Streaming services play everything at about −14 LUFS, so a louder master gains nothing there and keeps its squashed dynamics.'),
    });
  }
  if (m.truePeakDb != null) {
    rows.push({
      id: 'truePeak', status: m.truePeakDb > 0 ? 'bad' : m.truePeakDb > -1 ? 'warn' : 'good',
      label: t('True peak'), value: m.overs ? t('{tp} dBTP · {n} overs', { tp: num(m.truePeakDb, 2), n: m.overs.toLocaleString() }) : `${num(m.truePeakDb, 2)} dBTP`,
      says: m.truePeakDb > 0 ? t('Goes over 0 dB between the samples: a DAC or a lossy encoder can clip it.') : m.truePeakDb > -1 ? t('Under 0 dB, but with less than 1 dB of room.') : t('Room left under 0 dB.'),
      why: t('The samples are only points on the wave; the wave a DAC rebuilds between them can rise higher. True peak looks between the samples, at four times the sample rate as BS.1770 asks. Overs are the places where it goes over 0 dB between two samples that do not. Mastering guides ask for −1 dBTP or lower.'),
    });
  }
  if (dr != null) {
    rows.push({
      id: 'dr', status: dr >= 12 ? 'good' : dr >= 8 ? 'neutral' : 'warn',
      label: t('Dynamic range'), value: m.drL != null && m.drR != null ? `DR${dr} · L ${m.drL.toFixed(1)} · R ${m.drR.toFixed(1)}` : `DR${dr}`,
      says: dr >= 12 ? t('Plenty of room between quiet and loud.') : dr >= 8 ? t('Typical for modern releases.') : t('Heavily compressed, as much loud pop and EDM is.'),
      why: t('Measured as DR meters do: the peaks against the loudest fifth of the track. It is about the mastering, not about lossless, and the same song can differ from one release to another.'),
    });
  }
  rows.push({
    id: 'clipping', status: m.clipEvents ? 'warn' : 'good', label: t('Clipping'),
    value: m.clipEvents ? t('{n|# time|# times} · {count} samples', { n: m.clipEvents, count: (clip.count || 0).toLocaleString() }) : t('None · peak {peak} dBFS', { peak: db1(clip.peakDb) }),
    says: m.clipEvents ? t('Peaks hit the ceiling: a loud master, or a lossy file decoded over 0 dBFS.') : t('Peaks stay below the ceiling.'),
    why: t('Two or more samples in a row at full scale mean the waveform was cut flat; each run counts as one time. It says nothing about lossless on its own, but transcodes often show it, because decoding a lossy file can go over 0 dBFS.'),
  });
  if (m.rmsL != null) {
    const diff = Math.abs(m.rmsL - (m.rmsR ?? m.rmsL));
    rows.push({
      id: 'rms', status: 'neutral', label: t('Average level (RMS)'), value: `L ${db1(m.rmsL)} · R ${db1(m.rmsR)} dB`,
      says: diff >= 1.5 ? t('One side is {db} dB louder than the other.', { db: diff.toFixed(1) }) : t('The two sides are balanced.'),
      why: t('The average power of each channel over the whole track, in dBFS (a full-scale sine wave is −3 dB). Loudness above is the better measure of how loud it sounds; this is here to compare with other tools and to see whether one side is louder.'),
    });
  }
  if (m.mono) rows.push({ id: 'stereo', status: 'na', label: t('Stereo'), value: '—', says: t('A mono file.'), why: '' });
  else if (m.correlation != null) {
    const c = m.correlation;
    rows.push({
      id: 'stereo', status: c >= 0.99 || (c >= -0.3 && c < 0.3) ? 'neutral' : c < -0.3 ? 'warn' : 'good', label: t('Stereo'), value: t('correlation {c}', { c: c.toFixed(2).replace('-', '−') }),
      says: c >= 0.99 ? t('Left and right are the same: mono in a stereo file.') : c < -0.3 ? t('Out of phase: it can thin out or cancel when played in mono.') : c < 0.3 ? t('Very wide stereo: some of it may thin out in mono.') : t('Healthy stereo that also works in mono.'),
      why: t('How alike left and right are over the whole track, from +1 (the same: mono) through 0 (unrelated) to −1 (one is the other upside down). Most music sits between 0.3 and 0.9; recordings made with mics far apart can sit near 0. Well below 0, parts of the music cancel out on a mono speaker or phone.'),
    });
  }
  return { rows, dr };
}

const Mastering = ({ result }) => {
  const { rows, dr } = masteringRows(result.mastering, result);
  const mv = masteringVerdict(result.mastering, dr);
  return (
    <>
      <div className={`qc-verdict ${TONE[mv.level] || 'info'}`}>
        <div className="qc-verdict-head">
          <Icon name={mv.level === 'ok' ? 'check' : mv.level === 'info' ? 'info' : 'alert'} />
          <b>{mv.title}</b>
        </div>
        <p>{mv.text}</p>
      </div>
      <div className="qc-evidence">{rows.map(x => <EvidenceRow key={x.id} e={x} x={x} />)}</div>
      <p className="qc-foot">{t('About the master, not the file: the same song can measure differently on another release.')}</p>
    </>
  );
};

/** While it analyses: the tab's own layout, with the progress where the summary will be, so nothing jumps */
const MasteringLoading = ({ progress, error }) => (
  <>
    <div className={`qc-verdict ${error ? 'danger' : 'info'}`}>
      <div className="qc-verdict-head">
        {error ? <Icon name="alert" /> : <span className="ring" />}
        <b>{error ? t('Could not analyse this file') : `${t('Decoding and analysing… {pct}', { pct: progress })}%`}</b>
      </div>
      {error ? <p>{error}</p> : <div className="qc-load-bar"><Progress value={progress} /></div>}
    </div>
    <div className="qc-evidence" aria-hidden="true">
      {[t('Loudness'), t('True peak'), t('Dynamic range'), t('Clipping'), t('Average level (RMS)'), t('Stereo')].map(label => (
        <div className="qc-row na qc-skel" key={label}>
          <div className="qc-sum">
            <span className="qc-dot"><Icon name="info" /></span>
            <span className="qc-label">{label}</span>
            <span className="qc-value"><i /></span>
            <span className="qc-says"><i /></span>
          </div>
        </div>
      ))}
    </div>
  </>
);

const MasteringHelp = () => (
  <div className="spec-help">
    <section>
      <b>{t('What it measures')}</b>
      <p>{t('How the song was mastered: how loud it is, how much its level moves, how close its peaks come to 0 dB and how wide its stereo is. The whole file is read; nothing is sampled.')}</p>
    </section>
    <section>
      <b>{t('Reading it')}</b>
      <p>{t('There is no score: a loud, compressed master is normal for some music and a fault in other music. The line at the top sums the numbers up; each row opens to say what it means.')}</p>
    </section>
    <section>
      <b>{t('Limits')}</b>
      <p>{t('It is about the master, not the file: a perfect lossless copy of a clipped master still clips. Files with more than two channels are measured from a stereo mix of them.')}</p>
    </section>
  </div>
);

/** Both tabs as plain text, to paste in a forum or a chat. The file's location stays out. */
function asText(file, q, result) {
  const m = file.metadata || {};
  const lines = [
    'TeleCloud Quality check',
    [m.title || file.name, m.artist, m.album].filter(Boolean).join(' · '),
    `${q.label}${m.bitrate ? ` · ${Math.round(m.bitrate / 1000)} kbps` : ''} · ${(result.sampleRate / 1000).toFixed(1)} kHz`,
  ];
  const row = (x) => `  ${x.label}: ${x.value}${x.says ? ` (${x.says})` : ''}`;
  const v = result.verdict;
  if (v) {
    const conf = { high: t('High confidence'), medium: t('Medium confidence'), low: t('Low confidence') }[v.confidence];
    lines.push('', `${t('Fidelity')}: ${verdictText(v, result)[0]} (${conf})`);
    v.evidence.filter(e => !MASTERING_IDS.has(e.id)).forEach(e => lines.push(row(evidenceText(e))));
  }
  if (result.mastering) {
    const { rows, dr } = masteringRows(result.mastering, result);
    lines.push('', `${t('Mastering')}: ${masteringVerdict(result.mastering, dr).title}`);
    rows.forEach(x => lines.push(row(x)));
  }
  return lines.join('\n');
}

/** The average spectrum, mid and side, on the same frequency axis as the spectrogram */
const AverageSpectrum = ({ result }) => {
  const { profile, profileSide, sampleRate, cutoffHz } = result;
  if (!profile?.length) return null;
  const W = 1000, H = 170, lo = -140, hi = 0;
  const nyq = sampleRate / 2;
  const path = (arr) => arr.map((db, i) => `${i ? 'L' : 'M'}${((i / (arr.length - 1)) * W).toFixed(1)},${(((hi - Math.max(lo, Math.min(hi, db))) / (hi - lo)) * H).toFixed(1)}`).join(' ');
  return (
    <div className="qc-avg">
      <div className="qc-avg-head">
        <b>{t('Average spectrum')}</b>
        <span className="lg mid">{t('Mid (left + right)')}</span>
        {profileSide?.length ? <span className="lg side">{t('Side (left − right)')}</span> : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t('Average level by frequency')}>
        {[-20, -40, -60, -80, -100, -120].map(db => <line key={db} x1="0" x2={W} y1={((hi - db) / (hi - lo)) * H} y2={((hi - db) / (hi - lo)) * H} className="grid" />)}
        {cutoffHz < nyq * 0.97 && <line x1={(cutoffHz / nyq) * W} x2={(cutoffHz / nyq) * W} y1="0" y2={H} className="cut" />}
        {profileSide?.length ? <path d={path(profileSide)} className="side" /> : null}
        <path d={path(profile)} className="mid" />
      </svg>
      <div className="qc-avg-axis mono"><span>0</span><span>{khz(nyq / 2)}</span><span>{khz(nyq)}</span></div>
    </div>
  );
};

// What the check does and how each verdict is reached (mirrors electron/spectrumCore.js)
const QualityHelp = () => (
  <div className="spec-help">
    <section>
      <b>{t('How it\'s measured')}</b>
      <p>{t('The whole file is decoded and cut into short overlapping slices. Each slice goes through an FFT, which splits it into frequencies: every column of the picture is one moment, every row one frequency, and brighter means louder (from −120 to 0 dBFS).')}</p>
      <p>{t('Left and right are measured both together (mid) and apart (side), so the check can see what an encoder did to the stereo. Each line under the verdict is one clue; open it to see why it matters.')}</p>
    </section>
    <section>
      <b>{t('How the verdict is reached')}</b>
      <p>{t('A brick-wall cutoff where lossy encoders put theirs is the strongest clue. Spectral holes and mono highs confirm it, or, without a wall, make the result Inconclusive rather than a guess. A hi-res file with an edge at the CD limit is called upsampled.')}</p>
    </section>
    <section>
      <b>{t('Limits')}</b>
      <p>{t('This is strong evidence, not proof. A high-bitrate AAC or 320 kbps MP3 can reach 20 kHz, some masters are filtered on purpose, and very quiet or very short tracks give weaker readings.')}</p>
    </section>
  </div>
);

const SpectrumModal = ({ file, onClose }) => {
  const canvasRef = useRef(null);
  const holesRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showLine, setShowLine] = useState(() => { try { return localStorage.getItem('spec-line') !== '0'; } catch { return true; } });
  const [tab, setTabState] = useState(() => { try { return localStorage.getItem('qc-tab') === 'mastering' ? 'mastering' : 'fidelity'; } catch { return 'fidelity'; } });
  const setTab = (x) => { setTabState(x); try { localStorage.setItem('qc-tab', x); } catch { /* private storage */ } };
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!file) return undefined;
    let active = true;
    setResult(null); setError(null); setProgress(0);
    const ipc = window.ipcRenderer;
    const onProgress = (e, p) => { if (active && p.path === file.path) setProgress(p.pct); };
    ipcOn(ipc, 'analysis:progress', onProgress);
    ipc.invoke('analysis:spectrum', file.path).then(res => {
      if (!active) return;
      if (res.success) setResult(res); else setError(res.error);
    }).catch(err => active && setError(err.message));
    return () => {
      active = false;
      ipcOff(ipc, 'analysis:progress', onProgress);
      ipc.invoke('analysis:cancel');
    };
  }, [file]);

  // Paint the spectrogram: x = time, y = frequency (row 0 = 0 Hz at the bottom), and the holes under it
  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const { columns, rows, data } = result;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const canvas = canvasRef.current;
    canvas.width = columns;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(columns, rows);
    for (let x = 0; x < columns; x++) {
      for (let r = 0; r < rows; r++) {
        const v = bytes[x * rows + r];
        const o = ((rows - 1 - r) * columns + x) * 4;
        img.data[o] = LUT[v * 3]; img.data[o + 1] = LUT[v * 3 + 1]; img.data[o + 2] = LUT[v * 3 + 2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const hc = holesRef.current;
    if (hc && result.holesMap?.length) {
      hc.width = result.holesMap.length;
      hc.height = 1;
      const h = hc.getContext('2d');
      const im = h.createImageData(hc.width, 1);
      result.holesMap.forEach((n, i) => {
        const a = n ? Math.min(255, 90 + n * 40) : 0;
        im.data[i * 4] = 255; im.data[i * 4 + 1] = 92; im.data[i * 4 + 2] = 92; im.data[i * 4 + 3] = a;
      });
      h.putImageData(im, 0, 0);
    }
  }, [result]);

  const ticks = useMemo(() => {
    if (!result) return [];
    const nyq = result.sampleRate / 2;
    const step = nyq > 60000 ? 20000 : nyq > 30000 ? 8000 : 4000;
    const out = [];
    for (let f = 0; f <= nyq; f += step) out.push(f);
    if (nyq - out[out.length - 1] > step * 0.35) out.push(nyq);
    return out.map(f => ({ f, top: (1 - f / nyq) * 100 }));
  }, [result]);

  if (!file) return null;
  const q = qualityOf(file);
  const toggleLine = () => setShowLine(v => { try { localStorage.setItem('spec-line', v ? '0' : '1'); } catch { /* private storage */ } return !v; });
  const duration = result?.duration || file.metadata?.duration || 0;
  const v = result?.verdict;
  const [title, detail] = v ? verdictText(v, result) : [];
  const nyq = result ? result.sampleRate / 2 : 0;
  const copy = async () => {
    try { await navigator.clipboard.writeText(asText(file, q, result)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard refused */ }
  };
  const confidence = v && { high: t('High confidence'), medium: t('Medium confidence'), low: t('Low confidence') }[v.confidence];

  return (
    <Dialog open onClose={onClose} title={file.metadata?.title || file.name} icon="spectrum" width={980}>
      <div className="spectrum quality" style={{ width: '100%' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="qc-kicker">{t('Quality check')}</span>
          <span className={`badge b-${q.tier} mono`}>{q.label}</span>
          {file.metadata?.bitrate > 0 && <span className="badge b-lossy mono">{Math.round(file.metadata.bitrate / 1000)} kbps</span>}
          {result && <span className="badge b-lossy mono">FFT {result.fftSize}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {result && (
              <button className="btn-ghost sm" onClick={copy} title={t('Copy both tabs as text, to paste in a forum or a chat (without where the file is)')}>
                <Icon name={copied ? 'check' : 'queue'} />{copied ? t('Copied') : t('Copy as text')}
              </button>
            )}
            {tab === 'fidelity' && (
              <button className={`btn-ghost sm ${showLine ? 'on' : ''}`} onClick={toggleLine} title={t('The white line marks where the content stops')}>
                <Icon name={showLine ? 'eye' : 'eyeOff'} />{t('Cutoff line')}
              </button>
            )}
            <button className={`btn-ghost sm ${showHelp ? 'on' : ''}`} onClick={() => setShowHelp(x => !x)} aria-expanded={showHelp}>
              <Icon name="info" />{t('How it\'s measured')}
            </button>
          </span>
        </div>
        {showHelp && (tab === 'fidelity' ? <QualityHelp /> : <MasteringHelp />)}
        <div className="meta">{file.path}</div>
        <div className="qc-tabs">
          <Segmented value={tab} onChange={setTab} size="sm" options={[{ value: 'fidelity', label: t('Fidelity') }, { value: 'mastering', label: t('Mastering') }]} />
          <span className="qc-tab-hint">{tab === 'fidelity' ? t('Is the file what it says it is?') : t('How the song was mastered, whatever the file')}</span>
        </div>

        {tab === 'mastering' && (result?.mastering ? <Mastering result={result} /> : <MasteringLoading progress={progress} error={error} />)}
        {/* kept mounted while hidden: the spectrogram is painted once, when the result comes */}
        <div hidden={tab !== 'fidelity'}>

        {v && (
          <div className={`qc-verdict ${TONE[v.level] || 'info'}`}>
            <div className="qc-verdict-head">
              <Icon name={v.level === 'ok' ? 'check' : v.level === 'info' ? 'info' : 'alert'} />
              <b>{title}</b>
              <span className="qc-conf">{confidence}</span>
            </div>
            <p>{detail}</p>
          </div>
        )}
        {v && <div className="qc-evidence">{v.evidence.filter(e => !MASTERING_IDS.has(e.id)).map(e => <EvidenceRow key={e.id} e={e} />)}</div>}

        <div className="spec-plot">
          <div className="spec-axis">
            {ticks.map(x => <span key={x.f} style={{ top: `${x.top}%` }}>{x.f === 0 ? '0' : `${(x.f / 1000).toFixed(x.f % 1000 ? 1 : 0)}k`}</span>)}
          </div>
          <div className="spec-canvas" style={{ background: '#000004' }}>
            <canvas ref={canvasRef} style={{ opacity: result ? 1 : 0, imageRendering: 'auto' }} />
            {showLine && result && result.cutoffHz < nyq * 0.97 && (
              <div className="spec-cutoff" style={{ top: `${(1 - result.cutoffHz / nyq) * 100}%` }}>
                <span>{(result.cutoffHz / 1000).toFixed(1)} kHz</span>
              </div>
            )}
            {!result && !error && (
              <div className="state" style={{ color: '#d8d0e8' }}>
                <div style={{ width: 260 }}>
                  <div style={{ marginBottom: 10 }}>{t('Decoding and analysing… {pct}', { pct: progress })}%</div>
                  <Progress value={progress} />
                </div>
              </div>
            )}
            {error && <div className="state" style={{ color: 'var(--danger)' }}>{error}</div>}
          </div>
          <div className="spec-legend" style={{ background: GRADIENT }} title={t('Level, dBFS')} />
          <div className="qc-holes" title={t('Moments with spectral holes')}>
            <canvas ref={holesRef} />
          </div>
          <div className="spec-time">
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map(f => <span key={f}>{formatTime(duration * f)}</span>)}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
          <span>{t('Frequency (Hz) over time · brighter = louder (−120 → 0 dBFS) · red strip: spectral holes')}</span>
          {result && <span className="mono">{t('{value} kHz decode · limit {value2}', { value: (result.sampleRate / 1000).toFixed(1), value2: (nyq / 1000).toFixed(1) })} kHz</span>}
        </div>
        {result && <AverageSpectrum result={result} />}
        </div>
      </div>
    </Dialog>
  );
};

export default SpectrumModal;
