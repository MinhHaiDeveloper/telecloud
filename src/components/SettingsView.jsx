import React, { useState, useEffect } from 'react';
import TeleCloudSyncSettings from './TeleCloudSyncSettings';
import Icon from './Icon';
import LyricsSettings from './LyricsSettings';
import CoverSettings from './CoverSettings';
import ArtistPictureSettings from './ArtistPictureSettings';
import DiscordSettings from './DiscordSettings';
import { WhatsNewSection } from './WhatsNew';
import LogsSettings from './LogsSettings';
import LastfmSettings from './LastfmSettings';
import UpdateStatus from './UpdateStatus';
import DuplicatesSettings from './DuplicatesSettings';
import PerformanceSettings from './PerformanceSettings';
import AppearanceSettings from './AppearanceSettings';
import { Toggle, Segmented, Select, SettingRow, Callout, Dialog, alertDialog } from './ui';
import useSlidingIndicator from '../hooks/useSlidingIndicator';
import pkg from '../../package.json';

const TABS = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'appearance', label: 'Appearance', icon: 'image' },
  { id: 'library', label: 'Library', icon: 'folder' },
  { id: 'playback', label: 'Playback', icon: 'speaker' },
  { id: 'eq', label: 'Equalizer', icon: 'eq' },
  { id: 'keyboard', label: 'Keyboard', icon: 'lyrics' },
  { id: 'downloads', label: 'Downloads', icon: 'download' },
  { id: 'telecloud', label: 'TeleCloud Sync', icon: 'cloud' },
  { id: 'about', label: 'About', icon: 'info' },
];

const SHORTCUT_LABELS = {
  playPause: 'Play / Pause',
  next: 'Next track',
  previous: 'Previous track',
  volumeUp: 'Volume up',
  volumeDown: 'Volume down',
  seekForward: 'Seek forward 5s',
  seekBackward: 'Seek back 5s',
  toggleMute: 'Mute',
};

const KEY_NAMES = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', ' ': 'Space' };
const keyLabel = (combo = '') => combo.split('+').map((k, i) => <kbd key={i}>{KEY_NAMES[k] || k}</kbd>);

const SettingsView = ({
  theme,
  setTheme,
  setDisabledDevices: setAppDisabledDevices,
  musicFolderList,
  setMusicFolderList,
  onRefreshFolder,
  setMusicFiles,
  onOpenEq,
  onShortcutsChange,
  onAudioSettingsChange,
}) => {
  const [activeTab, setActiveTab] = useState('general');
  const [downloadFolder, setDownloadFolder] = useState('');
  const [audioDevices, setAudioDevices] = useState([]);
  const [disabledDevices, setDisabledDevices] = useState([]);
  const navRef = useSlidingIndicator('y', activeTab);

  // Audio settings
  const [replayGainEnabled, setReplayGainEnabled] = useState(false);
  const [replayGainMode, setReplayGainMode] = useState('track');
  const [dsdMode, setDsdMode] = useState('pcm');
  const [dopMax, setDopMax] = useState(512);
  const [channelBalance, setChannelBalance] = useState(0);
  const [balanceDraft, setBalanceDraft] = useState(0); // follows the slider; saved when it is let go
  const [crossfeed, setCrossfeed] = useState('off');
  const [mqaMode, setMqaMode] = useState('plain');
  const [mqaScan, setMqaScan] = useState(null);
  const [asioDriver, setAsioDriver] = useState('');
  const [asioDrivers, setAsioDrivers] = useState(null);
  const [asioCheck, setAsioCheck] = useState(null);
  useEffect(() => {
    if (dsdMode === 'native' && !asioDrivers) window.ipcRenderer.invoke('asio:list').then(r => setAsioDrivers(r?.names || [])).catch(() => setAsioDrivers([]));
  }, [dsdMode, asioDrivers]);
  // MQA: the whole library, in the background; progress comes back as events
  useEffect(() => {
    const on = (e, p) => setMqaScan(p);
    window.ipcRenderer.on('mqa:progress', on);
    return () => window.ipcRenderer.removeListener?.('mqa:progress', on);
  }, []);
  const findMqa = async () => {
    const r = await window.ipcRenderer.invoke('mqa:check-library');
    if (r && !r.total) setMqaScan({ ...r, finished: true });
  };

  const checkAsio = async () => {
    setAsioCheck({ busy: true });
    const r = await window.ipcRenderer.invoke('asio:probe', asioDriver).catch(err => ({ success: false, error: err.message }));
    if (!r?.success || !r.ok) setAsioCheck({ text: `Could not open it: ${r?.msg || r?.error || 'no answer'}. If something is playing through this DAC, stop it and check again.`, bad: true });
    else if (!r.dsd) setAsioCheck({ text: "It opened, but it doesn't take DSD. TeleCloud will use DoP or PCM.", bad: true });
    else setAsioCheck({ text: `Native DSD: ${r.rates.map(x => `DSD${x / 44100}`).join(', ')}. Higher rates go through DoP or PCM.` });
  };
  const [crossfadeEnabled, setCrossfadeEnabled] = useState(false);
  const [crossfadeDuration, setCrossfadeDuration] = useState(3);
  const [maxSamplingEnabled, setMaxSamplingEnabled] = useState(false);
  const [maxBitDepth, setMaxBitDepth] = useState(24);
  const [maxSampleRate, setMaxSampleRate] = useState(192);

  // Keyboard shortcuts
  const [keyboardShortcuts, setKeyboardShortcuts] = useState({
    playPause: 'Space',
    next: 'ArrowRight',
    previous: 'ArrowLeft',
    volumeUp: 'ArrowUp',
    volumeDown: 'ArrowDown',
    seekForward: 'Ctrl+ArrowRight',
    seekBackward: 'Ctrl+ArrowLeft',
    toggleMute: 'M'
  });
  const [editingShortcut, setEditingShortcut] = useState(null);

  // Clear cache & database dialogs
  const [showClearInfoModal, setShowClearInfoModal] = useState(false);
  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      const ipcRenderer = window.ipcRenderer;
      const settings = await ipcRenderer.invoke('load-store', 'settings');
      if (settings && settings.downloadFolder) setDownloadFolder(settings.downloadFolder);
      if (settings && settings.disabledDevices) setDisabledDevices(settings.disabledDevices);

      if (settings && settings.replayGainEnabled !== undefined) setReplayGainEnabled(settings.replayGainEnabled);
      if (settings && settings.replayGainMode) setReplayGainMode(settings.replayGainMode);
      if (settings && settings.crossfadeEnabled !== undefined) setCrossfadeEnabled(settings.crossfadeEnabled);
      if (settings && settings.crossfadeDuration) setCrossfadeDuration(settings.crossfadeDuration);
      if (settings && settings.maxSamplingEnabled !== undefined) setMaxSamplingEnabled(settings.maxSamplingEnabled);
      if (settings && settings.maxBitDepth) setMaxBitDepth(settings.maxBitDepth);
      if (settings && settings.maxSampleRate) setMaxSampleRate(settings.maxSampleRate);
      if (settings && settings.dsdMode) setDsdMode(settings.dsdMode);
      if (settings && settings.dopMax) setDopMax(settings.dopMax);
      if (settings && Number.isFinite(settings.channelBalance)) { setChannelBalance(settings.channelBalance); setBalanceDraft(settings.channelBalance); }
      if (settings && settings.crossfeed) setCrossfeed(settings.crossfeed);
      if (settings && settings.mqaMode) setMqaMode(settings.mqaMode);
      if (settings && settings.asioDriver) setAsioDriver(settings.asioDriver);
      if (settings && settings.keyboardShortcuts) setKeyboardShortcuts(settings.keyboardShortcuts);
      setSettingsLoaded(true);

      try {
        const devs = await window.ipcRenderer.invoke('get-audio-devices');
        const outputs = devs.filter(d => d.id !== 'auto' && d.name);
        outputs.unshift({ id: '-1', name: 'System Default' });
        setAudioDevices(outputs);
      } catch (e) {
        console.error('Error fetching audio devices', e);
      }
    };
    fetchSettings();
  }, []);

  // Save audio settings when they change (only after the stored values were loaded,
  // otherwise the defaults would overwrite them on mount)
  useEffect(() => {
    if (!settingsLoaded) return;
    const saveAudioSettings = async () => {
      const ipcRenderer = window.ipcRenderer;
      const settings = await ipcRenderer.invoke('load-store', 'settings') || {};
      const newSettings = Array.isArray(settings) ? {} : settings;
      newSettings.replayGainEnabled = replayGainEnabled;
      newSettings.replayGainMode = replayGainMode;
      newSettings.crossfadeEnabled = crossfadeEnabled;
      newSettings.crossfadeDuration = crossfadeDuration;
      newSettings.maxSamplingEnabled = maxSamplingEnabled;
      newSettings.maxBitDepth = maxBitDepth;
      newSettings.maxSampleRate = maxSampleRate;
      newSettings.dsdMode = dsdMode;
      newSettings.dopMax = dopMax;
      newSettings.asioDriver = asioDriver;
      newSettings.channelBalance = channelBalance;
      newSettings.crossfeed = crossfeed;
      newSettings.mqaMode = mqaMode;
      newSettings.keyboardShortcuts = keyboardShortcuts;
      await ipcRenderer.invoke('save-store', 'settings', newSettings);
      onShortcutsChange?.(keyboardShortcuts);

      const audio = {
        replayGain: replayGainEnabled ? replayGainMode : 'no',
        crossfade: crossfadeEnabled ? crossfadeDuration : 0,
        maxBitDepth: maxSamplingEnabled ? maxBitDepth : null,
        maxSampleRate: maxSamplingEnabled ? maxSampleRate : null,
        dsdMode,
        dopMax,
        asioDriver,
        balance: channelBalance,
        crossfeed,
        mqaMode,
      };
      await ipcRenderer.invoke('apply-audio-settings', audio);
      onAudioSettingsChange?.(audio);
    };
    saveAudioSettings();
  }, [settingsLoaded, replayGainEnabled, replayGainMode, crossfadeEnabled, crossfadeDuration, maxSamplingEnabled, maxBitDepth, maxSampleRate, dsdMode, dopMax, asioDriver, channelBalance, crossfeed, mqaMode, keyboardShortcuts]);

  const toggleDevice = async (deviceId) => {
    const ipcRenderer = window.ipcRenderer;
    let newDisabled = [...disabledDevices];
    if (newDisabled.includes(deviceId)) newDisabled = newDisabled.filter(id => id !== deviceId);
    else newDisabled.push(deviceId);
    setDisabledDevices(newDisabled);
    if (setAppDisabledDevices) setAppDisabledDevices(newDisabled);
    const settings = await ipcRenderer.invoke('load-store', 'settings') || {};
    const newSettings = Array.isArray(settings) ? {} : settings;
    newSettings.disabledDevices = newDisabled;
    await ipcRenderer.invoke('save-store', 'settings', newSettings);
  };

  const handleChangeLocation = async () => {
    const ipcRenderer = window.ipcRenderer;
    const folderPath = await ipcRenderer.invoke('select-music-folder');
    if (folderPath) {
      setDownloadFolder(folderPath);
      const settings = await ipcRenderer.invoke('load-store', 'settings') || {};
      const newSettings = Array.isArray(settings) ? {} : settings;
      newSettings.downloadFolder = folderPath;
      await ipcRenderer.invoke('save-store', 'settings', newSettings);
    }
  };

  // The main process scans the folders saved in settings, so save first, then refresh
  const saveFolders = async (newList) => {
    setMusicFolderList(newList);
    const settings = await window.ipcRenderer.invoke('load-store', 'settings') || {};
    settings.musicFolderList = newList;
    await window.ipcRenderer.invoke('save-store', 'settings', settings);
    await onRefreshFolder(false);
  };

  const handleAddFolder = async () => {
    const folderPath = await window.ipcRenderer.invoke('select-music-folder');
    if (!folderPath || musicFolderList.includes(folderPath)) return;
    const nested = musicFolderList.find(f => folderPath.toLowerCase().startsWith(f.toLowerCase().replace(/[\\/]+$/, '') + '\\'));
    if (nested) {
      await alertDialog({ title: 'Already in your library', message: `This folder is inside “${nested}”, which is already scanned.`, tone: 'info', icon: 'folder' });
      return;
    }
    await saveFolders([...musicFolderList, folderPath]);
  };

  const handleRemoveFolder = (pathToRemove) => saveFolders(musicFolderList.filter(p => p !== pathToRemove));

  const handleClearCache = async () => {
    setIsClearing(true);
    setShowClearConfirmModal(false);
    try {
      const result = await window.electronAPI.clearDatabaseAndCache();
      if (result.success) {
        setMusicFiles([]);
        await alertDialog({ title: 'Cache and database cleared', message: 'Run a full scan to rebuild your library.', tone: 'ok' });
      } else {
        await alertDialog({ title: 'Could not clear the cache', message: result.error || 'Unknown error', tone: 'danger' });
      }
    } catch (error) {
      await alertDialog({ title: 'Could not clear the cache', message: error.message, tone: 'danger' });
    } finally {
      setIsClearing(false);
    }
  };

  // Built-in keys a custom shortcut must not take over (track selection, search, EQ history)
  const RESERVED_KEYS = {
    'Ctrl+A': 'selecting every track in a list',
    'Ctrl+K': 'search',
    'Ctrl+Z': 'EQ undo',
    'Ctrl+Y': 'EQ redo',
    'Ctrl+Shift+Z': 'EQ redo',
  };
  const captureShortcut = (key, e) => {
    if (editingShortcut !== key) return;
    e.preventDefault();
    if (e.key === 'Escape') { setEditingShortcut(null); return; }
    const keys = [];
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.shiftKey) keys.push('Shift');
    if (e.altKey) keys.push('Alt');
    if (['Control', 'Shift', 'Alt'].includes(e.key)) return; // wait for the actual key
    keys.push(e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key));
    const newKey = keys.join('+');
    if (RESERVED_KEYS[newKey]) {
      alertDialog({ title: 'Shortcut reserved', message: `${newKey} is used for ${RESERVED_KEYS[newKey]}. Pick another combination.`, tone: 'warn' });
      return;
    }
    const takenBy = Object.entries(keyboardShortcuts).find(([k, v]) => k !== key && v === newKey);
    if (takenBy) {
      alertDialog({ title: 'Shortcut already in use', message: `${newKey} is assigned to “${SHORTCUT_LABELS[takenBy[0]]}”.`, tone: 'warn' });
      return;
    }
    setKeyboardShortcuts({ ...keyboardShortcuts, [key]: newKey });
    setEditingShortcut(null);
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'general':
        return (
          <>
          <LyricsSettings />
          <CoverSettings />
          <ArtistPictureSettings />
          <DiscordSettings />
          <LastfmSettings />
          <PerformanceSettings />
          </>
        );

      case 'appearance':
        return <AppearanceSettings theme={theme} setTheme={setTheme} />;

      case 'library':
        return (
          <>
            <section className="set-section">
              <div className="head-row">
                <h3>Music folders</h3>
                <div className="btn-row">
                  <button className="btn-ghost" onClick={() => onRefreshFolder(false)} title="Add new files, update changed ones, drop missing ones"><Icon name="refresh" />Refresh</button>
                  <button className="btn-ghost" onClick={() => onRefreshFolder(true)} title="Re-read the tags of every file, e.g. after editing them in another app"><Icon name="search" />Full rescan</button>
                  <button className="btn-primary" onClick={handleAddFolder}><Icon name="plus" />Add folder</button>
                </div>
              </div>
              <div className="card set-card">
                {musicFolderList.length === 0 && (
                  <SettingRow icon="folder" title="No folders yet" desc="Add the folders that hold your music files." muted />
                )}
                {musicFolderList.map(folder => (
                  <SettingRow key={folder} icon="folder" title={folder}>
                    <button className="btn-outline danger" onClick={() => handleRemoveFolder(folder)}>Remove</button>
                  </SettingRow>
                ))}
                {musicFolderList.length > 0 && (
                  <SettingRow icon="info" title="Changes are picked up automatically" desc="New files appear while the app is open and when it starts. Use Refresh if something is missing, or Full rescan to re-read every tag." muted />
                )}
              </div>
            </section>

            <section className="set-section">
              <h3>
                Cache & database
                <button className="icon-btn" onClick={() => setShowClearInfoModal(true)} title="What gets cleared?"><Icon name="info" /></button>
              </h3>
              <div className="card set-card">
                <SettingRow icon="trash" title="Clear cached data & database" desc="Removes cached metadata and cover art, then needs a full scan. Your music files are not touched.">
                  <button className="btn-outline danger" onClick={() => setShowClearConfirmModal(true)} disabled={isClearing}>
                    {isClearing ? <><span className="ring" style={{ width: 14, height: 14 }} />Clearing…</> : 'Clear…'}
                  </button>
                </SettingRow>
              </div>
            </section>
            <DuplicatesSettings />
          </>
        );

      case 'playback':
        return (
          <>
            <section className="set-section">
              <h3>Output devices</h3>
              <div className="card set-card">
                {audioDevices.length === 0 && <SettingRow icon="speaker" title="Looking for devices…" muted />}
                {audioDevices.map(device => (
                  <SettingRow
                    key={device.id}
                    icon={device.id === '-1' ? 'monitor' : 'speaker'}
                    title={device.name}
                    desc={device.id === '-1' ? 'Shared mode through Windows mixer' : 'WASAPI exclusive · shown in the device picker'}
                    muted={disabledDevices.includes(device.id)}
                  >
                    <Toggle checked={!disabledDevices.includes(device.id)} onChange={() => toggleDevice(device.id)} />
                  </SettingRow>
                ))}
              </div>
            </section>

            <section className="set-section">
              <h3>Processing</h3>
              <div className="card set-card">
                <SettingRow icon="volume" title="ReplayGain" desc="Normalize loudness from track or album tags. Auto uses album gain while an album plays in order, and track gain on shuffle or mixed lists. Not bit-perfect while on.">
                  <Toggle checked={replayGainEnabled} onChange={setReplayGainEnabled} />
                </SettingRow>
                {replayGainEnabled && (
                  <div className="set-sub">
                    <Segmented size="sm" value={replayGainMode} onChange={setReplayGainMode} options={[{ value: 'auto', label: 'Auto' }, { value: 'track', label: 'Track gain' }, { value: 'album', label: 'Album gain' }]} />
                  </div>
                )}

                <SettingRow icon="shuffle" title="Crossfade" desc="Blend the end of one track into the next.">
                  <Toggle checked={crossfadeEnabled} onChange={setCrossfadeEnabled} />
                </SettingRow>
                {crossfadeEnabled && (
                  <div className="set-sub">
                    <div className="slider-line">
                      <input type="range" className="range full" min="1" max="10" value={crossfadeDuration}
                        style={{ '--pct': `${((crossfadeDuration - 1) / 9) * 100}%` }}
                        onChange={(e) => setCrossfadeDuration(Number(e.target.value))} />
                      <span className="mono">{crossfadeDuration}s</span>
                    </div>
                    <Callout tone="info">Works in shared mode. In WASAPI exclusive mode the device takes one stream only, so tracks play gapless instead.</Callout>
                  </div>
                )}

                <SettingRow icon="speaker" title="Channel balance" desc="Turns one side down, for uneven ears or headphones. The louder side stays untouched, so nothing clips. Not bit-perfect while off center.">
                  {balanceDraft !== 0 && <button className="btn-ghost sm" onClick={() => { setBalanceDraft(0); setChannelBalance(0); }}>Center</button>}
                </SettingRow>
                <div className="set-sub">
                  <div className="balance" style={{ '--f': (balanceDraft + 12) / 24 }}>
                    <span className="mono balance-side">L</span>
                    <div className="balance-track">
                      <span className="balance-value mono">{balanceDraft === 0 ? 'Center' : `${balanceDraft < 0 ? 'L' : 'R'} +${Math.abs(balanceDraft).toFixed(1)} dB`}</span>
                      <input type="range" min="-12" max="12" step="0.5" value={balanceDraft} aria-label="Channel balance" title="Double-click to center"
                        onChange={(e) => setBalanceDraft(Number(e.target.value))}
                        onDoubleClick={() => { setBalanceDraft(0); setChannelBalance(0); }}
                        onPointerUp={() => setChannelBalance(balanceDraft)} onKeyUp={() => setChannelBalance(balanceDraft)} onBlur={() => setChannelBalance(balanceDraft)} />
                    </div>
                    <span className="mono balance-side">R</span>
                  </div>
                </div>

                <SettingRow icon="eq" title="Headphone crossfeed" desc="Blends a little of each channel into the other, as speakers in a room do, so hard-panned recordings are easier on headphones. Not bit-perfect while on.">
                  <Segmented size="sm" value={crossfeed} onChange={setCrossfeed} options={[{ value: 'off', label: 'Off' }, { value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'strong', label: 'Strong' }]} />
                </SettingRow>

                <SettingRow icon="mqa" title="MQA" desc="TeleCloud doesn't unfold MQA itself. Send to MQA DAC: MQA tracks skip the EQ, balance, crossfeed and ReplayGain, so an MQA DAC gets the untouched bits it needs (WASAPI Exclusive). Play as plain PCM: they play like any other file.">
                  <Segmented size="sm" value={mqaMode} onChange={setMqaMode} options={[{ value: 'decoder', label: 'Send to MQA DAC' }, { value: 'plain', label: 'Play as plain PCM' }]} />
                </SettingRow>
                <div className="set-sub">
                  <div className="mqa-scan">
                    <button className="btn-ghost sm" onClick={findMqa} disabled={!!mqaScan && !mqaScan.finished}><Icon name="search" />Find MQA tracks</button>
                    {mqaScan && !mqaScan.finished && <button className="btn-ghost sm" onClick={() => window.ipcRenderer.invoke('mqa:stop')}>Stop</button>}
                    <small className="dsd-note">{!mqaScan ? 'Each track is also checked the first time it plays. MQA tracks get a badge, violet for MQA and blue for MQA Studio, and their own quality filter.'
                      : mqaScan.finished ? `${mqaScan.stopped ? 'Stopped. ' : ''}${mqaScan.total ? `Checked ${mqaScan.done.toLocaleString()} ${mqaScan.done === 1 ? 'track' : 'tracks'}, ${mqaScan.found ? `${mqaScan.found.toLocaleString()} new MQA` : 'no new MQA'}. ` : 'Every track was checked already. '}${(mqaScan.inLibrary || 0).toLocaleString()} MQA in your library.`
                        : `Checking ${mqaScan.done.toLocaleString()} of ${mqaScan.total.toLocaleString()}… ${mqaScan.found ? `${mqaScan.found} MQA so far` : ''}`}</small>
                  </div>
                </div>

                <SettingRow icon="dsd" title="DSD playback" desc="Native sends DSD as it is through the DAC's ASIO driver. DoP sends it untouched packed in PCM, in WASAPI Exclusive. Both need the EQ off. Whatever can't be done falls back, native to DoP to PCM, and the signal path says why. Convert to PCM works with every DAC.">
                  <Segmented size="sm" value={dsdMode} onChange={setDsdMode} options={[{ value: 'native', label: 'Native (ASIO)' }, { value: 'dop', label: 'DoP' }, { value: 'pcm', label: 'Convert to PCM' }]} />
                </SettingRow>
                {dsdMode !== 'pcm' && <div className="set-sub">
                  <div className="dsd-line">
                  {dsdMode === 'native' && (
                    <div className="asio-pick">
                      <div className="field" style={{ minWidth: 260 }}><span className="field-label">ASIO driver of your DAC</span>
                        <Select value={asioDriver} onChange={(v) => { setAsioDriver(v); setAsioCheck(null); }} options={[{ value: '', label: asioDrivers === null ? 'Looking…' : asioDrivers.length ? 'Choose a driver' : 'No ASIO drivers found' }, ...(asioDrivers || []).map(n => ({ value: n, label: n }))]} />
                      </div>
                      <button className="btn-check sm" onClick={checkAsio} disabled={!asioDriver || asioCheck?.busy}><Icon name="check" />{asioCheck?.busy ? 'Checking…' : 'Check'}</button>
                    </div>
                  )}
                  {dsdMode !== 'pcm' && (
                    <div className="field" style={{ minWidth: 220 }}><span className="field-label">{dsdMode === 'native' ? 'Highest DSD rate sent as DoP, when native can\'t' : 'Highest DSD rate sent as DoP'}</span>
                      <Select value={dopMax} onChange={setDopMax} options={[{ value: 512, label: 'DSD512 (1411.2 kHz)' }, { value: 256, label: 'DSD256 (705.6 kHz)' }, { value: 128, label: 'DSD128 (352.8 kHz)' }, { value: 64, label: 'DSD64 (176.4 kHz)' }]} />
                    </div>
                  )}
                  </div>
                  {dsdMode === 'native' && asioCheck?.text && <small className={asioCheck.bad ? 'cov-problem' : 'dsd-note'}>{asioCheck.text}</small>}
                  {dsdMode === 'native' && <small className="dsd-note">PCM keeps playing through the output you chose. Only DSD files go to the ASIO driver, and the DAC is handed over between them.</small>}
                </div>}

                <SettingRow icon="limit" title="Limit output format" desc="For DACs that can't take hi-res. Only files above the limit are converted; everything else plays untouched.">
                  <Toggle checked={maxSamplingEnabled} onChange={setMaxSamplingEnabled} />
                </SettingRow>
                {maxSamplingEnabled && (
                  <div className="set-sub">
                    <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 220px))' }}>
                      <div className="field"><span className="field-label">Max bit depth</span>
                        <Select value={maxBitDepth} onChange={setMaxBitDepth} options={[{ value: 16, label: '16-bit' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit' }]} />
                      </div>
                      <div className="field"><span className="field-label">Max sample rate</span>
                        <Select value={maxSampleRate} onChange={setMaxSampleRate} options={[44.1, 48, 88.2, 96, 176.4, 192, 384].map(v => ({ value: v, label: `${v} kHz` }))} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </>
        );

      case 'eq':
        return (
          <section className="set-section">
            <h3>Equalizer</h3>
            <div className="card set-card">
              <SettingRow icon="eq" title="Parametric EQ & AutoEQ" desc="31-band PEQ with measurement-to-target matching. Not bit-perfect while on.">
                <button className="btn-primary" onClick={onOpenEq}>Open EQ</button>
              </SettingRow>
            </div>
          </section>
        );

      case 'keyboard':
        return (
          <section className="set-section">
            <h3>Keyboard shortcuts</h3>
            <div className="card set-card">
              <SettingRow icon="info" title="Click a shortcut, then press the new keys" desc="Esc cancels. Shortcuts are ignored while typing in a text field. Ctrl+A, Ctrl+K, Ctrl+Z and Ctrl+Y are built in; Ctrl/Shift+click select tracks." muted />
              <div className="kbd-grid">
                {Object.entries(SHORTCUT_LABELS).map(([key, label]) => (
                  <SettingRow key={key} title={label}>
                    <button
                      className={`key-btn ${editingShortcut === key ? 'listening' : ''}`}
                      onClick={() => setEditingShortcut(editingShortcut === key ? null : key)}
                      onKeyDown={(e) => captureShortcut(key, e)}
                      onBlur={() => editingShortcut === key && setEditingShortcut(null)}
                    >
                      {editingShortcut === key ? 'Press keys…' : keyLabel(keyboardShortcuts[key])}
                    </button>
                  </SettingRow>
                ))}
              </div>
            </div>
          </section>
        );

      case 'downloads':
        return (
          <section className="set-section">
            <h3>Downloads</h3>
            <div className="card set-card">
              <SettingRow icon="folder" title="Download location" desc={downloadFolder || 'Not set — downloads ask for a folder.'}>
                <button className="btn-ghost" onClick={handleChangeLocation}>{downloadFolder ? 'Change' : 'Choose folder'}</button>
              </SettingRow>
            </div>
          </section>
        );

      case 'telecloud':
        return <TeleCloudSyncSettings />;

      case 'about':
      default:
        return (
          <>
          <section className="set-section">
            <h3>About</h3>
            <div className="card">
              <div className="about-hero">
                <div className="logo-mark"><Icon name="logo" /></div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>TeleCloud</div>
                  <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Version {pkg.version} · Local hi-res player with Telegram cloud backup</div>
                </div>
              </div>
              <UpdateStatus />
            </div>
          </section>
          <WhatsNewSection version={pkg.version} />
          <LogsSettings />
          </>
        );
    }
  };

  return (
    <div className="settings">
      <nav className="settings-nav">
        <h2>Settings</h2>
        <div className="nav-items slider-host" ref={navRef}>
          <span className="indicator" />
          {TABS.map(t => (
            <button key={t.id} className={activeTab === t.id ? 'on' : ''} data-active={activeTab === t.id} onClick={() => setActiveTab(t.id)}>
              <Icon name={t.icon} />{t.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="settings-body" key={activeTab}>{renderTab()}</div>

      <Dialog open={showClearInfoModal} onClose={() => setShowClearInfoModal(false)} title="What gets cleared?" icon="info" width={520}
        actions={<button className="btn-primary" onClick={() => setShowClearInfoModal(false)}>Got it</button>}>
        <h4>Cache</h4>
        <ul><li>Album art extracted from your files</li><li>Temporary image files</li></ul>
        <h4>Database</h4>
        <ul><li>Track metadata (title, artist, album, genre)</li><li>Format info (bit depth, sample rate, duration)</li><li>Scan timestamps</li></ul>
        <div style={{ marginTop: 14 }}><Callout tone="ok">Your music files stay exactly where they are — only cached information is removed.</Callout></div>
        <h4>Afterwards</h4>
        <ul><li>The library is empty until you run a full scan</li><li>Metadata and cover art are read again from the files</li></ul>
      </Dialog>

      <Dialog open={showClearConfirmModal} onClose={() => setShowClearConfirmModal(false)} title="Clear cache & database?" icon="alert" tone="danger"
        actions={<>
          <button className="btn-ghost" onClick={() => setShowClearConfirmModal(false)}>Cancel</button>
          <button className="btn-danger" onClick={handleClearCache}>Clear everything</button>
        </>}>
        <p>All cached metadata and cover art will be removed. Your library will look empty until you run a full scan.</p>
        <div style={{ marginTop: 12 }}><Callout tone="ok">Your music files will not be deleted.</Callout></div>
      </Dialog>
    </div>
  );
};

export default SettingsView;
