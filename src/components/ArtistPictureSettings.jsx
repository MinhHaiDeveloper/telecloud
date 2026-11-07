import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';
import { SourceOrder } from './LyricsSettings';

/** Settings → General → Artist pictures: same controls as Lyrics and Album covers */
const ArtistPictureSettings = () => {
  const [o, setO] = useState(null);
  useEffect(() => { window.ipcRenderer.invoke('artists:options').then(setO); }, []);
  if (!o) return null;
  const set = (patch) => {
    const next = { ...o, ...patch };
    setO(next);
    const { sources, ...save } = next; // eslint-disable-line no-unused-vars
    window.ipcRenderer.invoke('artists:set-options', save);
  };
  return (
    <section className="set-section">
      <h3>Artist pictures</h3>
      <div className="card set-card">
        <SettingRow icon="search" title="Search online for missing pictures" desc="When you open an artist without a picture, ask the sources below for one with exactly that name. Off: only tags and artist.jpg next to the tracks are used.">
          <Toggle checked={o.search} onChange={(v) => set({ search: v })} />
        </SettingRow>
        <SettingRow icon="check" title="Save found pictures automatically" desc="Off: a found picture is shown first and saved only when you press Save. Saving writes to the tags of all the artist's own tracks, and backed-up files that change are uploaded again.">
          <Toggle checked={o.autoSave} onChange={(v) => set({ autoSave: v })} disabled={!o.search} />
        </SettingRow>
        <SourceOrder o={o} set={set} />
      </div>
    </section>
  );
};

export default ArtistPictureSettings;
