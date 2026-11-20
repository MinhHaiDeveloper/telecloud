import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { SettingRow, Progress, Callout, confirmDialog } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

const mb = (n) => `${Math.round(n / 1048576)} MB`;

const DESC = {
  get en() { return t('Times every line that is not Japanese: English, Vietnamese, Korean, Spanish and other languages written in letters.'); },
  get ja() { return t('For Japanese songs: reads kana and kanji as they are written.'); },
  get voice() { return t('Optional. Takes the music away first, so words land better under loud music. Without it, songs are timed faster on the full mix.'); },
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
    const ok = await confirmDialog({ title: t('Delete the {title} pack?', { title: p.title }), message: t('This frees {mb}. You can download it again at any time.', { mb: mb(p.size) }), confirmLabel: t('Delete'), danger: true });
    if (ok) ipc.invoke('cadence:delete', p.id);
  };
  const delAll = async () => {
    const ok = await confirmDialog({ title: t('Delete every word-timing pack?'), message: t('This frees {mb}. Lyrics already timed stay as they are.', { mb: mb(st.used) }), confirmLabel: t('Delete all'), danger: true });
    if (ok) ipc.invoke('cadence:delete', 'all');
  };
  const anyInstalled = st.used > 0;

  return (
    <div className="set-sub cadence-models">
      <div className="src-order-head">
        <b>{t('Word timing models')}</b>
        <span>{t('Optional. Lyrics from the sources work as they are without any of these. Cadence works out when each word is sung, on this computer, for lyrics that only have line times: download a pack only if you want that, and delete it whenever you like.')}</span>
      </div>
      {st.packs.map((p) => {
        const live = prog?.pack === p.id ? prog : p.downloading;
        const pct = live ? Math.floor((live.done / live.total) * 100) : 0;
        const state = live ? t('Downloading {pct} % ({mb} of {mb2})', { pct, mb: mb(live.done), mb2: mb(live.total) })
          : p.installed ? t('Downloaded, {mb}', { mb: mb(p.size) })
            : p.outdated ? t('A newer version comes with this TeleCloud: {mb} to download{value}', { mb: mb(p.need), value: p.partial >= 1048576 ? t(' ({mb} done)', { mb: mb(p.partial) }) : '' })
            : p.partial >= 1048576 ? t('Paused at {mb} of {mb2}', { mb: mb(p.partial), mb2: mb(p.size) })
              : t('Not downloaded, {mb}', { mb: mb(p.size) });
        return (
          <div key={p.id} className="cadence-pack">
            <SettingRow
              icon={p.installed ? 'check' : 'download'}
              title={<>{p.title}{p.required && <span className="badge b-local" title={t('Cadence needs this pack before any other')}>{t('Start here')}</span>}</>}
              desc={<>{DESC[p.id]}<br /><span className={p.installed ? 'ok-text' : ''}>{state}</span></>}
            >
              <div className="cadence-actions">
                {live
                  ? <button className="btn-ghost" onClick={() => ipc.invoke('cadence:cancel')}>{t('Cancel')}</button>
                  : !p.installed && <button className="btn-primary sm-btn" disabled={st.busy} onClick={() => ipc.invoke('cadence:download', p.id)}>{p.partial >= 1048576 ? t('Resume') : p.outdated ? t('Update') : t('Download')}</button>}
                {p.present && !live && (
                  <button className="icon-btn sm" title={t('Delete the {title} pack', { title: p.title })} disabled={st.timing} onClick={() => del(p)}><Icon name="trash" /></button>
                )}
              </div>
            </SettingRow>
            {live && <Progress value={pct} />}
            {p.error && <Callout tone="danger">{t('Could not download: {error}', { error: p.error })}</Callout>}
          </div>
        );
      })}
      <div className="cadence-foot">
        <span>{t('{value} Models from the telecloud-models release {tag}: wav2vec2 (Apache-2.0) and Demucs (MIT); their licences are saved next to them.', { value: anyInstalled ? t('Using {mb} on this computer.', { mb: mb(st.used) }) : t('Nothing downloaded.'), tag: st.tag })}</span>
        {anyInstalled && <button className="btn-ghost" disabled={st.busy || st.timing} onClick={delAll}>{t('Delete all')}</button>}
      </div>
    </div>
  );
};

export default CadenceModels;
