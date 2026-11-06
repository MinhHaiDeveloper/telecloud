import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle, Segmented, Callout, confirmDialog } from './ui';
import { formatBytes } from '../utils/audio';

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
    if (await confirmDialog({ title: 'Delete the log?', message: 'Everything recorded so far is removed from this computer. Logging carries on from here.', confirmLabel: 'Delete', danger: true })) {
      await window.ipcRenderer.invoke('logs:clear');
      setResult(null);
      refresh();
    }
  };
  return (
    <section className="set-section">
      <div className="head-row">
        <h3>Logs</h3>
        <div className="btn-row"><button className="btn-ghost sm" onClick={clear}>Delete log</button></div>
      </div>
      <div className="card set-card">
        <SettingRow icon="lyrics" title="Save the log" desc={`When something goes wrong, send this with your report. It stays on this computer until you send it yourself. Using ${formatBytes(info.bytes)}, oldest kept ${info.oldest || 'today'} (up to ${info.keepDays} days).`}>
          <button className="btn-primary" onClick={save} disabled={busy || (range === 'dates' && (!from || !to || from > to))}>{busy ? 'Saving…' : 'Save as .zip'}</button>
        </SettingRow>
        <SettingRow icon="clock" title="How far back">
          <Segmented value={range} onChange={setRange} size="sm" options={[{ value: '1', label: '1 day' }, { value: '3', label: '3 days' }, { value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: 'dates', label: 'Dates' }]} />
        </SettingRow>
        {range === 'dates' && (
          <SettingRow icon="clock" title="From and to">
            <div className="logs-dates">
              <input className="input" type="date" value={from} max={today()} aria-label="From" onChange={(e) => setFrom(e.target.value)} />
              <input className="input" type="date" value={to} max={today()} aria-label="To" onChange={(e) => setTo(e.target.value)} />
            </div>
          </SettingRow>
        )}
        <SettingRow icon="music" title="Include music names" desc="Off: titles, artists, albums and file paths are replaced with placeholders. On: helps when the problem is with one particular file. Passwords, keys and your Telegram session are never included.">
          <Toggle checked={includeNames} onChange={setIncludeNames} />
        </SettingRow>
        <SettingRow icon="info" title="Detailed logging" desc="Records much more, for tracking down a hard problem. Turns itself off when the app restarts.">
          <Toggle checked={info.verbose} onChange={async (v) => { const on = await window.ipcRenderer.invoke('logs:set-verbose', v); setInfo(i => ({ ...i, verbose: on })); }} />
        </SettingRow>
      </div>
      {result?.success && (
        <Callout tone="ok">
          Saved with {result.lines.toLocaleString()} log lines ({formatBytes(result.bytes)}).{' '}
          {result.missingBefore && `The log only goes back to ${result.missingBefore}. `}
          If you post it publicly, check it first. <button className="link-btn" onClick={() => window.ipcRenderer.invoke('logs:reveal')}>Show in folder</button>
        </Callout>
      )}
      {result && !result.success && <Callout tone="danger">Could not save the log: {result.error}</Callout>}
    </section>
  );
};

export default LogsSettings;
