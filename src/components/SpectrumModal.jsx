import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Dialog, Progress } from './ui';
import Icon from './Icon';
import { formatTime, qualityOf } from '../utils/audio';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

// Quality check: is this file what it says it is? electron/spectrumCore.js measures and judges (ids and numbers
// only); this window words it, shows the evidence one line each, the spectrogram and the average spectrum.

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

const EvidenceRow = ({ e }) => {
  const x = evidenceText(e);
  return (
    <details className={`qc-row ${e.status}`}>
      <summary>
        <span className="qc-dot"><Icon name={STATUS_ICON[e.status] || 'info'} /></span>
        <span className="qc-label">{x.label}</span>
        <span className="qc-value mono">{x.value}</span>
        <span className="qc-says">{x.says}</span>
      </summary>
      <p className="qc-why">{x.why}</p>
    </details>
  );
};

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
            <button className={`btn-ghost sm ${showLine ? 'on' : ''}`} onClick={toggleLine} title={t('The white line marks where the content stops')}>
              <Icon name={showLine ? 'eye' : 'eyeOff'} />{t('Cutoff line')}
            </button>
            <button className={`btn-ghost sm ${showHelp ? 'on' : ''}`} onClick={() => setShowHelp(x => !x)} aria-expanded={showHelp}>
              <Icon name="info" />{t('How it\'s measured')}
            </button>
          </span>
        </div>
        {showHelp && <QualityHelp />}
        <div className="meta">{file.path}</div>

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
        {v && <div className="qc-evidence">{v.evidence.map(e => <EvidenceRow key={e.id} e={e} />)}</div>}

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
    </Dialog>
  );
};

export default SpectrumModal;
