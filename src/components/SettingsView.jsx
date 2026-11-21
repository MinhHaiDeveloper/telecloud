import React, { useState, useEffect, useRef } from 'react';
import { SettingsSearchBox, SettingsResults } from './SettingsSearch';
import TeleCloudSyncSettings from './TeleCloudSyncSettings';
import Icon from './Icon';
import LyricsSettings from './LyricsSettings';
import CoverSettings from './CoverSettings';
import ArtistPictureSettings from './ArtistPictureSettings';
import DiscordSettings from './DiscordSettings';
import { WhatsNewSection } from './WhatsNew';
import LogsSettings from './LogsSettings';
import DataSettings from './DataSettings';
import LastfmSettings from './LastfmSettings';
import ListenBrainzSettings from './ListenBrainzSettings';
import UpdateStatus from './UpdateStatus';
import DuplicatesSettings from './DuplicatesSettings';
import ContinueSettings from './ContinueSettings';
import SoundSettings from './SoundSettings';
import PerformanceSettings from './PerformanceSettings';
import AppearanceSettings from './AppearanceSettings';
import RemoteSettings from './RemoteSettings';
import { Toggle, Segmented, Select, SettingRow, Callout, Dialog, alertDialog } from './ui';
import useSlidingIndicator from '../hooks/useSlidingIndicator';
import pkg from '../../package.json';
import { ipcOn, ipcOff } from '../utils/ipc';
import { t, justRelabeled } from '../i18n';

let shownTab = null; // the tab on screen, for when a new language draws Settings again

const TABS = [
  { id: 'general', get label() { return t('General'); }, icon: 'settings' },
  { id: 'appearance', get label() { return t('Appearance'); }, icon: 'image' },
  { id: 'library', get label() { return t('Library'); }, icon: 'folder' },
  { id: 'playback', get label() { return t('Playback'); }, icon: 'speaker' },
  { id: 'eq', get label() { return t('Sound'); }, icon: 'eq' },
  { id: 'keyboard', get label() { return t('Keyboard'); }, icon: 'lyrics' },
  { id: 'downloads', get label() { return t('Downloads'); }, icon: 'download' },
  { id: 'telecloud', get label() { return t('TeleCloud Sync'); }, icon: 'cloud' },
  { id: 'remote', get label() { return t('Remote'); }, icon: 'monitor' },
  { id: 'about', get label() { return t('About'); }, icon: 'info' },
];

const SHORTCUT_LABELS = {
  get playPause() { return t('Play / Pause'); },
  get next() { return t('Next track'); },
  get previous() { return t('Previous track'); },
  get volumeUp() { return t('Volume up'); },
  get volumeDown() { return t('Volume down'); },
  get seekForward() { return t('Seek forward 5s'); },
  get seekBackward() { return t('Seek back 5s'); },
  get toggleMute() { return t('Mute'); },
  get togglePanel() { return t('Show or hide the side panel'); },
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
  initialTab,
  onShortcutsChange,
  onAudioSettingsChange,
}) => {
  // back from the EQ: the tab it was opened from; drawn again for a new language: the tab it was on
  const [activeTab, setActiveTab] = useState(initialTab || (justRelabeled() && shownTab) || 'general');
  useEffect(() => { shownTab = activeTab; }, [activeTab]);
  // ---- the search: what is typed, the topic chips, and the setting to show once its tab is open
  const [query, setQuery] = useState('');
  const [topics, setTopics] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(null);
  const jumpTo = useRef(null);
  const closeSearch = () => { setSearching(false); setQuery(''); setTopics([]); };
  const pick = (it) => { jumpTo.current = it.title; closeSearch(); setActiveTab(it.tab); };
  // Ctrl+F on this page goes to the search box
  useEffect(() => {
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Once the tab is on screen: bring the setting into view and light it up for a moment. A row that only shows in
  // some states (signed in, a device connected) may not be there: its section heading is used instead.
  useEffect(() => {
    const title = jumpTo.current;
    if (!title || searching) return undefined;
    let timer = 0, done = null;
    const t0 = performance.now(); // a tab that loads its state first (devices, sign-in) gets up to 3 s to show
    const find = () => {
      const body = document.querySelector('.settings-body');
      if (!body) return null;
      const css = window.CSS?.escape ? CSS.escape(title) : title.replace(/"/g, '\\"');
      const row = body.querySelector(`[data-setting="${css}"]`);
      if (row) return row;
      const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
      const head = [...body.querySelectorAll('h3, .src-order-head > b, .set-title')].find(el => text(el) === title);
      return head ? (head.closest('.set-row') || head.closest('.set-sub') || head.closest('.set-section') || head) : null;
    };
    const go = () => {
      const el = find();
      if (!el) { if (performance.now() - t0 < 3000) timer = setTimeout(go, 50); else jumpTo.current = null; return; }
      jumpTo.current = null;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('set-flash'); void el.offsetWidth; el.classList.add('set-flash');
      done = setTimeout(() => el.classList.remove('set-flash'), 2200);
    };
    timer = setTimeout(go, 0); // after the tab has painted
    return () => { clearTimeout(timer); clearTimeout(done); };
  }, [activeTab, searching]);
  const [downloadFolder, setDownloadFolder] = useState('');
  const [audioDevices, setAudioDevices] = useState([]);
  const [disabledDevices, setDisabledDevices] = useState([]);
  const navRef = useSlidingIndicator('y', activeTab, 8);

  // Audio settings
  const [replayGainEnabled, setReplayGainEnabled] = useState(false);
  const [replayGainMode, setReplayGainMode] = useState('track');
  const [dsdMode, setDsdMode] = useState('pcm');
  const [dopMax, setDopMax] = useState(512);
  const [channelBalance, setChannelBalance] = useState(0);
  const [balanceDraft, setBalanceDraft] = useState(0); // follows the slider; saved when it is let go
  const [crossfeed, setCrossfeed] = useState('off');
  const [skipSilence, setSkipSilence] = useState(false); // trim long silences (live albums, podcasts)
  const [releaseOnPause, setReleaseOnPause] = useState(false); // other apps may use the DAC while paused
  const [pauseFade, setPauseFade] = useState(false);
  const [exclusiveBuffer, setExclusiveBuffer] = useState('default'); // the DAC's buffer in WASAPI Exclusive
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
    ipcOn(window.ipcRenderer, 'mqa:progress', on);
    return () => ipcOff(window.ipcRenderer, 'mqa:progress', on);
  }, []);
  const findMqa = async () => {
    const r = await window.ipcRenderer.invoke('mqa:check-library');
    if (r && !r.total) setMqaScan({ ...r, finished: true });
  };

  const checkAsio = async () => {
    setAsioCheck({ busy: true });
    const r = await window.ipcRenderer.invoke('asio:probe', asioDriver).catch(err => ({ success: false, error: err.message }));
    if (!r?.success || !r.ok) setAsioCheck({ text: t('Could not open it: {value}. If something is playing through this DAC, stop it and check again.', { value: r?.msg || r?.error || t('no answer') }), bad: true });
    else if (!r.dsd) setAsioCheck({ text: t('It opened, but it doesn\'t take DSD. TeleCloud will use DoP or PCM.'), bad: true });
    else setAsioCheck({ text: t('Native DSD: {map}. Higher rates go through DoP or PCM.', { map: r.rates.map(x => `DSD${x / 44100}`).join(', ') }) });
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
    toggleMute: 'M',
    togglePanel: 'Ctrl+J',
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
      if (settings) setSkipSilence(!!settings.skipSilence);
      if (settings && settings.releaseOnPause) setReleaseOnPause(true);
      if (settings && settings.pauseFade) setPauseFade(true);
      if (settings && settings.exclusiveBuffer) setExclusiveBuffer(String(settings.exclusiveBuffer));
      if (settings && settings.mqaMode) setMqaMode(settings.mqaMode);
      if (settings && settings.asioDriver) setAsioDriver(settings.asioDriver);
      if (settings && settings.keyboardShortcuts) setKeyboardShortcuts(s => ({ ...s, ...settings.keyboardShortcuts }));
      setSettingsLoaded(true);

      try {
        const devs = await window.ipcRenderer.invoke('get-audio-devices');
        const outputs = devs.filter(d => d.id !== 'auto' && d.name);
        outputs.unshift({ id: '-1', name: t('System Default') });
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
      newSettings.skipSilence = skipSilence;
      newSettings.releaseOnPause = releaseOnPause;
      newSettings.pauseFade = pauseFade;
      newSettings.exclusiveBuffer = exclusiveBuffer;
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
        skipSilence,
        mqaMode,
        releaseOnPause,
        pauseFade,
        exclusiveBuffer,
      };
      await ipcRenderer.invoke('apply-audio-settings', audio);
      onAudioSettingsChange?.(audio);
    };
    saveAudioSettings();
  }, [settingsLoaded, replayGainEnabled, replayGainMode, crossfadeEnabled, crossfadeDuration, maxSamplingEnabled, maxBitDepth, maxSampleRate, dsdMode, dopMax, asioDriver, channelBalance, crossfeed, skipSilence, mqaMode, releaseOnPause, pauseFade, exclusiveBuffer, keyboardShortcuts]);

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
      await alertDialog({ title: t('Already in your library'), message: t('This folder is inside “{nested}”, which is already scanned.', { nested }), tone: 'info', icon: 'folder' });
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
        await alertDialog({ title: t('Cache and database cleared'), message: t('Run a full scan to rebuild your library.'), tone: 'ok' });
      } else {
        await alertDialog({ title: t('Could not clear the cache'), message: result.error || t('Unknown error'), tone: 'danger' });
      }
    } catch (error) {
      await alertDialog({ title: t('Could not clear the cache'), message: error.message, tone: 'danger' });
    } finally {
      setIsClearing(false);
    }
  };

  // Built-in keys a custom shortcut must not take over (track selection, search, EQ history)
  const RESERVED_KEYS = {
    'Ctrl+A': t('selecting every track in a list'),
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
      alertDialog({ title: t('Shortcut reserved'), message: t('{newKey} is used for {value}. Pick another combination.', { newKey, value: RESERVED_KEYS[newKey] }), tone: 'warn' });
      return;
    }
    const takenBy = Object.entries(keyboardShortcuts).find(([k, v]) => k !== key && v === newKey);
    if (takenBy) {
      alertDialog({ title: t('Shortcut already in use'), message: t('{newKey} is assigned to “{value}”.', { newKey, value: SHORTCUT_LABELS[takenBy[0]] }), tone: 'warn' });
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
          <ListenBrainzSettings />
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
                <h3>{t('Music folders')}</h3>
                <div className="btn-row">
                  <button className="btn-ghost" onClick={() => onRefreshFolder(false)} title={t('Add new files, update changed ones, drop missing ones')}><Icon name="refresh" />{t('Refresh')}</button>
                  <button className="btn-ghost" onClick={() => onRefreshFolder(true)} title={t('Re-read the tags of every file, e.g. after editing them in another app')}><Icon name="search" />{t('Full rescan')}</button>
                  <button className="btn-primary" onClick={handleAddFolder}><Icon name="plus" />{t('Add folder')}</button>
                </div>
              </div>
              <div className="card set-card">
                {musicFolderList.length === 0 && (
                  <SettingRow icon="folder" title={t('No folders yet')} desc={t('Add the folders that hold your music files.')} muted />
                )}
                {musicFolderList.map(folder => (
                  <SettingRow key={folder} icon="folder" title={folder}>
                    <button className="btn-outline danger" onClick={() => handleRemoveFolder(folder)}>{t('Remove')}</button>
                  </SettingRow>
                ))}
                {musicFolderList.length > 0 && (
                  <SettingRow icon="info" title={t('Changes are picked up automatically')} desc={t('New files appear while the app is open and when it starts. Use Refresh if something is missing, or Full rescan to re-read every tag.')} muted />
                )}
              </div>
            </section>

            <section className="set-section">
              <h3>
               {t('Cache & database')}
                <button className="icon-btn" onClick={() => setShowClearInfoModal(true)} title={t('What gets cleared?')}><Icon name="info" /></button>
              </h3>
              <div className="card set-card">
                <SettingRow icon="trash" title={t('Clear cached data & database')} desc={t('Removes cached metadata and cover art, then needs a full scan. Your music files are not touched.')}>
                  <button className="btn-outline danger" onClick={() => setShowClearConfirmModal(true)} disabled={isClearing}>
                    {isClearing ? <><span className="ring" style={{ width: 14, height: 14 }} />{t('Clearing…')}</> : t('Clear…')}
                  </button>
                </SettingRow>
              </div>
            </section>
            <DuplicatesSettings />
            <DataSettings />
          </>
        );

      case 'playback':
        return (
          <>
            <ContinueSettings />
            <section className="set-section">
              <h3>{t('Output devices')}</h3>
              <div className="card set-card">
                {audioDevices.length === 0 && <SettingRow icon="speaker" title={t('Looking for devices…')} muted />}
                {audioDevices.map(device => (
                  <SettingRow
                    key={device.id}
                    icon={device.id === '-1' ? 'monitor' : 'speaker'}
                    title={device.name}
                    desc={device.id === '-1' ? t('Shared mode through Windows mixer') : t('WASAPI exclusive · shown in the device picker')}
                    muted={disabledDevices.includes(device.id)}
                  >
                    <Toggle checked={!disabledDevices.includes(device.id)} onChange={() => toggleDevice(device.id)} />
                  </SettingRow>
                ))}
              </div>
            </section>

            <section className="set-section">
              <h3>{t('Processing')}</h3>
              <div className="card set-card">
                <SettingRow icon="volume" title={t('ReplayGain')} desc={t('Normalize loudness from track or album tags. Auto uses album gain while an album plays in order, and track gain on shuffle or mixed lists. Not bit-perfect while on.')}>
                  <Toggle checked={replayGainEnabled} onChange={setReplayGainEnabled} />
                </SettingRow>
                {replayGainEnabled && (
                  <div className="set-sub">
                    <Segmented size="sm" value={replayGainMode} onChange={setReplayGainMode} options={[{ value: 'auto', label: t('Auto') }, { value: 'track', label: t('Track gain') }, { value: 'album', label: t('Album gain') }]} />
                  </div>
                )}

                <SettingRow icon="shuffle" title={t('Crossfade')} desc={t('Blend the end of one track into the next.')}>
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
                    <Callout tone="info">{t('Works in shared mode. In WASAPI exclusive mode the device takes one stream only, so tracks play gapless instead.')}</Callout>
                  </div>
                )}

                <SettingRow icon="speaker" title={t('Channel balance')} desc={t('Turns one side down, for uneven ears or headphones. The louder side stays untouched, so nothing clips. Not bit-perfect while off center.')}>
                  {balanceDraft !== 0 && <button className="btn-ghost sm" onClick={() => { setBalanceDraft(0); setChannelBalance(0); }}>{t('Center')}</button>}
                </SettingRow>
                <div className="set-sub">
                  <div className="balance" style={{ '--f': (balanceDraft + 12) / 24 }}>
                    <span className="mono balance-side">L</span>
                    <div className="balance-track">
                      <span className="balance-value mono">{balanceDraft === 0 ? t('Center') : `${balanceDraft < 0 ? 'L' : 'R'} +${Math.abs(balanceDraft).toFixed(1)} dB`}</span>
                      <input type="range" min="-12" max="12" step="0.5" value={balanceDraft} aria-label={t('Channel balance')} title={t('Double-click to center')}
                        onChange={(e) => setBalanceDraft(Number(e.target.value))}
                        onDoubleClick={() => { setBalanceDraft(0); setChannelBalance(0); }}
                        onPointerUp={() => setChannelBalance(balanceDraft)} onKeyUp={() => setChannelBalance(balanceDraft)} onBlur={() => setChannelBalance(balanceDraft)} />
                    </div>
                    <span className="mono balance-side">R</span>
                  </div>
                </div>

                <SettingRow icon="speaker" title={t('Let other apps use the DAC while paused')} desc={t('In WASAPI Exclusive and native DSD, TeleCloud holds the DAC, so a video or a game is silent even while the music is paused. On: a few seconds after a pause, the DAC is free; Play takes it back and carries on from the same moment.')}>
                  <Toggle checked={releaseOnPause} onChange={setReleaseOnPause} />
                </SettingRow>
                <SettingRow icon="speaker" title={t('Exclusive mode buffer')} desc={t('How much music the DAC is given at a time in WASAPI Exclusive. Device default suits most DACs. If yours clicks or skips now and then, try 20 ms first, then larger: some USB DACs click with a large buffer instead, so bigger is not always better. Bit-perfect at any size.')}>
                  <Select value={exclusiveBuffer} onChange={setExclusiveBuffer} align="right" width={170} options={[
                    { value: 'default', label: t('Device default') },
                    { value: '20', label: t('20 ms') },
                    { value: '50', label: t('50 ms') },
                    { value: '100', label: t('100 ms') },
                    { value: '200', label: t('200 ms') },
                    { value: 'min', label: t('Minimum') },
                  ]} />
                </SettingRow>
                <SettingRow icon="volume" title={t('Fade on play and pause')} desc={t('A short fade instead of a hard stop and start. Never while the signal path is bit-perfect: then pause and play stay instant.')}>
                  <Toggle checked={pauseFade} onChange={setPauseFade} />
                </SettingRow>
                <SettingRow icon="eq" title={t('Headphone crossfeed')} desc={t('Blends a little of each channel into the other, as speakers in a room do, so hard-panned recordings are easier on headphones. Not bit-perfect while on.')}>
                  <Segmented size="sm" value={crossfeed} onChange={setCrossfeed} options={[{ value: 'off', label: t('Off') }, { value: 'light', label: t('Light') }, { value: 'medium', label: t('Medium') }, { value: 'strong', label: t('Strong') }]} />
                </SettingRow>

                <SettingRow icon="next" title={t('Skip silence')} desc={t('Long silences (2 s and more) inside a track and between tracks shrink to half a second: for live albums, podcasts and hidden tracks. The music itself is untouched, but the timing changes: the seek bar and synced lyrics count only what is heard, so after a skipped silence they run behind. Not bit-perfect while on, and DSD plays as PCM.')}>
                  <Toggle checked={skipSilence} onChange={setSkipSilence} />
                </SettingRow>
                <SettingRow icon="mqa" title="MQA" desc={t('TeleCloud doesn\'t unfold MQA itself. Send to MQA DAC: MQA tracks skip the EQ, balance, crossfeed and ReplayGain, so an MQA DAC gets the untouched bits it needs (WASAPI Exclusive). Play as plain PCM: they play like any other file.')}>
                  <Segmented size="sm" value={mqaMode} onChange={setMqaMode} options={[{ value: 'decoder', label: t('Send to MQA DAC') }, { value: 'plain', label: t('Play as plain PCM') }]} />
                </SettingRow>
                <div className="set-sub">
                  <div className="mqa-scan">
                    <button className="btn-ghost sm" onClick={findMqa} disabled={!!mqaScan && !mqaScan.finished}><Icon name="search" />{t('Find MQA tracks')}</button>
                    {mqaScan && !mqaScan.finished && <button className="btn-ghost sm" onClick={() => window.ipcRenderer.invoke('mqa:stop')}>{t('Stop')}</button>}
                    <small className="dsd-note">{!mqaScan ? t('Each track is also checked the first time it plays. MQA tracks get a badge, violet for MQA and blue for MQA Studio, and their own quality filter.')
                      : mqaScan.finished ? t('{value}{value2}{value3} MQA in your library.', { value: mqaScan.stopped ? t('Stopped. ') : '', value2: mqaScan.total ? t('Checked {done|# track|# tracks}, {value}. ', { done: mqaScan.done, value: mqaScan.found ? t('{found} new MQA', { found: mqaScan.found.toLocaleString() }) : t('no new MQA') }) : t('Every track was checked already. '), value3: (mqaScan.inLibrary || 0).toLocaleString() })
                        : t('Checking {done} of {total}… {value}', { done: mqaScan.done.toLocaleString(), total: mqaScan.total.toLocaleString(), value: mqaScan.found ? t('{found} MQA so far', { found: mqaScan.found }) : '' })}</small>
                  </div>
                </div>

                <SettingRow icon="dsd" title={t('DSD playback')} desc={t('Native sends DSD as it is through the DAC\'s ASIO driver. DoP sends it untouched packed in PCM, in WASAPI Exclusive. Both need the EQ off. Whatever can\'t be done falls back, native to DoP to PCM, and the signal path says why. Convert to PCM works with every DAC.')}>
                  <Segmented size="sm" value={dsdMode} onChange={setDsdMode} options={[{ value: 'native', label: t('Native (ASIO)') }, { value: 'dop', label: 'DoP' }, { value: 'pcm', label: t('Convert to PCM') }]} />
                </SettingRow>
                {dsdMode !== 'pcm' && <div className="set-sub">
                  <div className="dsd-line">
                  {dsdMode === 'native' && (
                    <div className="asio-pick">
                      <div className="field" style={{ minWidth: 260 }}><span className="field-label">{t('ASIO driver of your DAC')}</span>
                        <Select value={asioDriver} onChange={(v) => { setAsioDriver(v); setAsioCheck(null); }} options={[{ value: '', label: asioDrivers === null ? t('Looking…') : asioDrivers.length ? t('Choose a driver') : t('No ASIO drivers found') }, ...(asioDrivers || []).map(n => ({ value: n, label: n }))]} />
                      </div>
                      <button className="btn-check sm" onClick={checkAsio} disabled={!asioDriver || asioCheck?.busy}><Icon name="check" />{asioCheck?.busy ? t('Checking…') : t('Check')}</button>
                    </div>
                  )}
                  {dsdMode !== 'pcm' && (
                    <div className="field" style={{ minWidth: 220 }}><span className="field-label">{dsdMode === 'native' ? t('Highest DSD rate sent as DoP, when native can\'t') : t('Highest DSD rate sent as DoP')}</span>
                      <Select value={dopMax} onChange={setDopMax} options={[{ value: 512, label: 'DSD512 (1411.2 kHz)' }, { value: 256, label: 'DSD256 (705.6 kHz)' }, { value: 128, label: 'DSD128 (352.8 kHz)' }, { value: 64, label: 'DSD64 (176.4 kHz)' }]} />
                    </div>
                  )}
                  </div>
                  {dsdMode === 'native' && asioCheck?.text && <small className={asioCheck.bad ? 'cov-problem' : 'dsd-note'}>{asioCheck.text}</small>}
                  {dsdMode === 'native' && <small className="dsd-note">{t('PCM keeps playing through the output you chose. Only DSD files go to the ASIO driver, and the DAC is handed over between them.')}</small>}
                </div>}

                <SettingRow icon="limit" title={t('Limit output format')} desc={t('For DACs that can\'t take hi-res. Only files above the limit are converted; everything else plays untouched.')}>
                  <Toggle checked={maxSamplingEnabled} onChange={setMaxSamplingEnabled} />
                </SettingRow>
                {maxSamplingEnabled && (
                  <div className="set-sub">
                    <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 220px))' }}>
                      <div className="field"><span className="field-label">{t('Max bit depth')}</span>
                        <Select value={maxBitDepth} onChange={setMaxBitDepth} options={[{ value: 16, label: t('16-bit') }, { value: 24, label: t('24-bit') }, { value: 32, label: t('32-bit') }]} />
                      </div>
                      <div className="field"><span className="field-label">{t('Max sample rate')}</span>
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
        return <SoundSettings />;

      case 'keyboard':
        return (
          <section className="set-section">
            <h3>{t('Keyboard shortcuts')}</h3>
            <div className="card set-card">
              <SettingRow icon="info" title={t('Click a shortcut, then press the new keys')} desc={t('Esc cancels. Shortcuts are ignored while typing in a text field. Ctrl+A, Ctrl+K, Ctrl+Z and Ctrl+Y are built in; Ctrl/Shift+click select tracks.')} muted />
              <div className="kbd-grid">
                {Object.entries(SHORTCUT_LABELS).map(([key, label]) => (
                  <SettingRow key={key} title={label}>
                    <button
                      className={`key-btn ${editingShortcut === key ? 'listening' : ''}`}
                      onClick={() => setEditingShortcut(editingShortcut === key ? null : key)}
                      onKeyDown={(e) => captureShortcut(key, e)}
                      onBlur={() => editingShortcut === key && setEditingShortcut(null)}
                    >
                      {editingShortcut === key ? t('Press keys…') : keyLabel(keyboardShortcuts[key])}
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
            <h3>{t('Downloads')}</h3>
            <div className="card set-card">
              <SettingRow icon="folder" title={t('Download location')} desc={downloadFolder || t('Not set — downloads ask for a folder.')}>
                <button className="btn-ghost" onClick={handleChangeLocation}>{downloadFolder ? t('Change') : t('Choose folder')}</button>
              </SettingRow>
            </div>
          </section>
        );

      case 'telecloud':
        return <TeleCloudSyncSettings />;

      case 'remote':
        return <RemoteSettings />;

      case 'about':
      default:
        return (
          <>
          <section className="set-section">
            <h3>{t('About')}</h3>
            <div className="card">
              <div className="about-hero">
                <div className="logo-mark"><Icon name="logo" /></div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>TeleCloud{pkg.version.includes('-') && <span className="logo-beta">Beta</span>}</div>
                  <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('Version {version} · Local hi-res player with Telegram cloud backup', { version: pkg.version })}</div>
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
        <h2>{t('Settings')}</h2>
        <SettingsSearchBox inputRef={searchRef} query={query} setQuery={setQuery} active={searching} onOpen={() => setSearching(true)} onClose={closeSearch} />
        <div className="nav-items slider-host" ref={navRef}>
          <span className="indicator" />
          {TABS.map(t => (
            <button key={t.id} className={activeTab === t.id && !searching ? 'on' : ''} data-active={activeTab === t.id} onClick={() => { closeSearch(); setActiveTab(t.id); }}>
              <Icon name={t.icon} />{t.label}
            </button>
          ))}
        </div>
      </nav>

      {searching
        ? <div className="settings-body" key="search"><SettingsResults query={query} topics={topics} setTopics={setTopics} tabs={TABS} onPick={pick} /></div>
        : <div className="settings-body" key={activeTab}>{renderTab()}</div>}

      <Dialog open={showClearInfoModal} onClose={() => setShowClearInfoModal(false)} title={t('What gets cleared?')} icon="info" width={520}
        actions={<button className="btn-primary" onClick={() => setShowClearInfoModal(false)}>{t('Got it')}</button>}>
        <h4>{t('Cache')}</h4>
        <ul><li>{t('Album art extracted from your files')}</li><li>{t('Temporary image files')}</li></ul>
        <h4>{t('Database')}</h4>
        <ul><li>{t('Track metadata (title, artist, album, genre)')}</li><li>{t('Format info (bit depth, sample rate, duration)')}</li><li>{t('Scan timestamps')}</li></ul>
        <div style={{ marginTop: 14 }}><Callout tone="ok">{t('Your music files stay exactly where they are — only cached information is removed.')}</Callout></div>
        <h4>{t('Afterwards')}</h4>
        <ul><li>{t('The library is empty until you run a full scan')}</li><li>{t('Metadata and cover art are read again from the files')}</li></ul>
      </Dialog>

      <Dialog open={showClearConfirmModal} onClose={() => setShowClearConfirmModal(false)} title={t('Clear cache & database?')} icon="alert" tone="danger"
        actions={<>
          <button className="btn-ghost" onClick={() => setShowClearConfirmModal(false)}>{t('Cancel')}</button>
          <button className="btn-danger" onClick={handleClearCache}>{t('Clear everything')}</button>
        </>}>
        <p>{t('All cached metadata and cover art will be removed. Your library will look empty until you run a full scan.')}</p>
        <div style={{ marginTop: 12 }}><Callout tone="ok">{t('Your music files will not be deleted.')}</Callout></div>
      </Dialog>
    </div>
  );
};

export default SettingsView;
