import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle, Segmented } from './ui';
import { SourceOrder } from './LyricsSettings';

/** Settings → General → Album covers: same controls as Lyrics */
const CoverSettings = () => {
  const [o, setO] = useState(null);
  useEffect(() => { window.ipcRenderer.invoke('covers:options').then(setO); }, []);
  if (!o) return null;
  const set = (patch) => {
    const next = { ...o, ...patch };
    setO(next);
    const { sources, ...save } = next; // eslint-disable-line no-unused-vars
    window.ipcRenderer.invoke('covers:set-options', save);
  };
  return (
    <section className="set-section">
      <h3>Album covers</h3>
      <div className="card set-card">
        <SettingRow icon="search" title="Search online for missing covers" desc="When a track without a cover plays, ask the sources below. Off: only the file's tags and pictures in its folder are used.">
          <Toggle checked={o.search} onChange={(v) => set({ search: v })} />
        </SettingRow>
        <SettingRow icon="check" title="Save found covers automatically" desc="Off: a found cover is shown first and saved only when you press Save.">
          <Toggle checked={o.autoSave} onChange={(v) => set({ autoSave: v })} disabled={!o.search} />
        </SettingRow>
        <SettingRow icon="image" title="Save covers to" desc="cover.jpg: a picture in the album's folder, read by most players. Music files stay untouched, unless a track already has a picture inside: that one is replaced too. Tag: inside every track.">
          <Segmented value={o.saveTo} onChange={(v) => set({ saveTo: v })} size="sm" options={[{ value: 'file', label: 'cover.jpg' }, { value: 'tag', label: 'Tag' }, { value: 'both', label: 'Both' }]} />
        </SettingRow>
        <SourceOrder o={o} set={set} />
      </div>
    </section>
  );
};

export default CoverSettings;
