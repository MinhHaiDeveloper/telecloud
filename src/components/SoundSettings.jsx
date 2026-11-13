import React, { useContext, useEffect, useState } from 'react';
import SongActions from './songActions';
import Icon from './Icon';
import { SettingRow, Segmented, Select, Toggle, Callout, alertDialog } from './ui';

/**
 * A slider with a resting point (0 dB, 100%): colour runs from there to the thumb, the value rides
 * above it, and a double-click goes back. Live ones are heard while you drag; the others when you let go.
 */
export const Dial = ({ value, min, max, step = 0.5, origin = 0, left, right, format, onChange, live = true, label }) => {
  const [draft, setDraft] = useState(null);
  const v = draft ?? value;
  const f = (x) => (x - min) / (max - min);
  const done = () => { if (draft !== null) { if (!live) onChange(draft); setDraft(null); } };
  return (
    <div className="dial" style={{ '--f': f(v), '--o': f(origin) }}>
      <span className="dial-side">{left}</span>
      <div className="dial-track">
        <span className="dial-value mono">{format(v)}</span>
        <input type="range" min={min} max={max} step={step} value={v} aria-label={label} title="Double-click to reset"
          onChange={(e) => { const n = Number(e.target.value); setDraft(n); if (live) onChange(n); }}
          onDoubleClick={() => { setDraft(null); onChange(origin); }}
          onPointerUp={done} onKeyUp={done} onBlur={done} />
      </div>
      <span className="dial-side">{right}</span>
    </div>
  );
};

const db = (x) => (x === 0 ? '0 dB' : `${x > 0 ? '+' : ''}${x} dB`);

/** A small picture of a correction curve */
const CurvePreview = ({ points }) => {
  if (!points?.length) return null;
  const W = 220, H = 56, lo = Math.log(20), hi = Math.log(20000);
  const max = Math.max(6, ...points.map(([, g]) => Math.abs(g)));
  const d = points.map(([f, g], i) => `${i ? 'L' : 'M'}${(((Math.log(f) - lo) / (hi - lo)) * W).toFixed(1)},${(H / 2 - (g / max) * (H / 2 - 4)).toFixed(1)}`).join(' ');
  return (
    <svg className="curve-preview" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} />
      <path d={d} />
    </svg>
  );
};

/** Settings → Sound: the EQ, tone, space, effects, correction, headroom and A/B */
const SoundSettings = () => {
  const { snd, eq, clipping, openEq, soundExclusive: exclusive } = useContext(SongActions);
  const { sound: s, set, reset, ab, setAb, curve } = snd;
  const [loading, setLoading] = useState(false);
  useEffect(() => () => setAb(false), [setAb]); // A/B is for listening here: leaving puts the sound back

  const loadCorrection = async () => {
    setLoading(true);
    try {
      const r = await window.ipcRenderer.invoke('sound:load-correction');
      if (r?.error) alertDialog({ title: 'Could not use that file', message: r.error, tone: 'warn' });
      else if (r?.points) set({ correction: { name: r.name, kind: r.kind, rate: r.rate || null, taps: r.taps || null, points: r.points } });
    } finally { setLoading(false); }
  };

  return (
    <>
      <section className="set-section">
        <div className="head-row">
          <h3>Equalizer</h3>
        </div>
        <div className="card set-card">
          <SettingRow icon="eq" title="Parametric EQ & AutoEQ" desc={`Up to 31 bands, with matching to a target for your headphones. ${eq.enabled ? `On, ${eq.bands.filter(b => b.gain).length} bands in use.` : 'Off.'}`}>
            <Toggle checked={eq.enabled} onChange={eq.setEnabled} />
            <button className="btn-primary" onClick={openEq}>Open EQ</button>
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>Tone</h3>
          <button className="btn-ghost sm" onClick={() => set({ warmth: 0, bass: 0, treble: 0, loudness: false })}><Icon name="refresh" />Flat</button>
        </div>
        <div className="card set-card">
          <SettingRow icon="sun" title="Warmth" desc="One slider for the whole balance: warm lifts the lows and softens the highs, bright does the opposite. It turns around 1 kHz.">
            <Dial label="Warmth" value={s.warmth} min={-6} max={6} origin={0} left="Bright" right="Warm" format={(x) => (x === 0 ? 'Neutral' : `${x > 0 ? 'Warm' : 'Bright'} ${Math.abs(x)} dB`)} onChange={(v) => set({ warmth: v })} />
          </SettingRow>
          <SettingRow icon="volume" title="Bass" desc="Below about 100 Hz.">
            <Dial label="Bass" value={s.bass} min={-12} max={12} origin={0} format={db} onChange={(v) => set({ bass: v })} />
          </SettingRow>
          <SettingRow icon="volume" title="Treble" desc="Above about 8 kHz.">
            <Dial label="Treble" value={s.treble} min={-12} max={12} origin={0} format={db} onChange={(v) => set({ treble: v })} />
          </SettingRow>
          <SettingRow icon="volume" title="Loudness" muted={exclusive}
            desc={exclusive
              ? 'Works with the volume in TeleCloud, so not in WASAPI Exclusive, where the volume stays at 100%.'
              : 'At low volume the ear hears less bass and treble. This brings them back as you turn TeleCloud down, and does nothing at full volume.'}>
            <Toggle checked={s.loudness} onChange={(v) => set({ loudness: v })} />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>Space</h3>
        </div>
        <div className="card set-card">
          <SettingRow icon="speaker" title="Stereo width" desc="Narrower towards mono, or wider than the recording. Balance and headphone crossfeed are in Playback.">
            <Dial label="Stereo width" value={s.width} min={0} max={200} step={5} origin={100} left="Mono" right="Wide" format={(x) => `${x}%`} onChange={(v) => set({ width: v })} />
          </SettingRow>
          <SettingRow icon="speaker" title="Channels" desc="Mono for one ear or one speaker. Swap when left and right are the wrong way round.">
            <Segmented size="sm" value={s.channels} onChange={(v) => set({ channels: v })} options={[{ value: 'normal', label: 'Normal' }, { value: 'mono', label: 'Mono' }, { value: 'swap', label: 'Swap L/R' }]} />
          </SettingRow>
          <SettingRow icon="speaker" title="Polarity" desc="Turns a channel upside down, for a speaker wired the wrong way round. Inverting both is a listening test: some hear a difference, most don't.">
            <Select value={s.polarity} onChange={(v) => set({ polarity: v })} align="right" options={[{ value: 'normal', label: 'Normal' }, { value: 'left', label: 'Invert left' }, { value: 'right', label: 'Invert right' }, { value: 'both', label: 'Invert both' }]} />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>Effects</h3>
        </div>
        <div className="card set-card">
          <SettingRow icon="moon" title="Night mode" desc="Quiet passages come up and loud ones go down, so late listening doesn't need a hand on the volume.">
            <Segmented size="sm" value={s.night} onChange={(v) => set({ night: v })} options={[{ value: 'off', label: 'Off' }, { value: 'light', label: 'Light' }, { value: 'strong', label: 'Strong' }]} />
          </SettingRow>
          <SettingRow icon="spectrum" title="Air" desc="A touch of shine above 6 kHz, from harmonics rather than a plain boost.">
            <Dial label="Air" value={s.air} min={0} max={100} step={5} origin={0} format={(x) => (x ? `${x}%` : 'Off')} onChange={(v) => set({ air: v })} />
          </SettingRow>
          <SettingRow icon="eq" title="Tube warmth" desc="Soft even harmonics, as a valve amplifier adds. It colours the sound: start low. Heard when you let go of the slider.">
            <Dial label="Tube warmth" value={s.tube} min={0} max={100} step={5} origin={0} live={false} format={(x) => (x ? `${x}%` : 'Off')} onChange={(v) => set({ tube: v })} />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>Room or headphone correction</h3>
        </div>
        <div className="card set-card">
          <SettingRow icon="upload" title={s.correction ? s.correction.name : 'Correction from a file'}
            desc={s.correction
              ? `${s.correction.kind === 'ir' ? `Impulse response, ${s.correction.taps?.toLocaleString()} samples at ${s.correction.rate?.toLocaleString()} Hz` : 'Frequency curve'}, played as its frequency response.`
              : 'An impulse response (WAV) from REW, Dirac or a headphone tool, or a text file of frequency and gain. Its frequency response is applied; the level of the middle stays where it is.'}>
            {s.correction && <CurvePreview points={s.correction.points} />}
            {s.correction && <button className="btn-ghost" onClick={() => set({ correction: null })}>Remove</button>}
            <button className="btn-ghost" onClick={loadCorrection} disabled={loading}><Icon name="folder" />{s.correction ? 'Change' : 'Load file'}</button>
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>Headroom and comparing</h3>
          <button className="btn-ghost sm" onClick={reset}><Icon name="refresh" />Reset all</button>
        </div>
        {clipping && <Callout tone="warn">The sound is going over 0 dBFS and clips: the light in the signal path blinks red. Lower a boost, or turn on Prevent clipping.</Callout>}
        <div className="card set-card">
          <SettingRow icon="alert" title="Prevent clipping" desc={`Lowers the level by the biggest boost of the EQ, tone and correction, so they can't push the sound over 0 dBFS. ${curve.guard ? `Now ${curve.guard} dB.` : 'Nothing to lower now.'} Width, Air, Tube and Night mode can still clip: the signal path light blinks red when that happens.`}>
            <Toggle checked={s.autoHeadroom} onChange={(v) => set({ autoHeadroom: v })} />
          </SettingRow>
          <SettingRow icon="headphones" title="A/B: hear the original" desc={`Without the EQ and these settings, at the same loudness${Math.abs(curve.loudness) >= 0.1 ? ` (${curve.loudness > 0 ? '+' : ''}${curve.loudness.toFixed(1)} dB)` : ''}, because louder always sounds better. Comes back on when you leave this page.`}>
            <button className={`btn-ab ${ab ? 'on' : ''}`} onClick={() => setAb(!ab)} aria-pressed={ab}>
              <b className={ab ? '' : 'on'}>A</b><span>Processed</span><i />
              <b className={ab ? 'on' : ''}>B</b><span>Original</span>
            </button>
          </SettingRow>
        </div>
      </section>
    </>
  );
};

export default SoundSettings;
