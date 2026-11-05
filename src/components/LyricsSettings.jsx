import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { SettingRow, Toggle, Segmented } from './ui';

/** The ordered list of sources: tick to use one, arrows to change the order */
export const SourceOrder = ({ o, set }) => {
  const move = (i, d) => {
    const order = [...o.order];
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    set({ order });
  };
  const toggleSource = (id) => set({ disabled: o.disabled.includes(id) ? o.disabled.filter(x => x !== id) : [...o.disabled, id] });
  return (
    <div className="set-sub">
      <div className="src-order-head"><b>Sources</b><span>Searched from top to bottom; the first good match wins.</span></div>
      <ol className="src-order">
        {o.order.map((id, i) => {
          const src = o.sources[id] || { label: id };
          const on = !o.disabled.includes(id);
          return (
            <li key={id} className={on ? '' : 'off'}>
              <span className="n mono">{i + 1}</span>
              <label className="src-name">
                <input type="checkbox" checked={on} onChange={() => toggleSource(id)} />
                <b>{src.label}</b>
                {src.online ? <span className="badge b-cloud">Online</span> : <span className="badge b-local">On this computer</span>}
                {src.note && <small>{src.note}</small>}
              </label>
              <button className="icon-btn sm" onClick={() => move(i, -1)} disabled={i === 0} title="Move up"><Icon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button>
              <button className="icon-btn sm" onClick={() => move(i, 1)} disabled={i === o.order.length - 1} title="Move down"><Icon name="chevron" /></button>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

/** Settings → General → Lyrics: online search on/off, where to save, and the ordered list of sources */
const LyricsSettings = () => {
  const [o, setO] = useState(null);
  useEffect(() => { window.ipcRenderer.invoke('lyrics:options').then(setO); }, []);
  if (!o) return null;
  const set = (patch) => {
    const next = { ...o, ...patch };
    setO(next);
    const { sources, ...save } = next; // eslint-disable-line no-unused-vars
    window.ipcRenderer.invoke('lyrics:set-options', save);
  };

  return (
    <section className="set-section">
      <h3>Lyrics</h3>
      <div className="card set-card">
        <SettingRow icon="search" title="Search online for missing lyrics" desc="When a track without lyrics plays, ask the sources below. Off: only the file's tags and .lrc files are used.">
          <Toggle checked={o.search} onChange={(v) => set({ search: v })} />
        </SettingRow>
        <SettingRow icon="check" title="Save found lyrics automatically" desc="Off: found lyrics are shown first and saved only when you press Save.">
          <Toggle checked={o.autoSave} onChange={(v) => set({ autoSave: v })} disabled={!o.search} />
        </SettingRow>
        <SettingRow icon="lyrics" title="Save lyrics to" desc="Tag: inside the file (LYRICS). .lrc: a file with the same name next to the track, read by most players.">
          <Segmented value={o.saveTo} onChange={(v) => set({ saveTo: v })} size="sm" options={[{ value: 'tag', label: 'Tag' }, { value: 'lrc', label: '.lrc file' }, { value: 'both', label: 'Both' }]} />
        </SettingRow>
        <SourceOrder o={o} set={set} />
      </div>
    </section>
  );
};

export default LyricsSettings;
