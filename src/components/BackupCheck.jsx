import React, { useState } from 'react';
import Icon from './Icon';
import { Dialog, SettingRow, confirmDialog } from './ui';

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const Tracks = ({ title, note, rows }) => {
  if (!rows.length) return null;
  return (
    <div className="check-block">
      <b>{title} · {rows.length.toLocaleString()}</b>
      {note && <small>{note}</small>}
      <ul>{rows.slice(0, 200).map(r => <li key={r.path}>{r.title}{r.cached ? ' (a copy is in the cache here)' : ''}</li>)}</ul>
      {rows.length > 200 && <small>And {(rows.length - 200).toLocaleString()} more.</small>}
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
      r.queued ? `${plural(r.queued, 'track')} queued for backup again.` : '',
      r.covers ? `${plural(r.covers, 'album cover')} put back in Telegram.` : '',
      r.coversLeft ? `${plural(r.coversLeft, 'album cover')} could not be put back: this computer has no copy.` : '',
      r.index ? 'The index was saved.' : '',
      r.queued ? 'Run the check again when the backup finishes.' : '',
    ].filter(Boolean).join(' ') : `Could not repair: ${r?.error}`);
    if (r?.success) setReport(x => ({ ...x, repaired: true }));
  };
  const forget = async () => {
    if (!await confirmDialog({ title: 'Remove lost tracks?', message: `${plural(lost.length, 'track')} will leave your library. Telegram no longer has a whole copy of them, and this computer has none.`, confirmLabel: 'Remove', danger: true })) return;
    setFixing(true);
    const r = await window.ipcRenderer.invoke('telecloud-sync:remove-from-cloud', { paths: lost.map(x => x.path) });
    setFixing(false);
    if (r?.success) run(); else setDone(`Could not remove them: ${r?.error}`);
  };

  const t = report?.totals;
  const clean = report?.success && !t.missing && !t.damaged && !t.unreadable && !staleIndex && !t.coversMissing;

  return (
    <>
      <SettingRow icon="check" title="Check backup" desc="Compares your library and its index with the files really in Telegram, and reports what is missing or the wrong size. No music is downloaded and nothing is changed.">
        <button className="btn-ghost" onClick={run} disabled={disabled || busy}>{busy ? 'Checking…' : 'Check now'}</button>
      </SettingRow>
      {report && (
        <Dialog
          title={!report.success ? 'Could not check the backup' : clean ? 'Your backup looks complete' : 'The check found problems'}
          icon={clean ? 'check' : 'info'}
          tone={!report.success ? 'danger' : undefined}
          width={600}
          onClose={() => setReport(null)}
          actions={(
            <>
              {report.success && lost.length > 0 && !report.repaired && <button className="btn-ghost" onClick={forget} disabled={fixing}>Remove lost tracks</button>}
              {report.success && (fixable.length > 0 || staleIndex || lostCovers) && !report.repaired && <button className="btn-primary" onClick={repair} disabled={fixing}>{fixing ? 'Working…' : fixable.length ? 'Back up again from this computer' : lostCovers ? 'Put covers back' : 'Save the index again'}</button>}
              <button className={clean || report.repaired || !report.success ? 'btn-primary' : 'btn-ghost'} onClick={() => setReport(null)}>Close</button>
            </>
          )}
        >
          {!report.success ? <p className="check-text">{report.error}</p> : (
            <div className="check-report">
              <p className="check-text">
                Checked {plural(t.tracks, 'track')} in {plural(report.storages.length, 'storage')}: {t.ok.toLocaleString()} found with the right size.
                {' '}The music itself was not downloaded, so a file with the right size but damaged inside can't be noticed here.
              </p>
              {done && <p className="check-text"><Icon name="check" style={{ width: 14, height: 14, verticalAlign: -2 }} /> {done}</p>}
              <Tracks title="Missing from Telegram, still on this computer" note="They can be backed up again." rows={all('missing').filter(r => r.hasLocal)} />
              <Tracks title="Missing from Telegram, not on this computer" note="These copies are gone unless another storage or computer has them." rows={all('missing').filter(r => !r.hasLocal)} />
              <Tracks title="Wrong size in Telegram, still on this computer" note="The copy in Telegram doesn't match. Backing up again replaces it." rows={all('damaged').filter(r => r.hasLocal)} />
              <Tracks title="Wrong size in Telegram, not on this computer" note="This may not play correctly." rows={all('damaged').filter(r => !r.hasLocal)} />
              {report.storages.filter(s => !s.manifestOk).map(s => <div className="check-block" key={s.id}><b>{s.title}: the library index is {s.manifestState}</b><small>Another computer would restore tracks without their full tags, lyrics and covers until it is saved again.</small></div>)}
              {t.unreadable > 0 && <div className="check-block"><b>Can't be read: {t.unreadable.toLocaleString()}</b><small>Encrypted with a different recovery key than the one on this computer.</small></div>}
              {t.coversMissing > 0 && <div className="check-block"><b>Album covers missing from Telegram: {t.coversMissing.toLocaleString()}</b><small>The music is safe. Other computers restore these albums without a cover until they are put back.</small></div>}
              {t.extra > 0 && <div className="check-block"><b>In Telegram but not in this library: {t.extra.toLocaleString()}</b><small>Not a problem. They may come from another computer. Restore adds them here.</small></div>}
              {t.indexOnly > 0 && <div className="check-block"><b>In the old index but gone from Telegram, not in this library: {t.indexOnly.toLocaleString()}</b><small>Saving the index again removes them from it.</small></div>}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
};

export default BackupCheck;
