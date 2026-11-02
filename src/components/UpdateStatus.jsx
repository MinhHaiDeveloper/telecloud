import React, { useEffect, useState } from 'react';
import Icon from './Icon';

const TEXT = {
  idle: 'Updates are checked automatically when TeleCloud starts.',
  dev: 'This is a development build; it does not update itself.',
  checking: 'Checking for updates…',
  latest: 'You have the latest version.',
};

export const useUpdateStatus = () => {
  const [s, setS] = useState({ state: 'idle' });
  useEffect(() => {
    const ipc = window.ipcRenderer;
    ipc.invoke('update:status').then(setS).catch(() => {});
    const on = (e, st) => setS(st);
    ipc.on('update:status', on);
    return () => ipc.removeListener?.('update:status', on);
  }, []);
  return s;
};

/** Settings → About: version, update state, Check / Restart buttons */
const UpdateStatus = () => {
  const s = useUpdateStatus();
  const ipc = window.ipcRenderer;
  const text = s.state === 'downloading' ? `Downloading ${s.next || 'the update'}… ${s.percent || 0}%`
    : s.state === 'ready' ? `Version ${s.next} is ready. It installs when you restart TeleCloud.`
      : s.state === 'error' ? `Could not check for updates: ${s.error}` : TEXT[s.state] || TEXT.idle;
  return (
    <div className="update-row">
      <Icon name={s.state === 'ready' ? 'check' : s.state === 'error' ? 'alert' : 'refresh'} className={s.state === 'checking' ? 'spin' : ''} />
      <span>{text}</span>
      {s.state === 'ready'
        ? <button className="btn-primary sm-btn" onClick={() => ipc.invoke('update:install')}>Restart now</button>
        : <button className="btn-ghost" onClick={() => ipc.invoke('update:check')} disabled={s.state === 'checking' || s.state === 'downloading'}>Check for updates</button>}
    </div>
  );
};

export default UpdateStatus;
