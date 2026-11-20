import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle, Segmented, Callout, confirmDialog } from './ui';
import { formatBytes } from '../utils/audio';
import { t } from '../i18n';

const today = () => new Date().toLocaleDateString('en-CA');

/** Settings → About: save the log as a .zip to send when something goes wrong */
const LogsSettings = () => {
  const [info, setInfo] = useState(null);
  const [range, setRange] = useState('3');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [includeNames, setIncludeNames] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const refresh = () => window.ipcRenderer.invoke('logs:info').then(setInfo).catch(() => {});
  useEffect(() => { refresh(); }, []);
  if (!info) return null;
  const save = async () => {
    setBusy(true);
    setResult(null);
    const opts = range === 'dates' ? { from, to, includeNames } : { days: Number(range), includeNames };
    const r = await window.ipcRenderer.invoke('logs:export', opts);
    setBusy(false);
    if (!r?.canceled) setResult(r);
    refresh();
  };
  const clear = async () => {
    if (await confirmDialog({ title: t('Delete the log?'), message: t('Everything recorded so far is removed from this computer. Logging carries on from here.'), confirmLabel: t('Delete'), danger: true })) {
      await window.ipcRenderer.invoke('logs:clear');
      setResult(null);
      refresh();
    }
  };
  return (
    <section className="set-section">
      <div className="head-row">
        <h3>{t('Logs')}</h3>
        <div className="btn-row"><button className="btn-ghost sm" onClick={clear}>{t('Delete log')}</button></div>
      </div>
      <div className="card set-card">
        <SettingRow icon="lyrics" title={t('Save the log')} desc={t('When something goes wrong, send this with your report. It stays on this computer until you send it yourself. Using {bytes}, oldest kept {value} (up to {keepDays} days).', { bytes: formatBytes(info.bytes), value: info.oldest || t('today'), keepDays: info.keepDays })}>
          <button className="btn-primary" onClick={save} disabled={busy || (range === 'dates' && (!from || !to || from > to))}>{busy ? t('Saving…') : t('Save as .zip')}</button>
        </SettingRow>
        <SettingRow icon="clock" title={t('How far back')}>
          <Segmented value={range} onChange={setRange} size="sm" options={[{ value: '1', label: t('1 day') }, { value: '3', label: t('3 days') }, { value: '7', label: t('7 days') }, { value: '14', label: t('14 days') }, { value: 'dates', label: t('Dates') }]} />
        </SettingRow>
        {range === 'dates' && (
          <SettingRow icon="clock" title={t('From and to')}>
            <div className="logs-dates">
              <input className="input" type="date" value={from} max={today()} aria-label={t('From')} onChange={(e) => setFrom(e.target.value)} />
              <input className="input" type="date" value={to} max={today()} aria-label="To" onChange={(e) => setTo(e.target.value)} />
            </div>
          </SettingRow>
        )}
        <SettingRow icon="music" title={t('Include music names')} desc={t('Off: titles, artists, albums and file paths are replaced with placeholders. On: helps when the problem is with one particular file. Passwords, keys and your Telegram session are never included.')}>
          <Toggle checked={includeNames} onChange={setIncludeNames} />
        </SettingRow>
        <SettingRow icon="info" title={t('Detailed logging')} desc={t('Records much more, for tracking down a hard problem. Turns itself off when the app restarts.')}>
          <Toggle checked={info.verbose} onChange={async (v) => { const on = await window.ipcRenderer.invoke('logs:set-verbose', v); setInfo(i => ({ ...i, verbose: on })); }} />
        </SettingRow>
      </div>
      {result?.success && (
        <Callout tone="ok">
         {t('Saved with {lines} log lines ({bytes}). {value}If you post it publicly, check it first.', { lines: result.lines.toLocaleString(), bytes: formatBytes(result.bytes), value: result.missingBefore && t('The log only goes back to {missingBefore}. ', { missingBefore: result.missingBefore }) })} <button className="link-btn" onClick={() => window.ipcRenderer.invoke('logs:reveal')}>{t('Show in folder')}</button>
        </Callout>
      )}
      {result && !result.success && <Callout tone="danger">{t('Could not save the log: {error}', { error: result.error })}</Callout>}
    </section>
  );
};

export default LogsSettings;
