import React, { useContext, useEffect, useRef, useState } from 'react';
import SongActions from './songActions';
import Icon from './Icon';
import { SettingRow, Toggle, Progress } from './ui';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

// Quality check in the background (electron/qualityScan.js): the marks in track lists, the card beside the scan
// card while it runs, and its switch in Settings > Library. It only checks, so it stays small and out of the way.

/** What the mark on a quality badge says (only these verdicts are marked) */
export const flagText = (flag) => ({
  transcoded: t('Likely transcoded from a lossy file'),
  'upsampled-lossy': t('Upsampled from a lossy source'),
  upsampled: t('Upsampled from a lower sample rate'),
  'genuine-padded': t('Padded to a higher bit depth'),
}[flag?.verdict] || '');

/** path → { verdict, level } for the tracks worth a look; follows the background check as it goes */
export function useQualityFlags(ready) {
  const [flags, setFlags] = useState(() => new Map());
  useEffect(() => {
    if (!ready) return undefined;
    const ipc = window.ipcRenderer;
    ipc.invoke('quality:flags').then(list => setFlags(new Map((list || []).map(x => [x.path, x.flag])))).catch(() => {});
    const on = (e, { path, flag }) => setFlags(prev => {
      if (!flag && !prev.has(path)) return prev;
      const next = new Map(prev);
      if (flag) next.set(path, flag); else next.delete(path);
      return next;
    });
    ipcOn(ipc, 'quality:flag', on);
    return () => ipcOff(ipc, 'quality:flag', on);
  }, [ready]);
  return flags;
}

function useQualityStatus() {
  const [status, setStatus] = useState({ state: 'idle' });
  useEffect(() => {
    const on = (e, s) => setStatus(s || { state: 'idle' });
    ipcOn(window.ipcRenderer, 'quality:status', on);
    return () => ipcOff(window.ipcRenderer, 'quality:status', on);
  }, []);
  return status;
}

const waitText = (reason) => ({
  battery: t('Waiting: on battery power'),
  bitperfect: t('Waiting: playing bit-perfect'),
  window: t('Waiting: the Quality check window is analysing'),
  busy: t('Waiting: the computer is busy'),
}[reason] || '');

/**
 * Beside the scan card: a card for a few seconds when a check starts and when it ends; in between, a small
 * pill with the count, which opens the card again when clicked.
 */
export function QualityNotice() {
  const s = useQualityStatus();
  const [open, setOpen] = useState(false);
  const shrink = useRef(null);
  const active = s.state === 'checking' || s.state === 'paused';
  const runKey = active ? s.total : null;
  useEffect(() => {
    if (runKey == null) return undefined;
    setOpen(true);
    shrink.current = setTimeout(() => setOpen(false), 6000);
    return () => clearTimeout(shrink.current);
  }, [runKey]);

  if (s.state === 'done' && !s.stopped) {
    return (
      <div className="card float-card qc-card">
        <div className="row">
          <Icon name="check" style={{ color: 'var(--ok)' }} />
          <div style={{ minWidth: 0 }}>
            <b>{t('Quality check done')}</b>
            <small>{s.flagged
              ? t('{n} {n2|track|tracks} checked, {flagged} worth a look', { n: s.done.toLocaleString(), n2: s.done, flagged: s.flagged.toLocaleString() })
              : t('{n} {n2|track|tracks} checked, nothing worth a look', { n: s.done.toLocaleString(), n2: s.done })}</small>
          </div>
        </div>
      </div>
    );
  }
  if (!active) return null;
  const count = `${s.done.toLocaleString()} / ${s.total.toLocaleString()}`;
  if (!open) {
    return (
      <button className="card float-card qc-pill" onClick={() => setOpen(true)} title={t('Checking track quality')}>
        {s.state === 'paused' ? <Icon name="pause" /> : <span className="ring" />}
        <span>{t('Quality')}</span><span className="mono">{count}</span>
      </button>
    );
  }
  return (
    <div className="card float-card qc-card">
      <div className="row">
        {s.state === 'paused' ? <Icon name="pause" style={{ color: 'var(--text-3)' }} /> : <span className="ring" />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <b>{t('Checking track quality')}</b>
          <small title={t('One track at a time at low priority; it waits on battery, while playing bit-perfect and when the computer is busy.')}>
            {s.state === 'paused' ? waitText(s.reason) : t('{count} · in the background, at low priority', { count })}
          </small>
        </div>
        <button className="icon-btn sm" onClick={() => setOpen(false)} title={t('Make smaller')}><Icon name="shrink" /></button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <div style={{ flex: 1 }}><Progress value={s.total ? (s.done / s.total) * 100 : 0} /></div>
        <button className="btn-ghost" style={{ padding: '4px 10px' }} onClick={() => window.ipcRenderer.invoke('quality:stop')} title={t('Stop for now; it carries on after the next change, or turn it off in Settings > Library')}>{t('Stop')}</button>
      </div>
    </div>
  );
}

/** Settings > Library */
export function QualitySettings() {
  const { qualityBackground, setQualityBackground } = useContext(SongActions);
  const [sum, setSum] = useState(null);
  const status = useQualityStatus();
  useEffect(() => {
    window.ipcRenderer.invoke('quality:summary').then(setSum).catch(() => {});
  }, [qualityBackground, status.state, status.state === 'checking' ? Math.floor((status.done || 0) / 25) : 0]);
  const parts = [];
  if (sum) {
    parts.push(t('{n} checked', { n: sum.checked.toLocaleString() }));
    if (sum.flagged) parts.push(t('{n} worth a look', { n: sum.flagged.toLocaleString() }));
    if (sum.left) parts.push(t('{n} to go', { n: sum.left.toLocaleString() }));
    if (sum.cloud) parts.push(t('{n} in the cloud, checked once played or downloaded', { n: sum.cloud.toLocaleString() }));
  }
  return (
    <section className="set-section">
      <h3>{t('Quality check')}</h3>
      <div className="card set-card">
        <SettingRow icon="spectrum" title={t('Check track quality in the background')} desc={t('Gives every lossless track the Quality check verdict, one at a time at low priority, and marks the quality tag of the ones worth a look (a transcode or an upsample). New tracks are checked after they are added. Lossy, MQA and DSD files are left as they are.')}>
          <Toggle checked={!!qualityBackground} onChange={setQualityBackground} />
        </SettingRow>
        {sum && (qualityBackground || sum.checked > 0) && (
          <SettingRow icon="info" title={parts.join(' · ')} desc={t('Results take a few hundred bytes a track, in the library database. Filter a list by Worth a look to see them.')} muted />
        )}
      </div>
    </section>
  );
}
