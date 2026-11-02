import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Dialog, Progress } from './ui';
import Icon from './Icon';
import { formatTime, qualityOf } from '../utils/audio';

// Perceptual "inferno"-like colormap: black → purple → red → orange → pale yellow
const STOPS = [
  [0, [0, 0, 4]], [0.15, [31, 12, 72]], [0.3, [85, 15, 109]], [0.45, [136, 34, 106]],
  [0.6, [186, 54, 85]], [0.72, [227, 89, 51]], [0.84, [249, 140, 10]], [0.93, [249, 201, 50]], [1, [252, 255, 164]],
];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0 || 1);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return lut;
})();
const GRADIENT = `linear-gradient(to top, ${STOPS.map(([t, c]) => `rgb(${c.join(',')}) ${t * 100}%`).join(', ')})`;

const VERDICT_STYLE = {
  ok: { icon: 'check', tone: 'ok' },
  warn: { icon: 'alert', tone: 'warn' },
  bad: { icon: 'alert', tone: 'danger' },
  info: { icon: 'info', tone: 'info' },
};

// What the analysis does and how each verdict is reached (mirrors electron/spectrumCore.js)
const SpectrumHelp = () => (
  <div className="spec-help">
    <section>
      <b>How it's measured</b>
      <p>The whole file is decoded and cut into short overlapping slices. Each slice goes through an FFT, which splits it into frequencies: every column of the picture is one moment, every row one frequency, and brighter means louder (from −120 to 0 dBFS).</p>
      <p>The levels are then averaged over the entire track. The <b>cutoff</b> (white line) is the highest frequency that stays clearly above the noise floor for a stretch of at least 400 Hz. A cutoff is <b>sharp</b> when the level drops by more than 25 dB within about 1 kHz above it, which is what an encoder's low-pass filter does.</p>
      <p>Bit depth is checked separately: the samples are inspected to see how many of the declared bits ever change.</p>
    </section>
    <section>
      <b>What the results mean</b>
      <dl>
        <dt className="ok">Lossless, full range</dt><dd>Content reaches at least 93% of the limit for this sample rate (about 20.5 kHz at 44.1 kHz) with no brick wall. What you expect from a CD rip or a real hi-res file.</dd>
        <dt className="bad">Lossy source</dt><dd>A sharp cutoff between 10 and 20.8 kHz in a lossless file: it was most likely made from an MP3 or AAC. Rough guide: ~16 kHz ≈ 128 kbps, ~19 kHz ≈ 192, ~19.5 kHz ≈ 256, ~20 kHz ≈ 320. It can look perfect elsewhere and still be lossy.</dd>
        <dt className="bad">Upsampled</dt><dd>A sample rate above 48 kHz with nothing above about 24.5 kHz: the music was made at 44.1 or 48 kHz and converted up. It sounds the same as the original, it is just bigger.</dd>
        <dt className="bad">Padded bit depth</dt><dd>Declared 24-bit, but only 16 bits ever carry data: 16-bit audio stored in a 24-bit container.</dd>
        <dt className="warn">Gradual roll-off</dt><dd>The highs fade out slowly instead of stopping. Common for older or analogue recordings and gentle masters; not a sign of lossy encoding on its own.</dd>
        <dt>Lossy by design</dt><dd>MP3, AAC, Opus and Vorbis files are expected to stop early; the cutoff shows roughly which bitrate.</dd>
      </dl>
    </section>
    <section>
      <b>Limits</b>
      <p>This is strong evidence, not proof. A high-bitrate AAC or 320 kbps MP3 can reach 20 kHz, some masters are filtered on purpose, and very quiet or very short tracks give weaker readings.</p>
    </section>
  </div>
);

const SpectrumModal = ({ file, onClose }) => {
  const canvasRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [pct, setPct] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showLine, setShowLine] = useState(() => { try { return localStorage.getItem("spec-line") !== "0"; } catch { return true; } });

  useEffect(() => {
    if (!file) return undefined;
    let active = true;
    setResult(null); setError(null); setPct(0);
    const ipc = window.ipcRenderer;
    const onProgress = (e, p) => { if (active && p.path === file.path) setPct(p.pct); };
    ipc.on('analysis:progress', onProgress);
    ipc.invoke('analysis:spectrum', file.path).then(res => {
      if (!active) return;
      if (res.success) setResult(res); else setError(res.error);
    }).catch(err => active && setError(err.message));
    return () => {
      active = false;
      ipc.removeListener('analysis:progress', onProgress);
      ipc.invoke('analysis:cancel');
    };
  }, [file]);

  // Paint the spectrogram: x = time, y = frequency (row 0 = 0 Hz at the bottom)
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
  const style = v ? VERDICT_STYLE[v.level] || VERDICT_STYLE.info : null;
  const nyq = result ? result.sampleRate / 2 : 0;

  return (
    <Dialog open onClose={onClose} title={file.metadata?.title || file.name} icon="spectrum" width={960}>
      <div className="spectrum" style={{ width: '100%' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge b-${q.tier} mono`}>{q.label}</span>
          {file.metadata?.bitrate > 0 && <span className="badge b-lossy mono">{Math.round(file.metadata.bitrate / 1000)} kbps</span>}
          {result?.effectiveBits && <span className="badge b-lossy mono">{result.effectiveBits}-bit used</span>}
          {result && <span className="badge b-lossy mono">FFT {result.fftSize}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className={`btn-ghost sm ${showLine ? 'on' : ''}`} onClick={toggleLine} title="The white line marks where the content stops">
              <Icon name={showLine ? 'eye' : 'eyeOff'} />Cutoff line
            </button>
            <button className={`btn-ghost sm ${showHelp ? 'on' : ''}`} onClick={() => setShowHelp(v => !v)} aria-expanded={showHelp}>
              <Icon name="info" />How it's measured
            </button>
          </span>
        </div>
        {showHelp && <SpectrumHelp />}
        <div className="meta">{file.path}</div>

        {v && (
          <div className={`callout ${style.tone} verdict`} style={{ marginTop: 12 }}>
            <Icon name={style.icon} />
            <div>
              <b style={{ display: 'block', fontSize: 14, marginBottom: 2 }}>{v.title}</b>
              <span>{v.detail}</span>
              {v.notes?.map(n => <div key={n} style={{ marginTop: 4 }}>{n}</div>)}
            </div>
          </div>
        )}

        <div className="spec-plot">
          <div className="spec-axis">
            {ticks.map(t => <span key={t.f} style={{ top: `${t.top}%` }}>{t.f === 0 ? '0' : `${(t.f / 1000).toFixed(t.f % 1000 ? 1 : 0)}k`}</span>)}
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
                  <div style={{ marginBottom: 10 }}>Decoding and analysing… {pct}%</div>
                  <Progress value={pct} />
                </div>
              </div>
            )}
            {error && <div className="state" style={{ color: 'var(--danger)' }}>{error}</div>}
          </div>
          <div className="spec-legend" style={{ background: GRADIENT }} title="Level, dBFS" />
          <div className="spec-time">
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map(f => <span key={f}>{formatTime(duration * f)}</span>)}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
          <span>Frequency (Hz) over time · brighter = louder (−120 → 0 dBFS)</span>
          {result && <span className="mono">{(result.sampleRate / 1000).toFixed(1)} kHz decode · limit {(nyq / 1000).toFixed(1)} kHz</span>}
        </div>
      </div>
    </Dialog>
  );
};

export default SpectrumModal;
