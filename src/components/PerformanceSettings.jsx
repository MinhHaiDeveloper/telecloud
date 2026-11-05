import React, { useEffect, useState } from 'react';
import { SettingRow, Toggle } from './ui';

const readFps = () => { try { return localStorage.getItem('show-fps') === '1'; } catch { return false; } };

/** Settings → General → Performance: GPU choice (needs a restart) and a frame-rate readout */
const PerformanceSettings = () => {
  const [gpu, setGpu] = useState(null);
  const [startGpu, setStartGpu] = useState(null);
  const [fps, setFps] = useState(readFps);
  const ipc = window.ipcRenderer;
  useEffect(() => {
    ipc.invoke('load-store', 'settings').then(s => { const v = !!(s && s.highPerformanceGpu); setGpu(v); setStartGpu(v); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (gpu === null) return null;
  const setGpuPref = async (v) => {
    setGpu(v);
    const s = (await ipc.invoke('load-store', 'settings')) || {};
    await ipc.invoke('save-store', 'settings', { ...(Array.isArray(s) ? {} : s), highPerformanceGpu: v });
  };
  const setFpsPref = (v) => {
    setFps(v);
    try { localStorage.setItem('show-fps', v ? '1' : '0'); } catch { /* private storage */ }
    window.dispatchEvent(new Event('telecloud:fps'));
  };
  return (
    <section className="set-section">
      <h3>Performance</h3>
      <div className="card set-card">
        <SettingRow icon="monitor" title="Use the high-performance graphics card" desc="For laptops with two GPUs: smoother animations on 144–240 Hz screens, at some battery cost. Takes effect after a restart.">
          {gpu !== startGpu && <button className="btn-ghost" onClick={() => ipc.invoke('app:relaunch')}>Restart now</button>}
          <Toggle checked={gpu} onChange={setGpuPref} />
        </SettingRow>
        <SettingRow icon="chart" title="Show frame rate" desc="A small counter in the corner: frames per second and the slowest frame. Useful to check a high-refresh screen.">
          <Toggle checked={fps} onChange={setFpsPref} />
        </SettingRow>
      </div>
    </section>
  );
};

export default PerformanceSettings;
