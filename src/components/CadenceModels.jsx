import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { SettingRow, Progress, Callout, confirmDialog } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';

const mb = (n) => `${Math.round(n / 1048576)} MB`;

const DESC = {
  en: 'Times every line that is not Japanese: English, Vietnamese, Korean, Spanish and other languages written in letters.',
  ja: 'For Japanese songs: reads kana and kanji as they are written.',
  voice: 'Optional. Takes the music away first, so words land better under loud music. Without it, songs are timed faster on the full mix.',
};

/** Settings → Lyrics: Cadence's model packs, downloaded when wanted and deleted when not */
const CadenceModels = () => {
  const [st, setSt] = useState(null);
  const [prog, setProg] = useState(null); // { pack, done, total }
  useEffect(() => {
    const ipc = window.ipcRenderer;
    ipc.invoke('cadence:models').then(setSt).catch(() => {});
    const onModels = (e, s) => { setSt(s); if (!s.busy) setProg(null); };
    const onProg = (e, p) => setProg(p);
    ipcOn(ipc, 'cadence:models', onModels);
    ipcOn(ipc, 'cadence:progress', onProg);
    return () => { ipcOff(ipc, 'cadence:models', onModels); ipcOff(ipc, 'cadence:progress', onProg); };
  }, []);
  if (!st) return null;
  const ipc = window.ipcRenderer;
  const del = async (p) => {
    const ok = await confirmDialog({ title: `Delete the ${p.title} pack?`, message: `This frees ${mb(p.size)}. You can download it again at any time.`, confirmLabel: 'Delete', danger: true });
    if (ok) ipc.invoke('cadence:delete', p.id);
  };
  const delAll = async () => {
    const ok = await confirmDialog({ title: 'Delete every word-timing pack?', message: `This frees ${mb(st.used)}. Lyrics already timed stay as they are.`, confirmLabel: 'Delete all', danger: true });
    if (ok) ipc.invoke('cadence:delete', 'all');
  };
  const anyInstalled = st.used > 0;

  return (
    <div className="set-sub cadence-models">
      <div className="src-order-head">
        <b>Word timing models</b>
        <span>Optional. Lyrics from the sources work as they are without any of these. Cadence works out when each word is sung, on this computer, for lyrics that only have line times: download a pack only if you want that, and delete it whenever you like.</span>
      </div>
      {st.packs.map((p) => {
        const live = prog?.pack === p.id ? prog : p.downloading;
        const pct = live ? Math.floor((live.done / live.total) * 100) : 0;
        const state = live ? `Downloading ${pct} % (${mb(live.done)} of ${mb(live.total)})`
          : p.installed ? `Downloaded, ${mb(p.size)}`
            : p.outdated ? `A newer version comes with this TeleCloud: ${mb(p.need)} to download${p.partial >= 1048576 ? ` (${mb(p.partial)} done)` : ''}`
            : p.partial >= 1048576 ? `Paused at ${mb(p.partial)} of ${mb(p.size)}`
              : `Not downloaded, ${mb(p.size)}`;
        return (
          <div key={p.id} className="cadence-pack">
            <SettingRow
              icon={p.installed ? 'check' : 'download'}
              title={<>{p.title}{p.required && <span className="badge b-local" title="Cadence needs this pack before any other">Start here</span>}</>}
              desc={<>{DESC[p.id]}<br /><span className={p.installed ? 'ok-text' : ''}>{state}</span></>}
            >
              <div className="cadence-actions">
                {live
                  ? <button className="btn-ghost" onClick={() => ipc.invoke('cadence:cancel')}>Cancel</button>
                  : !p.installed && <button className="btn-primary sm-btn" disabled={st.busy} onClick={() => ipc.invoke('cadence:download', p.id)}>{p.partial >= 1048576 ? 'Resume' : p.outdated ? 'Update' : 'Download'}</button>}
                {p.present && !live && (
                  <button className="icon-btn sm" title={`Delete the ${p.title} pack`} disabled={st.timing} onClick={() => del(p)}><Icon name="trash" /></button>
                )}
              </div>
            </SettingRow>
            {live && <Progress value={pct} />}
            {p.error && <Callout tone="danger">Could not download: {p.error}</Callout>}
          </div>
        );
      })}
      <div className="cadence-foot">
        <span>{anyInstalled ? `Using ${mb(st.used)} on this computer.` : 'Nothing downloaded.'} Models from the telecloud-models release {st.tag}: wav2vec2 (Apache-2.0) and Demucs (MIT); their licences are saved next to them.</span>
        {anyInstalled && <button className="btn-ghost" disabled={st.busy || st.timing} onClick={delAll}>Delete all</button>}
      </div>
    </div>
  );
};

export default CadenceModels;
