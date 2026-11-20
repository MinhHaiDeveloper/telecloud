import React, { useState } from 'react';
import Icon from './Icon';
import { Dialog, SettingRow, confirmDialog } from './ui';
import { t } from '../i18n';


const Tracks = ({ title, note, rows }) => {
  if (!rows.length) return null;
  return (
    <div className="check-block">
      <b>{title} · {rows.length.toLocaleString()}</b>
      {note && <small>{note}</small>}
      <ul>{rows.slice(0, 200).map(r => <li key={r.path}>{r.title}{r.cached ? t(' (a copy is in the cache here)') : ''}</li>)}</ul>
      {rows.length > 200 && <small>{t('And {value} more.', { value: (rows.length - 200).toLocaleString() })}</small>}
    </div>
  );
};

/** Settings → TeleCloud: compare the library and its index with what is really in the Telegram chats */
const BackupCheck = ({ disabled }) => {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [done, setDone] = useState('');

  const run = async () => {
    setBusy(true);
    setDone('');
    setReport(await window.ipcRenderer.invoke('telecloud-sync:check-backup').catch(err => ({ success: false, error: err.message })));
    setBusy(false);
  };
  const all = (key) => (report?.storages || []).flatMap(s => s[key] || []);
  // a track still in the cache stays: it plays, and removing it would throw away the last copy
  const lost = [...all('missing'), ...all('damaged')].filter(r => !r.hasLocal && !r.cached);
  const fixable = [...all('missing'), ...all('damaged')].filter(r => r.hasLocal);
  const staleIndex = (report?.storages || []).some(s => !s.manifestOk);
  const lostCovers = report?.totals?.coversMissing > 0;

  const repair = async () => {
    setFixing(true);
    const r = await window.ipcRenderer.invoke('telecloud-sync:check-repair', { paths: fixable.map(x => x.path) });
    setFixing(false);
    setDone(r?.success ? [
      r.queued ? t('{count|# track|# tracks} queued for backup again.', { count: r.queued }) : '',
      r.covers ? t('{count|# album cover|# album covers} put back in Telegram.', { count: r.covers }) : '',
      r.coversLeft ? t('{count|# album cover|# album covers} could not be put back: this computer has no copy.', { count: r.coversLeft }) : '',
      r.index ? t('The index was saved.') : '',
      r.queued ? t('Run the check again when the backup finishes.') : '',
    ].filter(Boolean).join(' ') : t('Could not repair: {error}', { error: r?.error }));
    if (r?.success) setReport(x => ({ ...x, repaired: true }));
  };
  const forget = async () => {
    if (!await confirmDialog({ title: t('Remove lost tracks?'), message: t('{count|# track|# tracks} will leave your library. Telegram no longer has a whole copy of them, and this computer has none.', { count: lost.length }), confirmLabel: t('Remove'), danger: true })) return;
    setFixing(true);
    const r = await window.ipcRenderer.invoke('telecloud-sync:remove-from-cloud', { paths: lost.map(x => x.path) });
    setFixing(false);
    if (r?.success) run(); else setDone(t('Could not remove them: {error}', { error: r?.error }));
  };

  const totals = report?.totals;
  const clean = report?.success && !totals.missing && !totals.damaged && !totals.unreadable && !staleIndex && !totals.coversMissing;

  return (
    <>
      <SettingRow icon="check" title={t('Check backup')} desc={t('Compares your library and its index with the files really in Telegram, and reports what is missing or the wrong size. No music is downloaded and nothing is changed.')}>
        <button className="btn-ghost" onClick={run} disabled={disabled || busy}>{busy ? t('Checking…') : t('Check now')}</button>
      </SettingRow>
      {report && (
        <Dialog
          title={!report.success ? t('Could not check the backup') : clean ? t('Your backup looks complete') : t('The check found problems')}
          icon={clean ? 'check' : 'info'}
          tone={!report.success ? 'danger' : undefined}
          width={600}
          onClose={() => setReport(null)}
          actions={(
            <>
              {report.success && lost.length > 0 && !report.repaired && <button className="btn-ghost" onClick={forget} disabled={fixing}>{t('Remove lost tracks')}</button>}
              {report.success && (fixable.length > 0 || staleIndex || lostCovers) && !report.repaired && <button className="btn-primary" onClick={repair} disabled={fixing}>{fixing ? t('Working…') : fixable.length ? t('Back up again from this computer') : lostCovers ? t('Put covers back') : t('Save the index again')}</button>}
              <button className={clean || report.repaired || !report.success ? 'btn-primary' : 'btn-ghost'} onClick={() => setReport(null)}>{t('Close')}</button>
            </>
          )}
        >
          {!report.success ? <p className="check-text">{report.error}</p> : (
            <div className="check-report">
              <p className="check-text">
               {t('Checked {text} in {text2}: {ok} found with the right size. The music itself was not downloaded, so a file with the right size but damaged inside can\'t be noticed here.', { text: t('{n|# track|# tracks}', { n: totals.tracks }), text2: t('{n|# storage|# storages}', { n: report.storages.length }), ok: totals.ok.toLocaleString() })}
              </p>
              {done && <p className="check-text"><Icon name="check" style={{ width: 14, height: 14, verticalAlign: -2 }} /> {done}</p>}
              <Tracks title={t('Missing from Telegram, still on this computer')} note={t('They can be backed up again.')} rows={all('missing').filter(r => r.hasLocal)} />
              <Tracks title={t('Missing from Telegram, not on this computer')} note={t('These copies are gone unless another storage or computer has them.')} rows={all('missing').filter(r => !r.hasLocal)} />
              <Tracks title={t('Wrong size in Telegram, still on this computer')} note={t('The copy in Telegram doesn\'t match. Backing up again replaces it.')} rows={all('damaged').filter(r => r.hasLocal)} />
              <Tracks title={t('Wrong size in Telegram, not on this computer')} note={t('This may not play correctly.')} rows={all('damaged').filter(r => !r.hasLocal)} />
              {report.storages.filter(s => !s.manifestOk).map(s => <div className="check-block" key={s.id}><b>{t('{title}: the library index is {manifestState}', { title: s.title, manifestState: s.manifestState })}</b><small>{t('Another computer would restore tracks without their full tags, lyrics and covers until it is saved again.')}</small></div>)}
              {totals.unreadable > 0 && <div className="check-block"><b>{t('Can\'t be read: {unreadable}', { unreadable: totals.unreadable.toLocaleString() })}</b><small>{t('Encrypted with a different recovery key than the one on this computer.')}</small></div>}
              {totals.coversMissing > 0 && <div className="check-block"><b>{t('Album covers missing from Telegram: {coversMissing}', { coversMissing: totals.coversMissing.toLocaleString() })}</b><small>{t('The music is safe. Other computers restore these albums without a cover until they are put back.')}</small></div>}
              {totals.extra > 0 && <div className="check-block"><b>{t('In Telegram but not in this library: {extra}', { extra: totals.extra.toLocaleString() })}</b><small>{t('Not a problem. They may come from another computer. Restore adds them here.')}</small></div>}
              {totals.indexOnly > 0 && <div className="check-block"><b>{t('In the old index but gone from Telegram, not in this library: {indexOnly}', { indexOnly: totals.indexOnly.toLocaleString() })}</b><small>{t('Saving the index again removes them from it.')}</small></div>}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
};

export default BackupCheck;
