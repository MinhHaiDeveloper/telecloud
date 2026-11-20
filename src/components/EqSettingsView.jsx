import React, { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import SongActions from './songActions';
import EqGraph from './EqGraph';
import Icon from './Icon';
import { Toggle, Segmented, Select, Callout, Dialog, BackButton, MoreMenu, alertDialog } from './ui';
import {
  parseGraphicCurve, fitCurve, formatAudacityText,
  DEFAULT_Q, MAX_BANDS, GAIN_LIMIT, flatBands, autoEq, autoPreamp, parseEqText, formatEqText, parseCurveText,
} from '../utils/autoEqMath';
import { AUTOEQ_DEFAULTS } from '../hooks/useEq';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

const TYPE_OPTIONS = [{ value: 'Peak', label: 'PK' }, { value: 'LSF', label: 'LS' }, { value: 'HSF', label: 'HS' }];
const SMOOTH_OPTIONS = [{ value: 0, get label() { return t('Raw'); } }, { value: 1 / 24, get label() { return t('1/24 oct'); } }, { value: 1 / 12, get label() { return t('1/12 oct'); } }, { value: 1 / 6, get label() { return t('1/6 oct'); } }, { value: 1 / 3, get label() { return t('1/3 oct'); } }];
const readPref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const writePref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

const defaultTargetFor = (hp) => {
  if (!hp) return 'Harman in-ear 2019';
  if (/5128/.test(hp.rig || '')) return 'Diffuse field 5128 -1dB per octave';
  return hp.kind === 'in-ear' ? 'Harman in-ear 2019' : 'Harman over-ear 2018';
};

/** Number box that keeps what you type until Enter / blur, then commits a clamped number */
const NumBox = ({ value, onCommit, min, max, step = 0.1, digits = 1, width, title }) => {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? String(value);
  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    setDraft(null);
    if (!Number.isFinite(n)) return;
    const v = Number(Math.min(max, Math.max(min, n)).toFixed(digits));
    if (v !== value) onCommit(v);
  };
  const nudge = (dir) => onCommit(Number(Math.min(max, Math.max(min, value + dir * step)).toFixed(digits)));
  return (
    <input
      className="input sm mono num-box" style={width ? { width } : undefined} title={title} inputMode="decimal"
      value={shown}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setDraft(null); nudge(e.key === 'ArrowUp' ? (e.shiftKey ? 10 : 1) : (e.shiftKey ? -10 : -1)); }
      }}
    />
  );
};

const BandRow = memo(({ band, idx, selected, onSelect, onEdit, onRemove, canRemove }) => {
  const ref = useRef(null);
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const set = (field, label) => (v) => onEdit(idx, { ...band, [field]: v }, label);
  return (
    <div ref={ref} className={`band-row ${selected ? 'on' : ''} ${band.gain ? '' : 'flat'}`} onMouseDown={() => onSelect(idx)}>
      <span className="b-num">{idx + 1}</span>
      <select className="input sm b-type" value={band.type} onChange={e => onEdit(idx, { ...band, type: e.target.value }, t('Band {value} → {value2}', { value: idx + 1, value2: e.target.value }))}>
        {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <NumBox value={band.freq} min={20} max={20000} step={band.freq < 100 ? 1 : band.freq < 1000 ? 10 : 100} digits={band.freq < 100 ? 1 : 0} onCommit={set('freq', `Band ${idx + 1} frequency`)} title={t('Frequency (Hz)')} />
      <NumBox value={band.gain} min={-GAIN_LIMIT} max={GAIN_LIMIT} step={0.5} onCommit={set('gain', `Band ${idx + 1} gain`)} title={t('Gain (dB)')} />
      <NumBox value={band.q} min={0.1} max={20} step={0.1} digits={2} onCommit={set('q', `Band ${idx + 1} Q`)} title="Q" />
      <button className="b-del" onClick={(e) => { e.stopPropagation(); onRemove(idx); }} disabled={!canRemove} title={t('Remove band')}><Icon name="close" /></button>
    </div>
  );
});

/** Headphone search over the AutoEq index (bundled), loading the measurement on pick */
const HeadphonePicker = ({ value, onPick, onClear }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return undefined; }
    const t = setTimeout(() => window.ipcRenderer.invoke('autoeq:search', query).then(setResults).catch(() => setResults([])), 120);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = async (item) => {
    setOpen(false);
    setLoading(true);
    try {
      const m = await window.ipcRenderer.invoke('autoeq:measurement', item.id);
      onPick({ name: m.name, source: m.source, kind: m.kind, rig: m.rig, data: m.data });
      setQuery('');
    } catch (err) {
      alertDialog({ title: t('Could not load that measurement'), message: t('{message}. Check your internet connection; measurements are cached after the first download.', { message: err.message }), tone: 'danger' });
    } finally {
      setLoading(false);
    }
  };

  if (value) {
    return (
      <div className="hp-chip">
        <Icon name="speaker" />
        <div className="t"><b>{value.name}</b><span>{value.source}{value.rig ? ` · ${value.rig}` : ''}{value.kind ? ` · ${value.kind}` : ''}</span></div>
        <button className="icon-btn sm" onClick={onClear} title={t('Choose another')}><Icon name="close" /></button>
      </div>
    );
  }
  return (
    <div className="hp-search" ref={boxRef}>
      <Icon name={loading ? 'refresh' : 'search'} className={loading ? 'spinning' : ''} />
      <input
        className="input" placeholder={t('Search 6,800+ headphones and IEMs…')} value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={e => { if (e.key === 'Enter' && results[0]) pick(results[0]); if (e.key === 'Escape') setOpen(false); }}
      />
      {open && query.trim() && (
        <div className="menu hp-results">
          {results.length === 0 && <div className="empty" style={{ padding: 12 }}>{t('No match. Try the brand or model name.')}</div>}
          {results.map(r => (
            <button key={r.id} className="menu-item" onClick={() => pick(r)}>
              <span className="nm">{r.name}</span>
              <span className="src">{r.source}{r.rig ? ` · ${r.rig}` : ''}</span>
              <span className="badge b-local">{r.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const readTextFile = (e) => new Promise((resolve) => {
  const file = e.target.files?.[0];
  e.target.value = null;
  if (!file) { resolve(null); return; }
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name.replace(/\.[^.]+$/, ''), text: String(reader.result) });
  reader.readAsText(file);
});

// the live spectrum's bands: as electron/liveSpectrum.js makes them
const LIVE_FREQS = Array.from({ length: 120 }, (_, i) => 20 * Math.pow(1000, (i + 0.5) / 120));

/** What is playing, analysed after every filter, while the EQ page is open and the switch is on */
function useLiveSpectrum(on) {
  const [bands, setBands] = useState(null);
  const [why, setWhy] = useState(null);
  const held = useRef(null);
  useEffect(() => {
    if (!on) { setBands(null); return undefined; }
    const ipc = window.ipcRenderer;
    const onFrame = (e, b) => {
      // rise at once, fall gently: easier to read than raw frames
      const prev = held.current;
      held.current = Array.isArray(b) ? b.map((v, i) => (prev && prev[i] - 1.8 > v ? prev[i] - 1.8 : v)) : null;
      setBands(held.current);
      setWhy(null);
    };
    const onState = (e, st) => { if (st?.why) { setWhy(st.why); setBands(null); held.current = null; } };
    ipcOn(ipc, 'spectrum:frame', onFrame);
    ipcOn(ipc, 'spectrum:state', onState);
    ipc.invoke('spectrum:live', true);
    return () => {
      ipc.invoke('spectrum:live', false);
      ipcOff(ipc, 'spectrum:frame', onFrame);
      ipcOff(ipc, 'spectrum:state', onState);
      held.current = null;
    };
  }, [on]);
  return { bands, why };
}

const EqSettingsView = ({ onBack, eq, deviceName }) => {
  const ctx = useContext(SongActions);
  const snd = ctx?.snd;
  const [liveOn, setLiveOn] = useState(() => readPref('tc-eq-live', true));
  useEffect(() => writePref('tc-eq-live', liveOn), [liveOn]);
  const live = useLiveSpectrum(liveOn);
  useEffect(() => () => snd?.setAb(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const { perDevice, setPerDevice, enabled, setEnabled, bands, setBands, preamp, setPreamp, auto, setAuto, history, commit, apply, jump, undo, redo } = eq;
  const [selected, setSelected] = useState(null);
  const [collapsed, setCollapsed] = useState(() => readPref('tc-eq-bands-collapsed', false));
  const [yRange, setYRange] = useState(() => readPref('tc-eq-yrange', 12));
  const [smoothing, setSmoothing] = useState(() => readPref('tc-eq-smooth', 1 / 12));
  const [targets, setTargets] = useState([]);
  const [targetLoading, setTargetLoading] = useState(false);
  const [lastFit, setLastFit] = useState(null);
  const [importNote, setImportNote] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const params = { ...AUTOEQ_DEFAULTS, ...auto.params };

  useEffect(() => { writePref('tc-eq-bands-collapsed', collapsed); }, [collapsed]);
  useEffect(() => { writePref('tc-eq-yrange', yRange); }, [yRange]);
  useEffect(() => { writePref('tc-eq-smooth', smoothing); }, [smoothing]);
  useEffect(() => { window.ipcRenderer.invoke('autoeq:targets').then(setTargets).catch(() => {}); }, []);

  // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) while this page is open, unless typing in a field
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Graph drag → state every frame; history entry when the drag ends
  const onGraphChange = useCallback((idx, band) => setBands(prev => prev.map((b, i) => (i === idx ? band : b))), [setBands]);
  const current = useRef({ bands, preamp });
  current.current = { bands, preamp };
  const onRowEdit = useCallback((idx, band, label) => {
    const next = current.current.bands.map((b, i) => (i === idx ? band : b));
    setBands(next);
    commit(label, { bands: next, preamp: current.current.preamp });
  }, [setBands, commit]);
  const onRemove = useCallback((idx) => {
    const next = current.current.bands.filter((_, i) => i !== idx);
    setBands(next);
    commit(t('Removed band {value}', { value: idx + 1 }), { bands: next, preamp: current.current.preamp });
    setSelected(null);
  }, [setBands, commit]);

  const addBand = () => {
    if (bands.length >= MAX_BANDS) return;
    // put the new band in the widest free gap
    const fs = [20, ...bands.map(b => b.freq).sort((a, b) => a - b), 20000];
    let best = 1000, gap = 0;
    for (let i = 1; i < fs.length; i++) {
      const g = Math.log2(fs[i] / fs[i - 1]);
      if (g > gap) { gap = g; best = Math.round(Math.sqrt(fs[i] * fs[i - 1])); }
    }
    const next = [...bands, { type: 'Peak', freq: best, gain: 0, q: 1.41 }];
    apply({ bands: next, preamp }, t('Added band at {best} Hz', { best }));
    setSelected(next.length - 1);
  };

  const setPreampCommit = (v) => { setPreamp(v); commit(t('Preamp {v} dB', { v }), { bands, preamp: v }); };

  const exportEq = (format) => {
    const base = auto.measurement ? auto.measurement.name : 'TeleCloud';
    const name = format === 'audacity' ? `${base} Audacity GraphicEQ` : `${base} ParametricEQ`;
    const blob = new Blob([format === 'audacity' ? formatAudacityText(bands, preamp) : formatEqText(bands, preamp)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importEq = async (e) => {
    const file = await readTextFile(e);
    if (!file) return;
    const parsed = parseEqText(file.text);
    setImportNote(null);
    if (!parsed.bands.length) {
      // not filters: maybe a graphic curve (Audacity, EqualizerAPO GraphicEQ)
      const curve = parseGraphicCurve(file.text);
      if (!curve) {
        alertDialog({ title: t('Could not read that file'), message: t('Expected a Squiglink / EqualizerAPO text file with "Filter 1: ON PK Fc … Hz Gain … dB Q …" lines, or an Audacity / GraphicEQ curve.'), tone: 'danger' });
        return;
      }
      const fit = fitCurve(curve);
      apply({ bands: fit.bands, preamp: fit.preamp }, `Imported “${file.name}”`);
      setImportNote(t('“{name}” has {length} curve points, so it was turned into {length2} bands that stay within {max} dB of it.', { name: file.name, length: curve.length, length2: fit.bands.length, max: Math.max(fit.maxError, 0.01).toFixed(2) }));
      setSelected(null);
      return;
    }
    apply(parsed, `Imported “${file.name}”`);
    setSelected(null);
  };

  const loadCurveFile = async (e, which) => {
    const file = await readTextFile(e);
    if (!file) return;
    const data = parseCurveText(file.text);
    if (data.length < 10) {
      alertDialog({ title: t('Could not read that curve'), message: t('Expected two columns: frequency and level (dB), as exported by Squiglink, REW or AutoEq.'), tone: 'danger' });
      return;
    }
    setAuto(a => ({ ...a, [which]: which === 'measurement' ? { name: file.name, source: 'File', data } : { name: file.name, custom: true, data } }));
  };

  const pickTarget = async (name) => {
    setTargetLoading(true);
    try {
      const t = await window.ipcRenderer.invoke('autoeq:target', name);
      setAuto(a => ({ ...a, target: { name: t.name, data: t.data } }));
    } catch (err) {
      alertDialog({ title: t('Could not load that target'), message: t('{message}. Check your internet connection.', { message: err.message }), tone: 'danger' });
    } finally {
      setTargetLoading(false);
    }
  };

  const onPickHeadphone = (m) => {
    setAuto(a => ({ ...a, measurement: m }));
    if (!auto.target || !auto.target.custom) pickTarget(defaultTargetFor(m));
  };

  const setParam = (k) => (v) => setAuto(a => ({ ...a, params: { ...AUTOEQ_DEFAULTS, ...a.params, [k]: v } }));

  const runAutoEq = () => {
    if (!auto.measurement || !auto.target) return;
    const r = autoEq({ measurement: auto.measurement.data, target: auto.target.data, maxFilters: params.filters, maxGain: params.maxGain, maxQ: params.maxQ, minFreq: params.minFreq, maxFreq: params.maxFreq });
    if (!r.bands.length) {
      alertDialog({ title: t('Nothing to correct'), message: t('The measurement already follows the target within the limits you set.'), tone: 'info' });
      return;
    }
    apply({ bands: r.bands, preamp: r.preamp }, `AutoEQ · ${auto.measurement.name} → ${auto.target.name}`);
    setLastFit({ before: r.rmsBefore, after: r.rmsAfter, n: r.bands.length });
    setSelected(null);
    if (!enabled) setEnabled(true);
  };

  const reset = () => { apply({ bands: flatBands(), preamp: 0 }, t('Reset to flat 31-band')); setSelected(null); };
  const peak = useMemo(() => -autoPreamp(bands), [bands]);
  const clipping = enabled && peak + preamp > 0.05;
  const targetOptions = useMemo(() => {
    const list = targets.map(t => ({ value: t, label: t }));
    if (auto.target?.custom) list.unshift({ value: auto.target.name, label: t('{name} (file)', { name: auto.target.name }) });
    return list;
  }, [targets, auto.target]);

  return (
    <div className="eq-page">
      <div className="page-head" style={{ margin: 0 }}>
        <BackButton onClick={onBack} label={t('Back')} />
        <h2>{t('Parametric EQ')}</h2>
        <span className="sub">{t('{length} bands · preamp {preamp}', { length: bands.length, preamp })} dB</span>
        <div className="end">
          <button className="icon-btn" onClick={undo} disabled={history.index <= 0} title={t('Undo (Ctrl+Z)')}><Icon name="undo" /></button>
          <button className="icon-btn" onClick={redo} disabled={history.index >= history.stack.length - 1} title={t('Redo (Ctrl+Y)')}><Icon name="redo" /></button>
          <label className="btn-ghost pressable" title={t('Import a Squiglink, EqualizerAPO or Audacity file')}>
            <Icon name="upload" />{t('Import')}
            <input type="file" accept=".txt,.xml" onChange={importEq} hidden />
          </label>
          <MoreMenu
            title={t('Export')}
            trigger={<><Icon name="download" />{t('Export')}</>}
            items={[
              { label: t('Squiglink / EqualizerAPO'), icon: 'download', onClick: () => exportEq('squiglink') },
              { label: t('Audacity Graphic EQ'), icon: 'download', onClick: () => exportEq('audacity') },
            ]}
          />
          <button className="btn-ghost" onClick={reset}><Icon name="refresh" />{t('Reset')}</button>
          <button className="icon-btn" onClick={() => setShowGuide(true)} title={t('Guide')}><Icon name="info" /></button>
          {snd && (
            <button className={`btn-ab ${snd.ab ? 'on' : ''}`} onClick={() => snd.setAb(!snd.ab)} aria-pressed={snd.ab} title={t('Hear the original without the EQ and the sound settings, at the same loudness')}>
              <b className={snd.ab ? '' : 'on'}>A</b><b className={snd.ab ? 'on' : ''}>B</b><span>{snd.ab ? t('Original') : t('Processed')}</span>
            </button>
          )}
          <Toggle checked={enabled} onChange={setEnabled} label={enabled ? t('EQ on') : t('EQ off')} />
        </div>
      </div>

      <div className="eq-output">
        <label className="eq-output-toggle">
          <Toggle checked={perDevice} onChange={setPerDevice} />
          <span>{t('Separate EQ for each output')}</span>
        </label>
        <small>{perDevice ? t('Editing the EQ for {deviceName}. Each output remembers its own, and it changes when you switch output.', { deviceName }) : t('Off: the same EQ is used on every output.')}</small>
      </div>
      {importNote && <Callout tone="info">{importNote} <button className="link-btn" onClick={() => setImportNote(null)}>OK</button></Callout>}
      {clipping && <Callout tone="warn">{t('The EQ boosts up to {peak} dB but the preamp is {preamp} dB, so loud passages can clip.', { peak: peak.toFixed(1), preamp })} <button className="link-btn" onClick={() => setPreampCommit(-peak)}>{t('Set preamp to {value}', { value: (-peak).toFixed(1) })} dB</button></Callout>}

      <div className={`eq-layout ${collapsed ? 'collapsed' : ''}`}>
        <div className="eq-main">
          <div className="card eq-graph">
            <div className="eq-toolbar">
              <div className="legend">
                <span className="lg filter">EQ</span>
                {auto.measurement && <span className="lg meas">{auto.measurement.name}</span>}
                {auto.target && <span className="lg target">{auto.target.name}</span>}
                {auto.measurement && <span className="lg result">{t('With EQ')}</span>}
              </div>
              <div className="grp">
                {(auto.measurement || auto.target) && <Select variant="ghost" value={smoothing} onChange={setSmoothing} options={SMOOTH_OPTIONS} align="right" />}
                <label className="eq-live-toggle" title={t('The music after every filter, as it plays')}>
                  <Toggle checked={liveOn} onChange={setLiveOn} />
                  <span>{t('Live spectrum')}</span>
                </label>
                <Segmented size="sm" value={yRange} onChange={setYRange} options={[12, 24, 36].map(v => ({ value: v, label: `±${v}` }))} />
              </div>
            </div>
            <EqGraph
              bands={bands} measurement={auto.measurement?.data} target={auto.target?.data} smoothing={smoothing}
              yRange={yRange} selected={selected} onSelect={setSelected} onChange={onGraphChange} onCommit={commit}
              spectrum={live.bands} liveFreqs={LIVE_FREQS}
            />
            {liveOn && live.why === 'cloud' && <div className="eq-live-note">{t('The live spectrum needs the track on this computer: it shows once a TeleCloud track is cached.')}</div>}
            <div className="eq-hint">{t('Drag a dot to move it · {b} gain only · {b2} frequency only · scroll on a dot for Q · double-click to flatten', { b: <b>{t('Shift')}</b>, b2: <b>{t('Alt')}</b> })}</div>
          </div>

          <div className="eq-lower">
            <div className="card eq-card">
              <h3><Icon name="spectrum" />AutoEQ</h3>
              <div className="field">
                <span className="field-label">{t('Headphone you are listening on')}</span>
                <div className="row-gap">
                  <HeadphonePicker value={auto.measurement} onPick={onPickHeadphone} onClear={() => setAuto(a => ({ ...a, measurement: null }))} />
                  {!auto.measurement && (
                    <label className="btn-ghost pressable" title={t('Measurement file (frequency, dB)')}>
                      <Icon name="folder" />{t('File')}
                      <input type="file" accept=".txt,.csv" onChange={e => loadCurveFile(e, 'measurement')} hidden />
                    </label>
                  )}
                </div>
              </div>
              <div className="field">
                <span className="field-label">{t('Target sound')}</span>
                <div className="row-gap">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Select value={auto.target?.name || ''} onChange={pickTarget} options={targetOptions.length ? targetOptions : [{ value: '', label: t('Loading targets…') }]} icon={targetLoading ? 'refresh' : undefined} width="100%" />
                  </div>
                  <label className="btn-ghost pressable" title={t('Target file (frequency, dB)')}>
                    <Icon name="folder" />{t('File')}
                    <input type="file" accept=".txt,.csv" onChange={e => loadCurveFile(e, 'target')} hidden />
                  </label>
                </div>
              </div>
              <div className="aeq-params">
                <label><span>{t('Filters')}</span><NumBox value={params.filters} min={1} max={MAX_BANDS} step={1} digits={0} onCommit={setParam('filters')} /></label>
                <label><span>{t('Max gain')}</span><NumBox value={params.maxGain} min={1} max={GAIN_LIMIT} step={1} digits={1} onCommit={setParam('maxGain')} /></label>
                <label><span>{t('Max Q')}</span><NumBox value={params.maxQ} min={0.5} max={10} step={0.5} digits={1} onCommit={setParam('maxQ')} /></label>
                <label><span>{t('From Hz')}</span><NumBox value={params.minFreq} min={20} max={2000} step={10} digits={0} onCommit={setParam('minFreq')} /></label>
                <label><span>To Hz</span><NumBox value={params.maxFreq} min={1000} max={20000} step={1000} digits={0} onCommit={setParam('maxFreq')} /></label>
              </div>
              <div className="row-gap" style={{ marginTop: 14 }}>
                <button className="btn-primary" onClick={runAutoEq} disabled={!auto.measurement || !auto.target}><Icon name="eq" />{t('Run AutoEQ')}</button>
                {lastFit && <span className="fit-note">{t('Deviation from target {before} → {b} with {n} filters', { before: lastFit.before.toFixed(1), b: <b>{lastFit.after.toFixed(1)} dB</b>, n: lastFit.n })}</span>}
              </div>
            </div>

            <div className="card eq-card">
              <h3><Icon name="clock" />{t('History')}<span className="end muted">{history.stack.length ? `${history.index + 1}/${history.stack.length}` : ''}</span></h3>
              <div className="history">
                {history.stack.map((h, i) => ({ h, i })).reverse().map(({ h, i }) => (
                  <button key={h.ts + '-' + i} className={`${i === history.index ? 'cur' : ''} ${i > history.index ? 'undone' : ''}`} onClick={() => jump(i)}>
                    <span className="dot" />
                    <span className="lbl">{h.label}</span>
                    <span className="ago">{ago(h.ts)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <aside className="card eq-bands">
          <button className="bands-rail" onClick={() => setCollapsed(false)} title={t('Show bands')}>
            <Icon name="panel" /><span>{t('Bands · {length}', { length: bands.length })}</span>
          </button>
          <div className="bands-body">
            <div className="bands-head">
              <b>{t('Bands')}</b><span className="muted">{bands.length}/{MAX_BANDS}</span>
              <span className="end">
                <button className="icon-btn sm" onClick={addBand} disabled={bands.length >= MAX_BANDS} title={t('Add band')}><Icon name="plus" /></button>
                <button className="icon-btn sm" onClick={() => setCollapsed(true)} title={t('Hide bands')}><Icon name="panel" /></button>
              </span>
            </div>
            <div className="preamp-row">
              <Icon name="volume" /><b>{t('Preamp')}</b>
              <NumBox value={preamp} min={-30} max={10} step={0.5} onCommit={setPreampCommit} width={72} />
              <span className="muted">dB</span>
              <button className="btn-ghost sm" onClick={() => setPreampCommit(peak > 0 ? -Math.round(peak * 10) / 10 : 0)} title={t('Just enough to avoid clipping')}>{t('Auto')}</button>
            </div>
            <div className="band-cols"><span>#</span><span>{t('Type')}</span><span>Hz</span><span>dB</span><span>Q</span><span /></div>
            <div className="band-list">
              {bands.map((b, i) => (
                <BandRow key={i} band={b} idx={i} selected={selected === i} onSelect={setSelected} onEdit={onRowEdit} onRemove={onRemove} canRemove={bands.length > 1} />
              ))}
            </div>
          </div>
        </aside>
      </div>

      <Dialog open={showGuide} onClose={() => setShowGuide(false)} title={t('Parametric EQ guide')} icon="eq" width={620}
        actions={<button className="btn-primary" onClick={() => setShowGuide(false)}>{t('Got it')}</button>}>
        <p>{t('Each band has a type (PK peak, LS low shelf, HS high shelf), a frequency, a gain and a Q. Higher Q means a narrower band.')}</p>
        <h4>{t('On the graph')}</h4>
        <ul>
          <li><b>{t('Drag a dot')}</b> {t('to move a band; hold {b} to change only the gain or {b2} to change only the frequency.', { b: <b>{t('Shift')}</b>, b2: <b>{t('Alt')}</b> })}</li>
          <li><b>{t('Scroll on a dot')}</b> {t('to change Q (hold Shift for fine steps). {b} flattens it.', { b: <b>{t('Double-click')}</b> })}</li>
          <li>{t('Changes are heard immediately while you drag.')}</li>
        </ul>
        <h4>AutoEQ</h4>
        <ul>
          <li>{t('Search your headphone or IEM (measurements from the AutoEq project), pick a target sound, then Run AutoEQ.')}</li>
          <li>{t('Not listed? Load a measurement file exported from Squiglink or REW.')}</li>
          <li>{t('The preamp is set so the EQ can\'t clip.')}</li>
        </ul>
        <h4>{t('Files and history')}</h4>
        <ul>
          <li>{t('Import / Export use the Squiglink text format, which EqualizerAPO, Peace and Wavelet also read.')}</li>
          <li>{t('Turn on Separate EQ for each output to keep one correction for your headphones and another for your speakers.')}</li>
          <li>{t('Import also reads Audacity and GraphicEQ curves, and Export can write an Audacity Graphic EQ preset. Curves become up to 31 bands, so they are a close match rather than an exact one.')}</li>
          <li>{t('Every change is kept in History: click an entry, or use Ctrl+Z / Ctrl+Y.')}</li>
        </ul>
        <div style={{ marginTop: 12 }}><Callout tone="info">{t('Default layout: 31 bands at ISO 1/3-octave centres, Q {dEFAULT_Q}', { dEFAULT_Q: DEFAULT_Q })}.</Callout></div>
      </Dialog>
    </div>
  );
};

export default EqSettingsView;
