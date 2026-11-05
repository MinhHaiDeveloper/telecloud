import React, { useEffect, useState } from 'react';
import Icon from './Icon';

/**
 * The window's own title bar (the window is frameless): drag anywhere on it to move the window,
 * double-click to maximize, and the three window buttons on the right in the app's style.
 */
const TitleBar = ({ subtitle }) => {
  const [state, setState] = useState({ maximized: false, focused: true, fullscreen: false });
  useEffect(() => {
    const ipc = window.ipcRenderer;
    ipc.invoke('window:state').then(s => s && setState(s)).catch(() => {});
    const on = (e, s) => setState(s);
    ipc.on('window:state', on);
    return () => ipc.removeListener?.('window:state', on);
  }, []);
  if (state.fullscreen) return null;
  const ipc = window.ipcRenderer;
  return (
    <header className={`titlebar ${state.focused ? '' : 'blurred'}`}>
      {/* the sidebar right below already shows the logo; the bar shows what is playing */}
      <div className="tb-title">
        {subtitle && <><Icon name="music" /><span className="tb-sub">{subtitle}</span></>}
      </div>
      <div className="tb-buttons">
        <button className="tb-btn" onClick={() => ipc.invoke('window:minimize')} title="Minimize" aria-label="Minimize">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
        </button>
        <button className="tb-btn" onClick={() => ipc.invoke('window:toggle-maximize')} title={state.maximized ? 'Restore' : 'Maximize'} aria-label={state.maximized ? 'Restore' : 'Maximize'}>
          {state.maximized
            ? <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" rx="1.2" /><path d="M2.5 2.5V1.7c0-.66.54-1.2 1.2-1.2h4.6c.66 0 1.2.54 1.2 1.2v4.6c0 .66-.54 1.2-1.2 1.2h-.8" /></svg>
            : <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" rx="1.4" /></svg>}
        </button>
        <button className="tb-btn close" onClick={() => ipc.invoke('window:close')} title="Close" aria-label="Close">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
        </button>
      </div>
    </header>
  );
};

export default TitleBar;
