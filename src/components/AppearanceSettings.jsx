import React, { useEffect, useState } from 'react';
import LyricsView from './LyricsView';
import { SettingRow, Segmented, Toggle } from './ui';
import { APPEARANCE_DEFAULTS, APPEARANCE_LIMITS, resetAppearance, setAppearance, useAppearance } from '../utils/appearance';

const PREVIEW = ['[00:00.00]This line has already played', '[00:02.00]So has this one', '[00:04.00]Each line takes a turn', '[00:06.00]The one playing stands out', '[00:08.00]The rest wait around it', '[00:10.00]Then it starts again'].join('\n');
const PREVIEW_LOOP = 12;

const Slider = ({ name, value, unit, disabled, label }) => {
  const [lo, hi] = APPEARANCE_LIMITS[name];
  return (
    <div className="appearance-slider">
      <input
        type="range" className="range full" min={lo} max={hi} step={name === 'lyricSpeed' ? 50 : 1} value={value} disabled={disabled} aria-label={label}
        style={{ '--pct': `${((value - lo) / (hi - lo)) * 100}%` }}
        onChange={(e) => setAppearance({ [name]: Number(e.target.value) })}
      />
      <span className="mono">{value}{unit}</span>
    </div>
  );
};

/** A few lines running at the chosen settings, so changes can be judged without opening a track */
const LyricsPreview = () => {
  const [time, setTime] = useState(4);
  useEffect(() => {
    const id = setInterval(() => setTime(t => (t + 2) % PREVIEW_LOOP), 2000);
    return () => clearInterval(id);
  }, []);
  const { lyricSpeed } = useAppearance();
  return <LyricsView lyrics={PREVIEW} currentTime={time + 0.5} className="np-lyrics appearance-preview" scrollMs={lyricSpeed} />;
};

/** Settings → Appearance: the theme, and the extras for the full-screen view */
const AppearanceSettings = ({ theme, setTheme }) => {
  const a = useAppearance();
  const changed = Object.keys(APPEARANCE_DEFAULTS).some(k => a[k] !== APPEARANCE_DEFAULTS[k]);
  return (
    <>
      <section className="set-section">
        <h3>Theme</h3>
        <div className="card set-card">
          <SettingRow icon={theme === 'dark' ? 'moon' : 'sun'} title="Theme" desc="Dark, or the warm vanilla light theme">
            <Segmented value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>Full-screen cover</h3>
        </div>
        <div className="card set-card">
          <SettingRow icon="image" title="Tilt the cover with the mouse" desc="The cover rests on a point at its centre and leans down where the mouse touches it.">
            <Toggle checked={a.coverTilt} onChange={(v) => setAppearance({ coverTilt: v })} />
          </SettingRow>
          <SettingRow icon="image" title="Tilt strength" desc="How far it leans at the edge." muted={!a.coverTilt}>
            <Slider name="tiltStrength" value={a.tiltStrength} unit="°" disabled={!a.coverTilt} label="Tilt strength" />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>Full-screen lyrics</h3>
          <div className="btn-row">
            <button className="btn-ghost sm" onClick={resetAppearance} disabled={!changed}>Reset all</button>
          </div>
        </div>
        <div className="card set-card">
          <div className="set-sub appearance-preview-wrap"><LyricsPreview /></div>
          <SettingRow icon="lyrics" title="Current line size" desc="The line that is playing.">
            <Slider name="lyricCurrent" value={a.lyricCurrent} unit=" px" label="Current line size" />
          </SettingRow>
          <SettingRow icon="lyrics" title="Other lines size" desc="Every line that is not playing.">
            <Slider name="lyricOther" value={a.lyricOther} unit=" px" label="Other lines size" />
          </SettingRow>
          <SettingRow icon="check" title="Glow on the current line" desc="A soft light around the line that is playing.">
            <Toggle checked={a.lyricGlow} onChange={(v) => setAppearance({ lyricGlow: v })} />
          </SettingRow>
          <SettingRow icon="lyrics" title="Alignment">
            <Segmented value={a.lyricAlign} onChange={(v) => setAppearance({ lyricAlign: v })} size="sm" options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
          </SettingRow>
          <SettingRow icon="queue" title="Line change speed" desc="How long the move to the next line takes. Longer feels smoother, shorter keeps up with fast songs.">
            <Slider name="lyricSpeed" value={a.lyricSpeed} unit=" ms" label="Line change speed" />
          </SettingRow>
        </div>
      </section>
    </>
  );
};

export default AppearanceSettings;
