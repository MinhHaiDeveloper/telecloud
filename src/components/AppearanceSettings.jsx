import React, { useEffect, useState } from 'react';
import LyricsView from './LyricsView';
import Icon from './Icon';
import { SettingRow, Segmented, Toggle, Select } from './ui';
import { THEMES } from '../utils/themes';
import { APPEARANCE_DEFAULTS, APPEARANCE_LIMITS, resetAppearance, setAppearance, useAppearance } from '../utils/appearance';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t, LANGUAGES, chosenLanguage, setLanguage } from '../i18n';

// the times stay out of the text, so a translation has only the words
const preview = () => [t('This line has already played'), t('So has this one'), t('Each line takes a turn'), t('The one playing stands out'), t('The rest wait around it'), t('Then it starts again')].map((line, i) => `[00:${String(i * 2).padStart(2, '0')}.00]${line}`).join('\n');
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
    const id = setInterval(() => setTime(value => (value + 2) % PREVIEW_LOOP), 2000);
    return () => clearInterval(id);
  }, []);
  const { lyricSpeed } = useAppearance();
  return <LyricsView lyrics={preview()} currentTime={time + 0.5} className="np-lyrics appearance-preview" scrollMs={lyricSpeed} />;
};

/** The floating lyrics window's switches: open, and locked (clicks go through it) */
const FloatingLyricsRows = () => {
  const [st, setSt] = useState({ open: false, locked: false });
  useEffect(() => {
    const ipc = window.ipcRenderer;
    ipc.invoke('lyrics-float:status').then(s => s && setSt(s)).catch(() => {});
    const on = (e, s) => s && setSt(s);
    ipcOn(ipc, 'lyrics-float:changed', on);
    return () => ipcOff(ipc, 'lyrics-float:changed', on);
  }, []);
  return (
    <>
      <SettingRow icon="pip" title={t('Floating lyrics')} desc={t('A small window over everything else with the line being sung and the next one. Drag it where you like; it remembers. Also from the lyrics card and the tray.')}>
        <Toggle checked={st.open} onChange={(v) => window.ipcRenderer.invoke('lyrics-float:toggle', v)} />
      </SettingRow>
      <SettingRow icon="eye" title={t('Lock floating lyrics')} muted={!st.open} desc={t('Clicks go through it to the window behind, so it never gets in the way. Unlock here or from the tray.')}>
        <Toggle checked={st.locked} onChange={(v) => window.ipcRenderer.invoke('lyrics-float:lock', v)} />
      </SettingRow>
    </>
  );
};

/** Settings → Appearance: the theme, and the extras for the full-screen view */
const AppearanceSettings = ({ theme, setTheme }) => {
  const a = useAppearance();
  const changed = Object.keys(APPEARANCE_DEFAULTS).some(k => a[k] !== APPEARANCE_DEFAULTS[k]);
  return (
    <>
      {LANGUAGES.length > 1 && (
        <section className="set-section">
          <h3>{t('Language')}</h3>
          <div className="card set-card">
            <SettingRow icon="globe" title={t('Language of the app')} desc={t('Text with no translation yet stays in English.')}>
              <Select value={chosenLanguage()} onChange={setLanguage} align="right" options={[{ value: 'auto', label: t('Same as Windows') }, ...LANGUAGES.map(l => ({ value: l.code, label: l.name }))]} />
            </SettingRow>
          </div>
        </section>
      )}
      <section className="set-section">
        <h3>{t('Theme')}</h3>
        <div className="card set-card">
          <div className="theme-grid" role="radiogroup" aria-label={t('Theme')}>
            {THEMES.map(item => (
              <button key={item.id} type="button" role="radio" aria-checked={theme === item.id} className={`theme-card ${theme === item.id ? 'on' : ''}`} onClick={() => setTheme(item.id)}>
                <div className="theme-prev" data-theme={item.id} aria-hidden="true">
                  <div className="side"><i /><i /><i /><i /></div>
                  <div className="main">
                    <div className="top"><i /><span className="pill">{t('Play')}</span></div>
                    <div className="row"><i /><i /></div>
                    <div className="row"><i /><i /></div>
                  </div>
                </div>
                <div className="theme-name">{item.name}{theme === item.id && <Icon name="check" />}</div>
              </button>
            ))}
          </div>
          <SettingRow icon="image" title={t('Follow the cover')} desc={t('The accent colour comes from the cover playing, made lighter or darker so it stays readable. A black and white cover keeps the theme\'s colour.')}>
            <Toggle checked={a.followCover} onChange={(v) => setAppearance({ followCover: v })} />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <h3>{t('Layout and motion')}</h3>
        <div className="card set-card">
          <SettingRow icon="speaker" title={t('Signal path in the side panel')} desc={t('Full shows each step from the file to your output. Compact keeps only the verdict, such as Bit-perfect. The player bar still has the full path.')}>
            <Segmented size="sm" value={a.signalPath} onChange={(v) => setAppearance({ signalPath: v })} options={[{ value: 'full', label: t('Full') }, { value: 'compact', label: t('Compact') }, { value: 'off', label: t('Off') }]} />
          </SettingRow>
          <FloatingLyricsRows />
          <SettingRow icon="spectrum" title={t('Waveform seek bar')} desc={t('The track\'s loudness over time behind the seek bar, worked out once per file. TeleCloud tracks get theirs once they are cached.')}>
            <Toggle checked={a.waveSeek} onChange={(v) => setAppearance({ waveSeek: v })} />
          </SettingRow>
          <SettingRow icon="check" title={t('Reduce motion')} desc={t('Buttons, pages, menus and highlights change at once instead of moving or bouncing. Lyrics still scroll, and loading spinners still turn.')}>
            <Toggle checked={a.reduceMotion} onChange={(v) => setAppearance({ reduceMotion: v })} />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>{t('Full-screen cover')}</h3>
        </div>
        <div className="card set-card">
          <SettingRow icon="image" title={t('Tilt the cover with the mouse')} desc={t('The cover rests on a point at its centre and leans down where the mouse touches it.')}>
            <Toggle checked={a.coverTilt} onChange={(v) => setAppearance({ coverTilt: v })} />
          </SettingRow>
          <SettingRow icon="image" title={t('Tilt strength')} desc={t('How far it leans at the edge.')} muted={!a.coverTilt}>
            <Slider name="tiltStrength" value={a.tiltStrength} unit="°" disabled={!a.coverTilt} label={t('Tilt strength')} />
          </SettingRow>
        </div>
      </section>

      <section className="set-section">
        <div className="head-row">
          <h3>{t('Full-screen lyrics')}</h3>
          <div className="btn-row">
            <button className="btn-ghost sm" onClick={resetAppearance} disabled={!changed}>{t('Reset all')}</button>
          </div>
        </div>
        <div className="card set-card">
          <div className="set-sub appearance-preview-wrap"><LyricsPreview /></div>
          <SettingRow icon="lyrics" title={t('Current line size')} desc={t('The line that is playing.')}>
            <Slider name="lyricCurrent" value={a.lyricCurrent} unit=" px" label={t('Current line size')} />
          </SettingRow>
          <SettingRow icon="lyrics" title={t('Other lines size')} desc={t('Every line that is not playing.')}>
            <Slider name="lyricOther" value={a.lyricOther} unit=" px" label={t('Other lines size')} />
          </SettingRow>
          <SettingRow icon="check" title={t('Glow on the current line')} desc={t('A soft light around the line that is playing.')}>
            <Toggle checked={a.lyricGlow} onChange={(v) => setAppearance({ lyricGlow: v })} />
          </SettingRow>
          <SettingRow icon="lyrics" title={t('Alignment')}>
            <Segmented value={a.lyricAlign} onChange={(v) => setAppearance({ lyricAlign: v })} size="sm" options={[{ value: 'left', label: t('Left') }, { value: 'center', label: t('Center') }, { value: 'right', label: t('Right') }]} />
          </SettingRow>
          <SettingRow icon="queue" title={t('Line change speed')} desc={t('How long the move to the next line takes. Longer feels smoother, shorter keeps up with fast songs.')}>
            <Slider name="lyricSpeed" value={a.lyricSpeed} unit=" ms" label={t('Line change speed')} />
          </SettingRow>
        </div>
      </section>
    </>
  );
};

export default AppearanceSettings;
