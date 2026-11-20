import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t } from '../i18n';

const TEXT = {
  get idle() { return t('Updates are checked automatically when TeleCloud starts.'); },
  get dev() { return t('This is a development build; it does not update itself.'); },
  get checking() { return t('Checking for updates…'); },
  get latest() { return t('You have the latest version.'); },
};

export const useUpdateStatus = () => {
  const [s, setS] = useState({ state: 'idle' });
  useEffect(() => {
    const ipc = window.ipcRenderer;
    ipc.invoke('update:status').then(setS).catch(() => {});
    const on = (e, st) => setS(st);
    ipcOn(ipc, 'update:status', on);
    return () => ipcOff(ipc, 'update:status', on);
  }, []);
  return s;
};

/** Settings → About: version, update state, Check / Restart buttons */
const UpdateStatus = () => {
  const s = useUpdateStatus();
  const ipc = window.ipcRenderer;
  const text = s.state === 'downloading' ? t('Downloading {value}… {value2}%', { value: s.next || t('the update'), value2: s.percent || 0 })
    : s.state === 'ready' ? t('Version {next} is ready. It installs when you restart TeleCloud.', { next: s.next })
      : s.state === 'error' ? t('Could not check for updates: {error}', { error: s.error }) : TEXT[s.state] || TEXT.idle;
  return (
    <div className="update-row">
      <Icon name={s.state === 'ready' ? 'check' : s.state === 'error' ? 'alert' : 'refresh'} className={s.state === 'checking' ? 'spin' : ''} />
      <span>{text}</span>
      {s.state === 'ready'
        ? <button className="btn-primary sm-btn" onClick={() => ipc.invoke('update:install')}>{t('Restart now')}</button>
        : <button className="btn-ghost" onClick={() => ipc.invoke('update:check')} disabled={s.state === 'checking' || s.state === 'downloading'}>{t('Check for updates')}</button>}
    </div>
  );
};

export default UpdateStatus;
