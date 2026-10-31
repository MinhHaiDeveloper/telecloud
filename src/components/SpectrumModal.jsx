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

const SpectrumModal = ({ file, onClose }) => {
  const canvasRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [pct, setPct] = useState(0);

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
        </div>
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
            {result && result.cutoffHz < nyq * 0.97 && (
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
