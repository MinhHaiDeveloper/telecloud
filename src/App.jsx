import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import SongList from './components/SongList';
import PlayerBar from './components/PlayerBar';
import Homepage from './components/Homepage';
import FavoritesView from './components/FavoritesView';
import RecentView from './components/RecentView';
import PlaylistsView from './components/PlaylistsView';
import ArtistsView from './components/ArtistsView';
import AlbumsView from './components/AlbumsView';
import SpectrumModal from './components/SpectrumModal';
import RightPanel from './components/RightPanel';
import NowPlayingFullscreen from './components/NowPlayingFullscreen';
import Icon from './components/Icon';
import SearchView from './components/SearchView';
import SettingsView from './components/SettingsView';
import EqSettingsView from './components/EqSettingsView';
import Modal from './components/Modal'; // Import the new Modal component
import { albumIndex } from './utils/albums';
import { isTheme, themeKind } from './utils/themes';
import useCoverAccent from './hooks/useCoverAccent';
import { computeSignalPath, matchesSource, storageOf, qualityOf, findDuplicates, dedupeTracks, coverTargets, albumQuery, bumpCovers, bumpArtist, setCoverPreview, clearCoverPreview } from './utils/audio';
import { DialogHost, confirmDialog, alertDialog, Progress } from './components/ui';
import useEq from './hooks/useEq';
import StorageDialog from './components/StorageDialog';
import { SOURCE_HELP, QUALITY_HELP } from './utils/badges';
import OverflowTooltip from './components/OverflowTooltip';
import SongActions from './components/songActions';
import Presence from './components/Presence';
import DashboardView from './components/DashboardView';
import TitleBar from './components/TitleBar';
import FpsMeter from './components/FpsMeter';
import LyricsDialog from './components/LyricsDialog';
import MetadataDialog from './components/MetadataDialog';
import { WhatsNewDialog } from './components/WhatsNew';
import { notesToShow } from './utils/whatsNew';
import pkg from '../package.json';
import CoverDialog from './components/CoverDialog';
import { useUpdateStatus } from './components/UpdateStatus';

// localStorage can throw (private mode, blocked storage); UI prefs are optional
const readPref = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writePref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

// Fisher–Yates
const shuffleArray = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function App() {
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false); // State for the new modal
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const handleTrackEndedRef = useRef(null); // Stable ref to handleTrackEnded to avoid stale closures
  const playerEventsRef = useRef({});
  const handleDeviceChangeRef = useRef(null);
  const unshuffledQueueRef = useRef(null);
  const toastTimeoutRef = useRef(null); // Ref to store toast timeout ID
  const isScanningRef = useRef(false); // Ref to prevent concurrent scans
  const [musicFiles, setMusicFiles] = useState([]);
  const [playQueue, setPlayQueue] = useState([]);
  const [currentFile, setCurrentFile] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('-1');
  const applyDevicesRef = useRef(null);
  const lostDeviceRef = useRef(null); // the output that went away, to go back to when it returns
  const [volume, setVolume] = useState(() => {
    const v = Number(readPref('tc-volume'));
    return Number.isFinite(v) && readPref('tc-volume') !== null ? Math.max(0, Math.min(100, v)) : 100;
  });
  const [audioOut, setAudioOut] = useState(null);
  const [dsdInfo, setDsdInfo] = useState(null); // how the DSD file playing reaches the DAC
  const [outputInfo, setOutputInfo] = useState(null); // the device in use: name, Bluetooth
  const showToastRef = useRef(null);
  const [libraryReady, setLibraryReady] = useState(false);
  const [advanceTick, setAdvanceTick] = useState(0); // bumps on every gapless advance

  const [loopMode, setLoopMode] = useState('none'); // 'none', 'all', 'one'
  const [isShuffle, setIsShuffle] = useState(false);

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => readPref('tc-sidebar-collapsed') === '1');
  const [searchQuery, setSearchQuery] = useState('');
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [downloadToasts, setDownloadToasts] = useState([]);
  const [currentView, setCurrentView] = useState('home');

  const [favorites, setFavorites] = useState([]);
  const [recentPlayed, setRecentPlayed] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [disabledDevices, setDisabledDevices] = useState([]);

  const [currentFolderPath, setCurrentFolderPath] = useState(localStorage.getItem('musicFolderPath') || '');
  const [musicFolderList, setMusicFolderList] = useState([]);

  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState('success');
  const [playlistModalData, setPlaylistModalData] = useState(null);
  const [spectrumFile, setSpectrumFile] = useState(null);
  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [artistTab, setArtistTab] = useState('songs');
  // Extra copies of the same track: skipped everywhere unless turned off (Settings -> Library)
  const [skipDuplicates, setSkipDuplicatesState] = useState(true);
  useEffect(() => { window.ipcRenderer.invoke('load-store', 'settings').then(s => { if (s && s.skipDuplicates === false) setSkipDuplicatesState(false); }).catch(() => {}); }, []);
  const saveSetting = async (patch) => {
    const s = (await window.ipcRenderer.invoke('load-store', 'settings')) || {};
    await window.ipcRenderer.invoke('save-store', 'settings', { ...(Array.isArray(s) ? {} : s), ...patch });
  };
  const setSkipDuplicates = (v) => { setSkipDuplicatesState(v); return saveSetting({ skipDuplicates: v }); };
  // the Artists page: album artists only ('album', the default) or everyone credited ('all')
  const [artistFilter, setArtistFilterState] = useState('album');
  useEffect(() => { window.ipcRenderer.invoke('load-store', 'settings').then(s => { if (s?.artistFilter === 'all') setArtistFilterState('all'); }).catch(() => {}); }, []);
  const setArtistFilter = (v) => { setArtistFilterState(v); return saveSetting({ artistFilter: v }); };
  const [theme, setTheme] = useState(() => {
    const saved = readPref('tc-theme');
    if (isTheme(saved)) return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  // New shell UI state
  const [sourceFilter, setSourceFilter] = useState('all'); // 'all' | 'local' | 'cloud'
  const [lyricsCollapsed, setLyricsCollapsed] = useState(() => readPref('tc-lyrics-collapsed') === '1');
  const [nowPlaying, setNowPlaying] = useState(null); // null, or { panel } when the full-window view is open
  const [audioSettings, setAudioSettings] = useState({});
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
  const [createPlaylistSignal, setCreatePlaylistSignal] = useState(0);
  // TeleCloud storages (up to 5 chats) and the "Back up to…" dialog
  const [storages, setStorages] = useState([]);
  const [storageDialog, setStorageDialog] = useState(null); // { files, label }
  const [tcStorageFilter, setTcStorageFilter] = useState('all');
  const refreshStorages = useCallback(() => {
    window.ipcRenderer.invoke('telecloud-sync:storages').then(r => setStorages(r?.success ? r.storages : [])).catch(() => setStorages([]));
  }, []);
  useEffect(() => { refreshStorages(); }, [syncStatus?.isAuthenticated, currentView, refreshStorages]);
  useEffect(() => {
    const onStopped = () => refreshStorages();
    window.ipcRenderer.on('telecloud-sync:stopped', onStopped);
    return () => window.ipcRenderer.removeListener('telecloud-sync:stopped', onStopped);
  }, [refreshStorages]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref('tc-theme', theme);
    writePref(`tc-theme-${themeKind(theme)}`, theme); // what the top bar button comes back to
  }, [theme]);
  useEffect(() => writePref('tc-sidebar-collapsed', isSidebarCollapsed ? '1' : '0'), [isSidebarCollapsed]);
  useEffect(() => writePref('tc-lyrics-collapsed', lyricsCollapsed ? '1' : '0'), [lyricsCollapsed]);

  // Audio settings feed the signal path; they change from Settings, so refresh on navigation
  useEffect(() => {
    window.ipcRenderer.invoke('get-audio-settings').then(s => s && setAudioSettings(s)).catch(() => {});
  }, [currentView, currentFile]);

  // TeleCloud status for the home card and sidebar
  useEffect(() => {
    const ipc = window.ipcRenderer;
    const refresh = () => ipc.invoke('telecloud-sync:check-auth').then(r => r?.success && setSyncStatus(r)).catch(() => {});
    refresh();
    let idle;
    const onProgress = (event, p) => {
      setSyncProgress(p);
      // The backend has no "finished" event; hide the bar once updates stop arriving
      clearTimeout(idle);
      idle = setTimeout(() => { setSyncProgress(null); refresh(); }, 15000);
    };
    const onStopped = () => { setSyncProgress(null); refresh(); };
    ipc.on('telecloud-sync:progress', onProgress);
    ipc.on('telecloud-sync:stopped', onStopped);
    const timer = setInterval(refresh, 60000);
    return () => {
      ipc.removeListener('telecloud-sync:progress', onProgress);
      ipc.removeListener('telecloud-sync:stopped', onStopped);
      clearInterval(timer);
      clearTimeout(idle);
    };
  }, []);

  // EQ (bands, history, AutoEQ choices; persisted and sent to the player by the hook)
  const eq = useEq(selectedDevice);
  const eqEnabled = eq.enabled;
  const setEqEnabled = eq.setEnabled;

  // Keyboard shortcuts state
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
  const [isMuted, setIsMuted] = useState(false);

  // Scan progress state
  const [scanProgress, setScanProgress] = useState(null); // { type: 'scanning'|'refreshing', status: 'inProgress'|'done', message: string }

  // 🛡️ Ref to track previous folder list and prevent unnecessary watcher restarts
  const previousFoldersRef = useRef(null);

  // 🛡️ Ref to track current file for event listeners (avoids re-registering on every track change)
  const currentFileRef = useRef(currentFile);

  // ---- Listening history: count a play once enough of the track was actually heard
  const [playCounts, setPlayCounts] = useState({});
  useEffect(() => {
    // the history can grow from elsewhere too (other windows, imports): re-read the counts when it does
    let t = null;
    const load = () => window.ipcRenderer.invoke('stats:counts').then(c => setPlayCounts(c || {})).catch(() => {});
    const onChange = () => { clearTimeout(t); t = setTimeout(load, 400); };
    load();
    window.ipcRenderer.on('stats:changed', onChange);
    // the library changed (files moved, renamed, rescanned): re-read, which re-attaches moved tracks
    window.addEventListener('telecloud:library-changed', onChange);
    return () => { clearTimeout(t); window.ipcRenderer.removeListener?.('stats:changed', onChange); window.removeEventListener('telecloud:library-changed', onChange); };
  }, []);
  const listenRef = useRef({ path: null });

  // tell the play counts (and the Dashboard) when the set of library paths changes
  useEffect(() => { if (musicFiles.length) window.dispatchEvent(new Event('telecloud:library-changed')); }, [musicFiles]);

  // ---- Lyrics: the dialog, and lyrics found online for the playing track (shown before they are saved)
  const [lyricsFile, setLyricsFile] = useState(null);
  const [lyricsFound, setLyricsFound] = useState(null); // { path, label, lyrics }
  const [metaFiles, setMetaFiles] = useState(null); // tracks open in the tag editor
  const update = useUpdateStatus();
  const [showFps, setShowFps] = useState(() => { try { return localStorage.getItem('show-fps') === '1'; } catch { return false; } });
  useEffect(() => {
    const on = () => { try { setShowFps(localStorage.getItem('show-fps') === '1'); } catch { /* ignore */ } };
    window.addEventListener('telecloud:fps', on);
    return () => window.removeEventListener('telecloud:fps', on);
  }, []);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    const onSaved = (e, { path, lyrics }) => {
      const patchFile = (f) => (f && f.path === path ? { ...f, metadata: { ...f.metadata, lyrics } } : f);
      setMusicFiles(prev => prev.map(patchFile));
      setCurrentFile(patchFile);
      setLyricsFound(f => (f?.path === path ? null : f));
    };
    window.ipcRenderer.on('lyrics:saved', onSaved);
    return () => window.ipcRenderer.removeListener?.('lyrics:saved', onSaved);
  }, []);
  // Last.fm "now playing" (ignored when no account is connected)
  useEffect(() => {
    const m = currentFile?.metadata;
    if (!m) return;
    window.ipcRenderer.invoke('lastfm:now-playing', { artist: m.artist, title: m.title || currentFile.name, album: m.album, duration: m.duration }).catch(() => {});
  }, [currentFile?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = currentFile;
    setLyricsFound(null);
    if (!f || f.metadata?.lyrics) return undefined;
    let alive = true;
    (async () => {
      const o = await window.ipcRenderer.invoke('lyrics:options').catch(() => null);
      if (!o?.search || !alive) return;
      const m = f.metadata || {};
      const r = await window.ipcRenderer.invoke('lyrics:search', { track: { path: f.path, title: m.title || f.name, artist: m.artist, album: m.album, duration: m.duration } }).catch(() => null);
      const best = r?.results?.find(x => x.score >= 0.7);
      if (!alive || !best) return;
      if (o.autoSave) window.ipcRenderer.invoke('lyrics:save', { path: f.path, lyrics: best.lyrics });
      else setLyricsFound({ path: f.path, label: o.sources?.[best.source]?.label || best.source, lyrics: best.lyrics });
    })();
    return () => { alive = false; };
  }, [currentFile?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  // ---- What's new: once, the first time this version opens after an update
  const [whatsNew, setWhatsNew] = useState(null);
  useEffect(() => {
    window.ipcRenderer.invoke('load-store', 'settings').then(async (s) => {
      const settings = s && !Array.isArray(s) ? s : {};
      const notes = notesToShow(settings.lastSeenVersion, pkg.version, !!settings.musicFolderList?.length);
      if (notes.length) setWhatsNew(notes);
      if (settings.lastSeenVersion !== pkg.version) {
        const fresh = (await window.ipcRenderer.invoke('load-store', 'settings')) || {};
        await window.ipcRenderer.invoke('save-store', 'settings', { ...(Array.isArray(fresh) ? {} : fresh), lastSeenVersion: pkg.version });
      }
    }).catch(() => {});
  }, []);

  // ---- Discord status: tell the main process what is playing; seeks show up as a jump in time
  const discordSent = useRef({ path: null, pos: 0, at: 0 });
  const sendDiscord = (file, playing, position) => {
    discordSent.current = { path: file?.path || null, pos: position, at: performance.now(), playing };
    const m = file?.metadata;
    window.ipcRenderer.invoke('discord:update', {
      track: file ? { path: file.path, title: m?.title || file.name, artist: m?.artist, album: m?.album, albumArtist: m?.albumArtist, duration: m?.duration || 0 } : null,
      playing, position,
    }).catch(() => {});
  };
  useEffect(() => { sendDiscord(currentFile, isPlaying, currentTime); }, [currentFile?.path, currentFile?.metadata?.title, currentFile?.metadata?.artist, currentFile?.metadata?.album, isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const d = discordSent.current;
    if (!currentFile || d.path !== currentFile.path) return;
    const expected = d.pos + (d.playing ? (performance.now() - d.at) / 1000 : 0);
    if (Math.abs(currentTime - expected) > 2.5) sendDiscord(currentFile, isPlaying, currentTime);
  }, [currentTime]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Album covers: the dialog, and a cover found online for the playing album (shown before it is saved)
  const [coverFiles, setCoverFiles] = useState(null);
  const [coverFound, setCoverFound] = useState(null); // { paths, label, image }
  useEffect(() => {
    const onSaved = (e, { paths, files }) => {
      const byPath = new Map((files || []).map(f => [f.path, f]));
      if (byPath.size) {
        setMusicFiles(prev => prev.map(f => byPath.get(f.path) || f));
        setCurrentFile(f => (f && byPath.has(f.path) ? byPath.get(f.path) : f));
      }
      bumpCovers(paths);
      setCoverFound(f => (f && paths.some(p => f.paths.includes(p)) ? null : f));
    };
    window.ipcRenderer.on('covers:saved', onSaved);
    const onArtist = (e, { name }) => bumpArtist(name);
    window.ipcRenderer.on('artists:saved', onArtist);
    // MQA found by reading the audio: the badge and the quality filter follow straight away
    const onMqa = (e, { path: p, mqa, mqaRate }) => setMusicFiles(prev => prev.map(f => (f.path === p ? { ...f, mqa, mqaRate } : f)));
    window.ipcRenderer.on('library:mqa', onMqa);
    return () => {
      window.ipcRenderer.removeListener?.('covers:saved', onSaved);
      window.ipcRenderer.removeListener?.('artists:saved', onArtist);
      window.ipcRenderer.removeListener?.('library:mqa', onMqa);
    };
  }, []);
  useEffect(() => {
    const f = currentFile;
    if (f && coverFound?.paths.includes(f.path)) return undefined; // the next track of the same album
    setCoverFound(null);
    clearCoverPreview();
    if (!f) return undefined;
    let alive = true;
    (async () => {
      const o = await window.ipcRenderer.invoke('covers:options').catch(() => null);
      if (!o?.search || !alive) return;
      if (await window.ipcRenderer.invoke('covers:has', { path: f.path }).catch(() => true)) return;
      const targets = coverTargets([f], musicFiles);
      const q = albumQuery(targets);
      if (!q.album || !alive) return; // nothing to go on: the dialog can still search by hand
      const paths = targets.map(t => t.path);
      const r = await window.ipcRenderer.invoke('covers:search', { query: { ...q, paths }, auto: true }).catch(() => null);
      const best = r?.results?.find(x => x.score >= 0.7);
      if (!alive || !best) return;
      if (o.autoSave) window.ipcRenderer.invoke('covers:save', { paths, image: best.image, onlyMissing: true });
      else {
        setCoverPreview(paths, best.thumb);
        setCoverFound({ paths, label: o.sources?.[best.source]?.label || best.source, image: best.image });
      }
    })();
    return () => { alive = false; };
  }, [currentFile?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const flushListen = () => {
    const r = listenRef.current;
    listenRef.current = { path: null };
    if (!r.file || r.listened < 1) return;
    const m = r.file.metadata || {};
    window.ipcRenderer.invoke('stats:add-play', {
      path: r.file.path, startedAt: r.startedAt, listenedMs: r.listened * 1000, durationMs: (m.duration || 0) * 1000,
      title: m.title || r.file.name, artist: m.artist, album: m.album, quality: qualityOf(r.file).tier,
    }).catch(() => {});
  };
  useEffect(() => {
    const r = listenRef.current;
    const path = currentFile?.path || null;
    if (path !== r.path) {
      flushListen();
      listenRef.current = { path, file: currentFile, listened: 0, last: currentTime, startedAt: Date.now() };
      return;
    }
    if (!path) return;
    const d = currentTime - r.last;
    if (isPlaying && d > 0 && d < 3) r.listened += d; // normal progress; seeks don't count as listening
    else if (d < -5 && currentTime < 3 && r.listened > 0) { // the same track started over (repeat one)
      flushListen();
      listenRef.current = { path, file: currentFile, listened: 0, last: currentTime, startedAt: Date.now() };
      return;
    }
    r.last = currentTime;
    r.file = currentFile;
  }, [currentTime, currentFile, isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onUnload = () => flushListen();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep currentFileRef in sync with currentFile
  useEffect(() => {
    currentFileRef.current = currentFile;
  }, [currentFile]);


  // Expose global function to open EQ
  useEffect(() => {
    window.openEqSettings = () => {
      setCurrentView('settings');
      // Wait a tick for SettingsView to render, but it doesn't support active tab routing easily, so we just set currentView to 'eq-settings'
      setCurrentView('eq-settings');
    };
    return () => { delete window.openEqSettings; };
  }, []);

  // Load keyboard shortcuts from settings
  useEffect(() => {
    const loadShortcuts = async () => {
      const settings = await window.ipcRenderer.invoke('load-store', 'settings');
      if (settings && settings.keyboardShortcuts) {
        setKeyboardShortcuts(settings.keyboardShortcuts);
      }
    };
    loadShortcuts();
  }, []);

  // Folder watcher (main process reads the folders from Settings); restart when the list changes
  useEffect(() => {
    const key = JSON.stringify(musicFolderList);
    if (previousFoldersRef.current === key) return undefined;
    previousFoldersRef.current = key;
    if (musicFolderList.length) window.ipcRenderer.invoke('start-watching');
    else window.ipcRenderer.invoke('stop-watching');
    return undefined;
  }, [musicFolderList]);


  // Global keyboard shortcuts; the handlers live in a ref so the listener is registered once
  const keyActionsRef = useRef({});
  useEffect(() => {
    const REPEATABLE = new Set(['volumeUp', 'volumeDown', 'seekForward', 'seekBackward']);
    let handledSpace = false;
    const comboOf = (e) => {
      const keys = [];
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.shiftKey) keys.push('Shift');
      if (e.altKey) keys.push('Alt');
      let keyName = e.key === ' ' ? 'Space' : e.key;
      if (keyName.length === 1) keyName = keyName.toUpperCase();
      keys.push(keyName);
      return keys.join('+');
    };
    const handleKeyDown = (e) => {
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (t.closest?.('.key-btn.listening, [role="dialog"]')) return; // recording a new shortcut / dialog open
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const combo = comboOf(e);
      const action = Object.keys(keyboardShortcuts).find(k => keyboardShortcuts[k] === combo);
      const fn = action && keyActionsRef.current[action];
      if (!fn) return;
      e.preventDefault();
      if (e.repeat && !REPEATABLE.has(action)) return;
      // a focused button would also "click" on Space; swallow that
      if (e.key === ' ') handledSpace = true;
      fn();
    };
    const handleKeyUp = (e) => {
      if (e.key === ' ' && handledSpace) { e.preventDefault(); handledSpace = false; }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [keyboardShortcuts]);

  const showToast = (msg, type = 'success') => {
    // Clear any existing toast timeout
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }

    setToastMessage(msg);
    setToastType(type);

    // Set new timeout and store its ID
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage('');
      setToastType('success');
      toastTimeoutRef.current = null;
    }, 3000);
  };
  showToastRef.current = showToast;

  useEffect(() => {
    // Skip Telegram auth check - app now works without mandatory Telegram login
    // TeleCloud Sync is now optional via Settings
    setIsAuthenticated(true);
    setIsCheckingAuth(false);
  }, []);

  // The time ticker is now fully event-driven by the 'time-pos' event from player.js
  // The polling useEffect hook has been removed.

  // 🛡️ OPTIMIZATION: Load settings only once on authentication (not on every render)
  useEffect(() => {
    if (!isAuthenticated) return;

    const ipcRenderer = window.ipcRenderer;
    ipcRenderer.invoke('load-store', 'settings').then(settings => {
      if (settings?.disabledDevices) {
        setDisabledDevices(settings.disabledDevices);
      }
      if (settings?.musicFolderList) {
        setMusicFolderList(settings.musicFolderList);
      }
    });
  }, [isAuthenticated]); // Only run when authentication changes

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const on = (e, list) => applyDevicesRef.current?.(list);
    window.ipcRenderer.on('player:devices', on);
    return () => window.ipcRenderer.removeListener?.('player:devices', on);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const ipcRenderer = window.ipcRenderer;
    ipcRenderer.invoke('get-audio-devices').then(devs => {
      setDevices(devs || []);
      const saved = readPref('tc-device');
      if (saved && saved !== '-1' && (devs || []).some(d => d.id === saved)) handleDeviceChangeRef.current?.(saved);
    });

    ipcRenderer.invoke('load-library').then(async (savedFiles) => {
      setMusicFiles(savedFiles || []);
      setLibraryReady(true);
      // Files added or removed while the app was closed show up without pressing Refresh
      const res = await ipcRenderer.invoke('library:sync', { mode: 'refresh', silent: true });
      if (res && !res.busy) {
        if (res.files) setMusicFiles(res.files);
        if (res.added || res.removed) {
          const parts = [];
          if (res.added) parts.push(`${res.added} new ${res.added === 1 ? 'track' : 'tracks'}`);
          if (res.removed) parts.push(`${res.removed} removed`);
          showToast(`Library updated: ${parts.join(', ')}`, 'info');
        }
        if (res.unavailable?.length) {
          showToast(`Music folder not reachable: ${res.unavailable.join(', ')}. Its tracks are kept until it is back.`, 'info');
        }
      }
    });
    ipcRenderer.invoke('load-store', 'favorites').then(data => setFavorites(Array.isArray(data) ? data : []));
    ipcRenderer.invoke('load-store', 'recent').then(data => setRecentPlayed(Array.isArray(data) ? data : []));
    ipcRenderer.invoke('load-store', 'playlists').then(data => setPlaylists(Array.isArray(data) ? data : []));

    const onTime = (event, position) => setCurrentTime(position);
    const onEnded = () => handleTrackEndedRef.current?.();
    const onAdvanced = (event, info) => playerEventsRef.current.advanced?.(info);
    const onState = (event, st) => playerEventsRef.current.state?.(st);
    const onError = (event, err) => playerEventsRef.current.error?.(err);
    const onAudioOut = (event, out) => setAudioOut(out);
    const onDsd = (event, info) => setDsdInfo(info?.mode ? info : null);
    const onOutput = (event, info) => setOutputInfo(info || null);
    ipcRenderer.on('player:output', onOutput);
    const onDsdNotice = (event, text) => showToastRef.current?.(text, 'info');
    ipcRenderer.on('player:dsd', onDsd);
    ipcRenderer.on('player:dsd-notice', onDsdNotice);
    ipcRenderer.on('time-pos', onTime);
    ipcRenderer.on('track-ended', onEnded);
    ipcRenderer.on('player:advanced', onAdvanced);
    ipcRenderer.on('player:state', onState);
    ipcRenderer.on('playback-error', onError);
    ipcRenderer.on('player:audio-out', onAudioOut);
    return () => {
      ['time-pos', 'track-ended', 'player:advanced', 'player:state', 'playback-error', 'player:audio-out']
        .forEach(ch => ipcRenderer.removeAllListeners(ch));
    };
  }, [isAuthenticated]);

  // Separated effect for scan progress to avoid re-registering other listeners
  useEffect(() => {
    if (!isAuthenticated) return;
    const ipcRenderer = window.ipcRenderer;

    const handleScanProgress = (event, progress) => {
      const type = progress.mode === 'full' ? 'scanning' : 'refreshing';
      if (progress.stage === 'complete') {
        setScanProgress({ type, status: 'done', message: progress.message });
        setTimeout(() => setScanProgress(null), 3500);
      } else {
        setScanProgress({ type, status: 'inProgress', message: progress.message, current: progress.current, total: progress.total });
      }
    };

    // Scanned tracks arrive in batches; merge them so the library fills in during the scan
    const handlePartial = (event, { files = [], removed = [], summary }) => {
      if (summary) {
        const parts = [];
        if (summary.added) parts.push(`${summary.added.toLocaleString()} new ${summary.added === 1 ? 'track' : 'tracks'}`);
        if (summary.removed) parts.push(`${summary.removed.toLocaleString()} removed`);
        if (parts.length) showToast(`Library updated: ${parts.join(', ')}`, 'info');
        return;
      }
      if (!files.length && !removed.length) return;
      if (removed.length) playerEventsRef.current.removed?.(new Set(removed));
      setMusicFiles(prev => {
        const gone = new Set(removed);
        const incoming = new Map(files.map(f => [f.path, f]));
        const next = [];
        for (const f of prev) {
          if (gone.has(f.path)) continue;
          if (incoming.has(f.path)) { next.push(incoming.get(f.path)); incoming.delete(f.path); } else next.push(f);
        }
        for (const f of incoming.values()) next.push(f);
        return next;
      });
    };

    ipcRenderer.on('scan-progress', handleScanProgress);
    ipcRenderer.on('library:partial', handlePartial);
    return () => {
      ipcRenderer.removeAllListeners('scan-progress');
      ipcRenderer.removeAllListeners('library:partial');
    };
  }, [isAuthenticated]);

  // Filter recentPlayed to only include files that exist in current library
  useEffect(() => {
    if (isAuthenticated && libraryReady && recentPlayed.length > 0) {
      const validPaths = new Set(musicFiles.map(f => f.path));
      const filteredRecent = recentPlayed.filter(f => f && f.path && validPaths.has(f.path));

      if (filteredRecent.length !== recentPlayed.length) {
        // Clean up stale/invalid paths from recentPlayed
        setRecentPlayed(filteredRecent);
        window.ipcRenderer.invoke('save-store', 'recent', filteredRecent);
        console.log(`[Recent] Cleaned up ${recentPlayed.length - filteredRecent.length} invalid file(s)`);
      }
    }
  }, [musicFiles.length, recentPlayed.length, isAuthenticated, libraryReady]); // Run when either changes

  const handleRefreshFolder = async (isFullScan = false) => {
    if (isScanningRef.current) {
      showToast('A scan is already running…', 'info');
      return;
    }
    isScanningRef.current = true;
    const type = isFullScan ? 'scanning' : 'refreshing';
    setScanProgress({ type, status: 'inProgress', message: isFullScan ? 'Re-reading every file…' : 'Looking for changes…' });
    try {
      const res = await window.ipcRenderer.invoke('library:sync', { mode: isFullScan ? 'full' : 'refresh' });
      if (res?.busy) {
        setScanProgress(null);
        showToast('A scan is already running…', 'info');
        return;
      }
      if (res.files) setMusicFiles(res.files);
    } catch (err) {
      console.error(err);
      setScanProgress({ type, status: 'done', message: `Scan failed: ${err.message}` });
      setTimeout(() => setScanProgress(null), 4000);
    } finally {
      isScanningRef.current = false;
    }
  };

  const handleToggleFavorite = (file) => {
    let newFavs;
    if (favorites.some(f => f.path === file.path)) {
      newFavs = favorites.filter(f => f.path !== file.path);
      showToast('Removed from favorites');
    } else {
      newFavs = [...favorites, file];
      showToast('Added to favorites');
    }
    setFavorites(newFavs);
    window.ipcRenderer.invoke('save-store', 'favorites', newFavs);
  };

  // One track, or several (an album, a selection): the second argument is the full list
  const handleAddPlaylist = (file, files) => {
    if (playlists.length === 0) {
      showToast("Please create a playlist first in the Playlists tab.");
      return;
    }
    setPlaylistModalData(files && files.length ? files : [file]);
  };

  const confirmAddPlaylist = (playlistId, files) => {
    const target = playlists.find(p => p.id === playlistId);
    const fresh = target ? files.filter(f => !target.songs.some(s => s.path === f.path)) : [];
    if (fresh.length) {
      const newPlaylists = playlists.map(p => (p.id === target.id ? { ...p, songs: [...p.songs, ...fresh] } : p));
      setPlaylists(newPlaylists);
      window.ipcRenderer.invoke('save-store', 'playlists', newPlaylists);
      showToast(fresh.length === 1 ? `Added to playlist: ${target.name}` : `Added ${fresh.length} tracks to ${target.name}`);
    } else {
      showToast(files.length === 1 ? 'Song is already in the playlist.' : 'All of them are already in the playlist.');
    }
    setPlaylistModalData(null);
  };

  // Delete tracks from the TeleCloud storage that holds them (the rest of the storage stays)
  const handleRemoveFromCloud = async (files) => {
    const inCloud = files.filter(f => f.telegram_message_id);
    if (!inCloud.length) return;
    const names = [...new Set(inCloud.map(f => storages.find(s => String(s.peerId) === String(f.telegram_channel_id))?.title || 'TeleCloud'))];
    const cloudOnly = inCloud.filter(f => (f.storage_type || 'local') === 'cloud' || f.path.startsWith('tc://')).length;
    const what = inCloud.length === 1 ? `“${inCloud[0].metadata?.title || inCloud[0].name}”` : `${inCloud.length} tracks`;
    const ok = await confirmDialog({
      title: `Remove ${what} from TeleCloud?`,
      message: `Deleted from ${names.join(', ')} on Telegram. Other tracks there stay.`
        + (inCloud.length - cloudOnly ? `\n${inCloud.length - cloudOnly} with a file on this computer stay in your library as local tracks.` : '')
        + (cloudOnly ? `\n${cloudOnly} exist only in TeleCloud: they leave your library for good.` : ''),
      confirmLabel: 'Remove from TeleCloud',
      danger: true,
    });
    if (!ok) return;
    const r = await window.ipcRenderer.invoke('telecloud-sync:remove-from-cloud', { paths: inCloud.map(f => f.path) });
    if (!r?.success) { showToast(`Could not remove: ${r?.error || 'unknown error'}`, 'error'); return; }
    showToast(`Removed ${r.deleted} ${r.deleted === 1 ? 'track' : 'tracks'} from TeleCloud`, 'info');
    refreshStorages();
  };

  // Each playMusic call gets a number; a slower earlier call (e.g. a cloud download) must not
  // start playing or overwrite the state after the user already picked another track
  const playTokenRef = useRef(0);
  const streamUrlsRef = useRef(new Map()); // stream URL -> library path (to follow gapless advances)
  const [stream, setStream] = useState(null); // download state of the cloud track that is playing
  useEffect(() => {
    const onStream = (e, p) => {
      setStream(cur => {
        if (!cur || cur.path !== p.path) return cur;
        if (p.error) return { ...cur, error: p.error };
        return { ...cur, ranges: p.ranges || cur.ranges, speed: p.speed ?? cur.speed, complete: !!p.complete };
      });
      if (p.error && currentFileRef.current?.path === p.path) showToast(`TeleCloud: ${p.error}`, 'error');
    };
    window.ipcRenderer.on('telecloud-sync:stream', onStream);
    return () => window.ipcRenderer.removeListener('telecloud-sync:stream', onStream);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const playMusic = async (file, index, contextList = null, { keepQueue = false } = {}) => {
    const token = ++playTokenRef.current;
    try {
      let listToPlay = contextList || musicFiles;
      let indexToPlay = index;
      if (!keepQueue && skipDuplicates) {
        // the same album in two folders plays once (the track you clicked stays the one that plays)
        const unique = dedupeTracks(listToPlay, file.path);
        if (unique !== listToPlay) { listToPlay = unique; indexToPlay = unique.findIndex(f => f.path === file.path); }
      }
      if (!keepQueue) {
        unshuffledQueueRef.current = listToPlay;
        if (isShuffle) {
          // Shuffle once: the chosen track first, the rest in random order (no repeats)
          listToPlay = [file, ...shuffleArray(listToPlay.filter(f => f.path !== file.path))];
          indexToPlay = 0;
        }
      }
      const ipcRenderer = window.ipcRenderer;
      let filePath = null; // Don't pre-initialize with file.path - must explicitly set valid path

      // Local file first; otherwise the TeleCloud copy: the cached file, or a stream that starts
      // right away and fills the cache as it plays
      const storageType = file.storage_type || 'local';
      let streaming = false;
      let fromCloudCache = false;
      if (storageType !== 'cloud' && !file.path.startsWith('tc://') && await ipcRenderer.invoke('check-file-exists', file.path)) {
        filePath = file.path;
      } else {
        // the library row in the database knows best whether a TeleCloud copy exists
        const res = await ipcRenderer.invoke('telecloud-sync:stream-track', file.path);
        if (!res?.success) throw new Error(/not in TeleCloud/.test(res?.error || '') ? 'This file is missing and has no TeleCloud copy' : (res?.error || 'Could not reach TeleCloud'));
        filePath = res.path;
        streaming = res.streaming;
        fromCloudCache = !res.streaming;
        if (streaming) streamUrlsRef.current.set(res.path, file.path);
      }

      // --- Validate we have a valid path before playing ---
      if (!filePath) {
        throw new Error('Could not determine file path - file not available locally, in cache, or on cloud');
      }

      if (token !== playTokenRef.current) return;
      setStream(streaming ? { path: file.path, ranges: [], speed: 0 } : fromCloudCache ? { path: file.path, ranges: [], complete: true } : null);
      // --- Play with MPV (works for local files and URLs) ---
      await ipcRenderer.invoke('play-audio', { filePath, deviceId: selectedDevice });
      if (token !== playTokenRef.current) return;

      // Volume for exclusive vs software
      if (selectedDevice !== '-1') {
        ipcRenderer.invoke('set-volume', 100);
      } else {
        ipcRenderer.invoke('set-volume', volume);
      }

      setCurrentFile(file);
      setPlayQueue(listToPlay);
      setCurrentIndex(indexToPlay);
      setIsPlaying(true);
      setCurrentTime(0);
      addToRecent(file);
    } catch (err) {
      console.error(err);
      if (token === playTokenRef.current) showToast(`Playback error: ${err.message}`, 'error');
    }
  };

  const addToRecent = (file) => {
    setRecentPlayed(prev => {
      const next = [file, ...prev.filter(f => f.path !== file.path)].slice(0, 50);
      window.ipcRenderer.invoke('save-store', 'recent', next);
      return next;
    });
  };

  // Flip the button right away; mpv's own pause event confirms (or corrects) it
  const handleTogglePlay = () => {
    if (!currentFile) return;
    const pause = isPlaying;
    setIsPlaying(!pause);
    window.ipcRenderer.invoke('pause-audio', pause);
  };

  // Index that follows `idx` in the queue, or -1 at the end (loop "all" wraps around)
  const followingIndex = (idx) => {
    if (!playQueue.length) return -1;
    if (idx + 1 < playQueue.length) return idx + 1;
    return loopMode === 'all' ? 0 : -1;
  };

  const handleNext = () => {
    const idx = followingIndex(currentIndex);
    if (idx < 0) {
      window.ipcRenderer.invoke('stop-audio');
      setIsPlaying(false);
      setCurrentTime(0);
      return;
    }
    playMusic(playQueue[idx], idx, playQueue, { keepQueue: true });
  };

  const handlePrev = () => {
    if (!playQueue.length) return;
    // Like most players: first press restarts the track, a quick second press goes back
    if (currentTime > 3) { handleSeek(0); return; }
    let idx = currentIndex - 1;
    if (idx < 0) idx = loopMode === 'all' ? playQueue.length - 1 : 0;
    playMusic(playQueue[idx], idx, playQueue, { keepQueue: true });
  };

  // Only reached when mpv had nothing queued (e.g. the next track is cloud-only)
  const handleTrackEnded = () => {
    if (loopMode === 'one' && currentFile) playMusic(currentFile, currentIndex, playQueue, { keepQueue: true });
    else handleNext();
  };
  handleTrackEndedRef.current = handleTrackEnded;

  const handleToggleShuffle = () => {
    if (!isShuffle) {
      unshuffledQueueRef.current = playQueue;
      if (currentFile && playQueue.length > 1) {
        setPlayQueue([currentFile, ...shuffleArray(playQueue.filter(f => f.path !== currentFile.path))]);
        setCurrentIndex(0);
      }
    } else {
      const original = unshuffledQueueRef.current || playQueue;
      const idx = currentFile ? original.findIndex(f => f.path === currentFile.path) : -1;
      setPlayQueue(original);
      setCurrentIndex(idx >= 0 ? idx : 0);
    }
    setIsShuffle(s => !s);
  };

  // Tell mpv which file comes next so the switch is gapless. A cloud-only track is opened as a
  // stream now, which also starts downloading it ahead of time.
  const upcomingFile = !currentFile ? null
    : loopMode === 'one' ? currentFile
    : (followingIndex(currentIndex) >= 0 ? playQueue[followingIndex(currentIndex)] : null);
  const upcomingIsCloud = !!upcomingFile && ((upcomingFile.storage_type || 'local') === 'cloud' || upcomingFile.path.startsWith('tc://'));
  const upcomingPath = upcomingFile ? (upcomingIsCloud ? upcomingFile.cache_path || null : upcomingFile.path) : null;
  useEffect(() => {
    if (!currentFile) return undefined;
    let cancelled = false;
    (async () => {
      let next = upcomingPath || null;
      if (upcomingIsCloud && upcomingFile?.telegram_message_id) {
        const res = await window.ipcRenderer.invoke('telecloud-sync:stream-track', upcomingFile.path);
        if (res?.success) { next = res.path; if (res.streaming) streamUrlsRef.current.set(res.path, upcomingFile.path); }
      }
      if (!cancelled) window.ipcRenderer.invoke('player:set-next', next);
    })();
    return () => { cancelled = true; };
  }, [currentFile?.path, upcomingFile?.path, upcomingPath, advanceTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Player events need the latest state; keep the handlers in a ref
  playerEventsRef.current = {
    advanced: (info) => {
      setAdvanceTick(t => t + 1);
      if (loopMode === 'one') { setCurrentTime(0); return; }
      // Follow the file mpv actually moved to; the queue may have changed after it was preloaded
      const playable = (f) => ((f.storage_type || 'local') !== 'cloud' ? f.path : f.cache_path);
      const streamed = info?.path && streamUrlsRef.current.get(info.path);
      const matches = (f) => (streamed ? f.path === streamed : playable(f) === info?.path);
      const expected = followingIndex(currentIndex);
      let idx = expected >= 0 && matches(playQueue[expected]) ? expected : -1;
      if (idx < 0 && info?.path) idx = playQueue.findIndex(matches);
      if (idx < 0) idx = expected;
      if (idx < 0) return;
      const file = playQueue[idx];
      setStream(streamed ? { path: file.path, ranges: [], speed: 0 } : null);
      setCurrentIndex(idx);
      setCurrentFile(file);
      setCurrentTime(0);
      setIsPlaying(true);
      addToRecent(file);
    },
    // Tracks deleted on disk: stop if it is the one playing, and take them out of the queue
    removed: (gone) => {
      // these rows left the library (file deleted, or a cloud-only track removed from TeleCloud)
      if (currentFile && gone.has(currentFile.path)) {
        window.ipcRenderer.invoke('stop-audio');
        setIsPlaying(false);
        setCurrentFile(null);
        setCurrentTime(0);
      }
      if (!playQueue.some(f => gone.has(f.path))) return;
      const keep = (f) => !gone.has(f.path);
      const next = playQueue.filter(keep);
      setPlayQueue(next);
      if (currentFile && keep(currentFile)) setCurrentIndex(next.findIndex(f => f.path === currentFile.path));
      if (unshuffledQueueRef.current) unshuffledQueueRef.current = unshuffledQueueRef.current.filter(keep);
    },
    // mpv reports pause=false while idle at startup; nothing is playing without a track
    state: ({ paused, stopped }) => setIsPlaying(!paused && !stopped && !!currentFile),
    error: ({ error }) => {
      setIsPlaying(false);
      showToast(`Playback error: ${error}`, 'error');
    },
  };

  const handleVolumeChange = (newVol) => {
    if (selectedDevice !== '-1') return; // Locked at 100% in exclusive mode
    const v = Math.max(0, Math.min(100, Math.round(newVol)));
    if (isMuted) setMuted(false);
    setVolume(v);
    writePref('tc-volume', String(v));
    window.ipcRenderer.invoke('set-volume', v);
  };

  // Mute is mpv's own switch: works in exclusive mode too, and the volume level is kept
  const setMuted = (on) => {
    setIsMuted(on);
    window.ipcRenderer.invoke('set-mute', on);
  };
  const handleToggleMute = () => setMuted(!isMuted);

  const handleToggleLoop = () => {
    if (loopMode === 'none') setLoopMode('all');
    else if (loopMode === 'all') setLoopMode('one');
    else setLoopMode('none');
  };

  const handleDeviceChange = async (deviceId) => {
    lostDeviceRef.current = null;
    const res = await window.ipcRenderer.invoke('set-audio-device', deviceId);
    if (res && res.success === false) {
      showToast(`Could not switch output: ${res.error}`, 'error');
      return;
    }
    setSelectedDevice(deviceId);
    writePref('tc-device', deviceId);
    if (deviceId === '-1') window.ipcRenderer.invoke('set-volume', volume);
  };
  handleDeviceChangeRef.current = handleDeviceChange;

  // Outputs come and go: Bluetooth turned off, a DAC unplugged. Playback moves to System default and
  // comes back when that output does.
  applyDevicesRef.current = async (list) => {
    if (!Array.isArray(list)) return;
    const has = (id) => list.some(d => (d.deviceId || d.id) === id);
    const label = (d) => (d?.name || 'That output').replace(/ \(WASAPI\)$/, '');
    const was = devices;
    setDevices(list);
    if (selectedDevice !== '-1' && !has(selectedDevice)) {
      const gone = selectedDevice;
      await handleDeviceChange('-1');
      lostDeviceRef.current = gone;
      writePref('tc-device', gone); // still the one to use when it is there at the next start
      showToast(`${label(was.find(d => (d.deviceId || d.id) === gone))} is gone. Playing through System default.`, 'info');
    } else if (selectedDevice === '-1' && lostDeviceRef.current && has(lostDeviceRef.current)) {
      const back = list.find(d => (d.deviceId || d.id) === lostDeviceRef.current);
      await handleDeviceChange(lostDeviceRef.current);
      showToast(`${label(back)} is back.`, 'info');
    }
  };

  const handleSeek = (timePos) => {
    const t = Math.max(0, Math.min(timePos, currentFile?.metadata?.duration || timePos));
    setCurrentTime(t);
    window.ipcRenderer.invoke('seek-audio', t);
  };

  keyActionsRef.current = {
    playPause: handleTogglePlay,
    next: handleNext,
    previous: () => { if (currentTime > 3) handleSeek(0); else handlePrev(); },
    volumeUp: () => (selectedDevice !== '-1' ? showToast('Volume stays at 100% in exclusive mode (bit-perfect). Use Mute or your DAC.', 'info') : handleVolumeChange(volume + 5)),
    volumeDown: () => (selectedDevice !== '-1' ? showToast('Volume stays at 100% in exclusive mode (bit-perfect). Use Mute or your DAC.', 'info') : handleVolumeChange(volume - 5)),
    seekForward: () => currentFile && handleSeek(currentTime + 5),
    seekBackward: () => currentFile && handleSeek(currentTime - 5),
    toggleMute: handleToggleMute,
  };

  const handleDeleteSong = async (file, skipConfirm = false) => {
    if (skipConfirm || await confirmDialog({
      title: 'Delete this track?',
      message: `"${file.metadata?.title || file.name}" will be removed from your library and the file is moved to the Recycle Bin.`,
      confirmLabel: 'Delete track',
      danger: true,
    })) {
      const ipcRenderer = window.ipcRenderer;
      const result = await ipcRenderer.invoke('delete-song', file);
      if (result?.success) {
        if (currentFileRef.current?.path === file.path) {
          ipcRenderer.invoke('stop-audio');
          setIsPlaying(false);
          setCurrentFile(null);
        }
        // Remove from library
        setMusicFiles(prev => prev.filter(f => f.path !== file.path));

        // Remove from favorites if present
        setFavorites(prev => {
          const updated = prev.filter(f => f.path !== file.path);
          if (updated.length !== prev.length) {
            ipcRenderer.invoke('save-store', 'favorites', updated);
          }
          return updated;
        });

        // Remove from all playlists if present
        setPlaylists(prev => {
          const updated = prev.map(playlist => ({
            ...playlist,
            songs: playlist.songs.filter(s => s.path !== file.path)
          }));
          // Check if any playlist was modified
          if (JSON.stringify(updated) !== JSON.stringify(prev)) {
            ipcRenderer.invoke('save-store', 'playlists', updated);
          }
          return updated;
        });

        if (!skipConfirm) showToast('Moved to the Recycle Bin', 'success');
      } else {
        showToast(`Could not delete: ${result?.error || 'unknown error'}`, 'error');
      }
    }
  };

  const handleDeleteAlbum = async (album) => {
    if (await confirmDialog({
      title: 'Delete this album?',
      message: `All ${album.songs.length} tracks of "${album.name}" will be removed from your library and their files moved to the Recycle Bin.`,
      confirmLabel: 'Delete album',
      danger: true,
    })) {
      const songsToDelete = [...album.songs]; // copy array
      for (const song of songsToDelete) {
        await handleDeleteSong(song, true);
      }
      setSelectedAlbum(null);
    }
  };

  // Selection bar: several tracks at once
  const handleDeleteMany = async (files) => {
    const local = files.filter(f => (f.storage_type || 'local') !== 'cloud' && !f.path.startsWith('tc://'));
    const cloudOnly = files.length - local.length;
    if (!local.length) { showToast('These tracks are only in TeleCloud. Use “Remove from TeleCloud” instead.', 'info'); return; }
    const ok = await confirmDialog({
      title: `Delete ${local.length === 1 ? 'this track' : `${local.length} tracks`}?`,
      message: `${local.length === 1 ? 'It is' : 'They are'} removed from your library and the ${local.length === 1 ? 'file is' : 'files are'} moved to the Recycle Bin.`
        + (cloudOnly ? `
${cloudOnly} ${cloudOnly === 1 ? 'track is' : 'tracks are'} only in TeleCloud and ${cloudOnly === 1 ? 'is' : 'are'} skipped.` : ''),
      confirmLabel: local.length === 1 ? 'Delete track' : `Delete ${local.length} tracks`,
      danger: true,
    });
    if (!ok) return;
    for (const f of local) await handleDeleteSong(f, true);
    showToast(`Moved ${local.length} ${local.length === 1 ? 'file' : 'files'} to the Recycle Bin`, 'success');
  };

  const handleFavoriteMany = (files, add) => {
    const paths = new Set(files.map(f => f.path));
    const have = new Set(favorites.map(f => f.path));
    const newFavs = add ? [...favorites, ...files.filter(f => !have.has(f.path))] : favorites.filter(f => !paths.has(f.path));
    setFavorites(newFavs);
    window.ipcRenderer.invoke('save-store', 'favorites', newFavs);
    showToast(add ? `Added ${files.length} to favourites` : `Removed ${files.length} from favourites`);
  };

  // Append to the end of Up next (or just play them when nothing is playing)
  const handleQueueMany = (files) => {
    if (!currentFile || currentIndex < 0) { playMusic(files[0], 0, files); return; }
    const queued = new Set(playQueue.slice(currentIndex).map(f => f.path));
    const fresh = (skipDuplicates ? dedupeTracks(files) : files).filter(f => !queued.has(f.path));
    if (!fresh.length) { showToast('Already in the queue'); return; }
    setPlayQueue([...playQueue, ...fresh]);
    showToast(fresh.length === 1 ? 'Added to the queue' : `Added ${fresh.length} tracks to the queue`);
  };

  const hasDownloadFolder = async () => {
    const settings = await window.ipcRenderer.invoke('load-store', 'settings');
    if (settings?.downloadFolder) return true;
    await alertDialog({ title: 'Choose a download folder', message: 'Set a default download location in Settings → Downloads first.', tone: 'info', icon: 'folder' });
    setCurrentView('settings');
    return false;
  };

  // A whole album: one toast, one track at a time
  const handleDownloadAlbum = async (songs, albumName) => {
    if (!await hasDownloadFolder()) return;
    const ipcRenderer = window.ipcRenderer;
    const toastId = Date.now() + Math.random();
    setDownloadToasts(prev => [...prev, { id: toastId, name: albumName, progress: 0 }]);
    let failed = 0;
    let lastError = '';
    for (const [i, file] of songs.entries()) {
      try {
        if ((file.storage_type || 'local') === 'cloud' || file.path.startsWith('tc://')) {
          const cached = await ipcRenderer.invoke('telecloud-sync:cache-track', file.path);
          if (!cached?.success) throw new Error(cached?.error || 'TeleCloud download failed');
        }
        const r = await ipcRenderer.invoke('download-song', file);
        if (!r?.success) throw new Error(r?.error || 'unknown error');
        if (r.file) setMusicFiles(prev => prev.map(f => (f.path === (r.replaced || file.path) ? r.file : f)));
      } catch (err) { failed++; lastError = err.message; }
      setDownloadToasts(prev => prev.map(t => (t.id === toastId ? { ...t, progress: Math.round(((i + 1) / songs.length) * 100) } : t)));
    }
    if (failed) showToast(`${failed} of ${songs.length} tracks could not be downloaded: ${lastError}`, 'error');
    setTimeout(() => {
      setDownloadToasts(prev => prev.map(t => (t.id === toastId ? { ...t, leaving: true } : t)));
      setTimeout(() => setDownloadToasts(prev => prev.filter(t => t.id !== toastId)), 300);
    }, 2500);
  };

  const handleDownloadSong = async (file) => {
    const ipcRenderer = window.ipcRenderer;
    const storageType = file.storage_type || 'local';
    const name = file.metadata?.title || file.name;

    if (!await hasDownloadFolder()) return;
    const toastId = Date.now() + Math.random();
    setDownloadToasts(prev => [...prev, { id: toastId, name, progress: storageType === 'cloud' ? 0 : 30 }]);
    // Cloud-only: fetch it from TeleCloud first (progress from the download), then copy it out
    const onProgress = (e, p) => { if (p.path === file.path) setDownloadToasts(prev => prev.map(t => (t.id === toastId ? { ...t, progress: Math.min(95, p.progress) } : t))); };
    let result;
    try {
      if (storageType === 'cloud' || file.path.startsWith('tc://')) {
        ipcRenderer.on('telecloud-sync:download-progress', onProgress);
        const cached = await ipcRenderer.invoke('telecloud-sync:cache-track', file.path);
        if (!cached?.success) throw new Error(cached?.error || 'TeleCloud download failed');
      }
      result = await ipcRenderer.invoke('download-song', file);
    } catch (err) {
      result = { success: false, error: err.message };
    } finally {
      ipcRenderer.removeListener('telecloud-sync:download-progress', onProgress);
    }
    if (result?.success) {
      setDownloadToasts(prev => prev.map(t => (t.id === toastId ? { ...t, progress: 100 } : t)));
      // Saved into a music folder: the cloud track is now a local one too
      if (result.file) setMusicFiles(prev => prev.map(f => (f.path === (result.replaced || file.path) ? result.file : f)));
    } else {
      setDownloadToasts(prev => prev.filter(t => t.id !== toastId));
      showToast(`Download failed: ${result?.error || 'unknown error'}`, 'error');
    }
    setTimeout(() => {
      setDownloadToasts(prev => prev.map(t => (t.id === toastId ? { ...t, leaving: true } : t)));
      setTimeout(() => setDownloadToasts(prev => prev.filter(t => t.id !== toastId)), 300);
    }, 2500);
  };

  // Recent, favourites, playlists and the queue keep copies of tracks from when they were added;
  // show them with the library's current data (cloud status, cache, tags)
  const libraryByPath = useMemo(() => new Map(musicFiles.map(f => [f.path, f])), [musicFiles]);
  const live = useCallback((list) => (list || []).map(f => (f && libraryByPath.get(f.path)) || f), [libraryByPath]);
  const recentLive = useMemo(() => live(recentPlayed), [live, recentPlayed]);
  const favoritesLive = useMemo(() => live(favorites), [live, favorites]);
  const playlistsLive = useMemo(() => playlists.map(p => ({ ...p, songs: live(p.songs) })), [live, playlists]);
  const currentLive = (currentFile && libraryByPath.get(currentFile.path)) || currentFile;

  const duplicates = useMemo(() => findDuplicates(musicFiles), [musicFiles]);
  useCoverAccent(currentLive, theme);

  // ReplayGain "Auto": an album played in order keeps its own dynamics, anything else is levelled per track
  const playingPath = currentLive?.path;
  const autoGain = useMemo(() => {
    if (audioSettings.replayGain !== 'auto' || !playingPath) return null;
    if (isShuffle) return 'track';
    const idx = albumIndex(musicFiles);
    const album = idx.byPath.get(playingPath);
    if (!album || album.name === 'Unknown Album') return 'track';
    const at = playQueue.findIndex(f => f.path === playingPath);
    if (at < 0) return 'track';
    const near = [playQueue[at - 1], playQueue[at + 1]].filter(Boolean);
    return near.some(f => idx.byPath.get(f.path) === album) ? 'album' : 'track';
  }, [audioSettings.replayGain, playingPath, isShuffle, playQueue, musicFiles]);
  useEffect(() => {
    if (autoGain) window.ipcRenderer.invoke('player:replaygain-auto', autoGain).catch(() => {});
  }, [autoGain]);

  if (isCheckingAuth) {
    return <div className="app" />;
  }

  const sourceFiles = sourceFilter === 'all' ? musicFiles : musicFiles.filter(f => matchesSource(f, sourceFilter));
  const filteredMusicFiles = sourceFiles.filter(file => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (file.metadata?.title?.toLowerCase().includes(q) || file.metadata?.artist?.toLowerCase().includes(q));
  });
  const cloudFiles = musicFiles.filter(f => storageOf(f).includes('cloud'));
  const queueFiles = live(playQueue.slice(currentIndex + 1));
  const visibleDevices = devices.filter(d => !disabledDevices.includes(d.deviceId || d.id));
  const signal = computeSignalPath({ stream: stream && currentLive && stream.path === currentLive.path ? stream : null, file: currentLive, selectedDevice, devices: visibleDevices, eqEnabled, volume, audioSettings: { ...audioSettings, autoGain }, audioOut: isPlaying ? audioOut : null, dsd: dsdInfo && currentLive && dsdInfo.path === currentLive.path ? dsdInfo : null, output: outputInfo });
  const isScanning = scanProgress?.status === 'inProgress';
  const wideView = currentView === 'settings' || currentView === 'eq-settings';

  const navigate = (view) => {
    setCurrentView(view);
    setSearchQuery('');
    setNowPlaying(null);
    if (view !== 'playlists') setSelectedPlaylistId(null);
    if (view === 'albums') setSelectedAlbum(null);
    if (view === 'artists') setSelectedArtist(null);
  };
  // Clicking an album or artist name anywhere opens its page (and leaves full screen)
  /** Open an album given a track of it, an album, or (when nothing better is known) its name */
  const openAlbum = (target, fromArtist) => {
    if (!target) return;
    const idx = albumIndex(musicFiles);
    const album = typeof target === 'string' ? idx.list.find(a => a.name === target) : target.path ? idx.byPath.get(target.path) : target;
    navigate('albums');
    setSelectedAlbum(album ? { ...album, fromArtist } : { name: String(target), fromArtist });
  };
  const openArtist = (name, tab = 'songs') => { if (!name) return; navigate('artists'); setSelectedArtist(name); setArtistTab(tab); };
  const openEq = () => { setNowPlaying(null); setCurrentView('eq-settings'); };
  const openNowPlaying = (panel, origin = 'player') => currentFile && setNowPlaying({ panel, origin });

  const handleClearQueue = () => {
    setPlayQueue(playQueue.slice(0, currentIndex + 1));
    showToast("Queue cleared.");
  };

  // Queue actions take an index into the tracks after the current one
  const handlePlayQueued = (i) => playMusic(playQueue[currentIndex + 1 + i], currentIndex + 1 + i, playQueue, { keepQueue: true });
  const handleMoveQueued = (from, to) => {
    const upcoming = playQueue.slice(currentIndex + 1);
    const [moved] = upcoming.splice(from, 1);
    upcoming.splice(to, 0, moved);
    setPlayQueue([...playQueue.slice(0, currentIndex + 1), ...upcoming]);
  };

  const handleRemoveFromQueue = (indexOffset) => {
    const targetIndex = currentIndex + 1 + indexOffset;
    const newQueue = [...playQueue];
    newQueue.splice(targetIndex, 1);
    setPlayQueue(newQueue);
  };

  const handleSaveQueueAsPlaylist = () => {
    if (queueFiles.length === 0) {
      showToast("Queue is empty.");
      return;
    }
    const newPlaylist = { id: Date.now().toString(), name: `Queue Playlist`, songs: queueFiles };
    const newPlaylists = [...playlists, newPlaylist];
    setPlaylists(newPlaylists);
    window.ipcRenderer.invoke('save-store', 'playlists', newPlaylists);
    showToast(`Saved as Queue Playlist`);
  };

  const storageNames = new Map(storages.map(s => [String(s.peerId), s.title]));
  const openBackupTo = storages.length ? (files, label) => { refreshStorages(); setStorageDialog({ files, label }); } : null;
  const songListProps = {
    currentFile: currentLive, isPlaying, onPlay: playMusic, onToggleFavorite: handleToggleFavorite, onAddPlaylist: handleAddPlaylist,
    onDeleteSong: handleDeleteSong, onDownloadSong: handleDownloadSong, onDownloadAlbum: handleDownloadAlbum, favorites: favoritesLive, onCheckSpectrum: setSpectrumFile,
    onBackupTo: openBackupTo ? (file) => openBackupTo([file], `“${file.metadata?.title || file.name}”`) : undefined,
    onBackupMany: openBackupTo || undefined,
    onRemoveFromCloud: storages.length ? handleRemoveFromCloud : undefined,
    storageNames,
  };
  const handleOpenLocation = async (file) => {
    const r = await window.ipcRenderer.invoke('show-in-folder', file.path);
    if (!r?.success) showToast(r?.error || 'Could not open that folder', 'error');
  };
  const songActions = {
    onOpenLocation: handleOpenLocation,
    onAddPlaylist: handleAddPlaylist, onBackupTo: songListProps.onBackupTo, onBackupMany: songListProps.onBackupMany,
    onRemoveFromCloud: songListProps.onRemoveFromCloud, storageNames,
    onQueueMany: handleQueueMany, onFavoriteMany: handleFavoriteMany, onDeleteMany: handleDeleteMany,
    openAlbum, openArtist, playCounts,
    duplicates, skipDuplicates, setSkipDuplicates, openDuplicates: () => navigate('duplicates'),
    artistFilter, setArtistFilter,
    dedupe: skipDuplicates ? (list) => dedupeTracks(list) : null,
    countUnique: (list) => (skipDuplicates ? list.filter(f => !duplicates.has(f.path)).length : list.length),
    onEditLyrics: (file) => setLyricsFile(file), lyricsFound,
    onEditInfo: (files) => setMetaFiles(files),
    allFiles: musicFiles, coverFound,
    onEditCover: (files) => setCoverFiles(coverTargets(files, musicFiles)),
    onSaveCoverFound: async () => {
      if (!coverFound) return;
      const r = await window.ipcRenderer.invoke('covers:save', { paths: coverFound.paths, image: coverFound.image });
      showToast(r?.success ? 'Cover saved' : `Could not save the cover: ${r?.error}`, r?.success ? 'success' : 'error');
    },
    onSaveFound: async () => {
      if (!lyricsFound) return;
      const r = await window.ipcRenderer.invoke('lyrics:save', { path: lyricsFound.path, lyrics: lyricsFound.lyrics });
      showToast(r?.success ? 'Lyrics saved' : `Could not save lyrics: ${r?.error}`, r?.success ? 'success' : 'error');
    },
  };
  // the playing track with lyrics found online filled in (until they are saved)
  const lyricsLive = currentLive && !currentLive.metadata?.lyrics && lyricsFound?.path === currentLive.path
    ? { ...currentLive, metadata: { ...currentLive.metadata, lyrics: lyricsFound.lyrics } } : currentLive;

  const renderView = () => {
    if (searchQuery) {
      return (
        <div className="view">
          <SearchView
            searchQuery={searchQuery}
            musicFiles={sourceFiles}
            playlists={playlistsLive}
            recentPlayed={recentLive}
            onPlay={playMusic}
            onNavClick={setCurrentView}
            setSelectedAlbum={setSelectedAlbum}
            setSearchQuery={setSearchQuery}
            onOpenPlaylist={(id) => { navigate('playlists'); setSelectedPlaylistId(id); }}
            songListProps={songListProps}
          />
        </div>
      );
    }
    switch (currentView) {
      case 'settings':
        return (
          <div className="view">
            <SettingsView
              currentView={currentView}
              theme={theme}
              setTheme={setTheme}
              setDisabledDevices={setDisabledDevices}
              musicFolderList={musicFolderList}
              setMusicFolderList={setMusicFolderList}
              onRefreshFolder={handleRefreshFolder}
              setMusicFiles={setMusicFiles}
              onOpenEq={openEq}
              onShortcutsChange={setKeyboardShortcuts}
              onAudioSettingsChange={setAudioSettings}
            />
          </div>
        );
      case 'eq-settings':
        return (
          <div className="view">
            <EqSettingsView
              onBack={() => setCurrentView('settings')}
              eq={eq}
              deviceName={selectedDevice === '-1' ? 'System default' : (devices.find(d => (d.deviceId || d.id) === selectedDevice)?.name || 'this output')}
            />
          </div>
        );
      case 'home':
        return (
          <div className="view">
            <Homepage
              musicFiles={sourceFiles}
              recentPlayed={recentLive}
              onPlay={playMusic}
              onNavClick={navigate}
              setSelectedAlbum={setSelectedAlbum}
              syncStatus={syncStatus}
              syncProgress={syncProgress}
              songListProps={songListProps}
            />
          </div>
        );
      case 'duplicates':
        return (
          <div className="view">
            <SongList
              {...songListProps}
              title="Duplicates"
              subtitle={`${duplicates.size.toLocaleString()} extra ${duplicates.size === 1 ? 'copy' : 'copies'}: the better copy of each track stays in your library`}
              musicFiles={musicFiles.filter(f => duplicates.has(f.path))}
            />
          </div>
        );
      case 'dashboard':
        return <div className="view"><DashboardView musicFiles={musicFiles} onPlay={playMusic} /></div>;
      case 'favorites':
        return <div className="view"><FavoritesView {...songListProps} /></div>;
      case 'recent':
        return <div className="view"><RecentView {...songListProps} recentPlayed={recentLive} /></div>;
      case 'playlists':
        return (
          <div className="view">
            <PlaylistsView
              playlists={playlistsLive} setPlaylists={setPlaylists}
              onSavePlaylists={data => window.ipcRenderer.invoke('save-store', 'playlists', data)}
              currentFile={currentLive} isPlaying={isPlaying} onPlay={playMusic} onToggleFavorite={handleToggleFavorite} favorites={favoritesLive}
              onDeleteSong={handleDeleteSong} onDownloadSong={handleDownloadSong}
              onBackupMany={songListProps.onBackupMany} onBackupTo={songListProps.onBackupTo} storageNames={storageNames} onRemoveFromCloud={songListProps.onRemoveFromCloud}
              selectedPlaylistId={selectedPlaylistId} onSelectPlaylist={setSelectedPlaylistId}
              createSignal={createPlaylistSignal}
            />
          </div>
        );
      case 'artists':
        return <div className="view"><ArtistsView musicFiles={sourceFiles} {...songListProps} selectedArtist={selectedArtist} setSelectedArtist={setSelectedArtist} artistTab={artistTab} setArtistTab={setArtistTab} /></div>;
      case 'albums':
        return (
          <div className="view">
            <AlbumsView
              musicFiles={sourceFiles}
              {...songListProps}
              selectedAlbum={selectedAlbum}
              setSelectedAlbum={setSelectedAlbum}
              onDeleteAlbum={handleDeleteAlbum}
            />
          </div>
        );
      case 'telecloud':
        return (
          <div className="view">
            <SongList
              {...songListProps}
              musicFiles={tcStorageFilter === 'all' ? cloudFiles : cloudFiles.filter(f => String(f.telegram_channel_id) === String(tcStorageFilter))}
              title="TeleCloud"
              subtitle={syncStatus?.isAuthenticated
                ? `${cloudFiles.length.toLocaleString()} tracks backed up to Telegram`
                : 'Not connected — set up TeleCloud Sync in Settings'}
              toolbar={storages.length > 1 && (
                <div className="storage-filter" role="tablist" aria-label="Storage">
                  <button className={tcStorageFilter === 'all' ? 'on' : ''} onClick={() => setTcStorageFilter('all')}>All<span className="n">{cloudFiles.length.toLocaleString()}</span></button>
                  {storages.map(s => (
                    <button key={s.id} className={String(tcStorageFilter) === String(s.peerId) ? 'on' : ''} onClick={() => setTcStorageFilter(String(s.peerId))}>
                      <Icon name={s.kind === 'self' ? 'heart' : 'cloud'} />{s.title}<span className="n">{cloudFiles.filter(f => String(f.telegram_channel_id) === String(s.peerId)).length.toLocaleString()}</span>
                    </button>
                  ))}
                </div>
              )}
              onInfoClick={() => setIsInfoModalOpen(true)}
              showSort
              prefKey="telecloud"
            />
          </div>
        );
      default:
        return (
          <div className="view">
            <SongList
              {...songListProps}
              musicFiles={filteredMusicFiles}
              title="Library"
              onInfoClick={() => setIsInfoModalOpen(true)}
              showSort
              prefKey="library"
            />
          </div>
        );
    }
  };

  return (
    <SongActions.Provider value={songActions}>
    {showFps && <FpsMeter />}
    <TitleBar subtitle={currentLive ? `${currentLive.metadata?.title || currentLive.name}${currentLive.metadata?.artist ? ` · ${currentLive.metadata.artist}` : ''}` : null} />
    <div className={`app ${isSidebarCollapsed ? 'side-collapsed' : ''} ${wideView ? 'no-right' : ''} ${nowPlaying && currentFile && !nowPlaying.closing ? 'np-mode' : ''}`}>
      <OverflowTooltip />
      <Sidebar
        currentView={currentView}
        onNavClick={navigate}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(c => !c)}
        counts={{ library: musicFiles.length, favorites: favorites.length, cloud: cloudFiles.length }}
        playlists={playlistsLive}
        selectedPlaylistId={selectedPlaylistId}
        onOpenPlaylist={(id) => { navigate('playlists'); setSelectedPlaylistId(id); }}
        onCreatePlaylist={() => { navigate('playlists'); setCreatePlaylistSignal(n => n + 1); }}
        signal={signal}
        stream={stream && currentLive && stream.path === currentLive.path ? stream : null}
        devices={visibleDevices}
        onDevicesOpen={() => window.ipcRenderer.invoke('get-audio-devices').then(l => applyDevicesRef.current?.(l))}
        selectedDevice={selectedDevice}
        onDeviceChange={handleDeviceChange}
      />

      <main className="main">
        <Header
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          source={sourceFilter}
          onSourceChange={setSourceFilter}
          onRefresh={() => handleRefreshFolder()}
          isScanning={isScanning}
          theme={themeKind(theme)}
          onToggleTheme={() => setTheme((t) => {
            const other = themeKind(t) === 'dark' ? 'light' : 'dark';
            const last = readPref(`tc-theme-${other}`);
            return isTheme(last) && themeKind(last) === other ? last : other;
          })}
          onOpenSettings={() => navigate('settings')}
        />
        {renderView()}
      </main>

      <RightPanel
        currentFile={lyricsLive}
        currentTime={currentTime}
        onSeek={handleSeek}
        signal={signal}
        stream={stream && currentLive && stream.path === currentLive.path ? stream : null}
        eqEnabled={eqEnabled}
        setEqEnabled={setEqEnabled}
        onOpenEq={openEq}
        lyricsCollapsed={lyricsCollapsed}
        onToggleLyrics={() => setLyricsCollapsed(c => !c)}
        onExpandLyrics={() => openNowPlaying('lyrics', 'panel')}
        onOpenNowPlaying={() => openNowPlaying(undefined, 'panel')}
        queueFiles={queueFiles}
        onPlayQueued={handlePlayQueued}
        onMoveQueued={handleMoveQueued}
      />

      {nowPlaying && currentFile && (
        <NowPlayingFullscreen
          currentFile={lyricsLive}
          currentTime={currentTime}
          onSeek={handleSeek}
          signal={signal}
        stream={stream && currentLive && stream.path === currentLive.path ? stream : null}
          queueFiles={queueFiles}
          onPlayQueued={handlePlayQueued}
          onMoveQueued={handleMoveQueued}
          onRemoveQueued={handleRemoveFromQueue}
          initialPanel={nowPlaying.panel}
          origin={nowPlaying.origin}
          closeRequested={!!nowPlaying.closing}
          onClosingStart={() => setNowPlaying(n => (n ? { ...n, closing: true } : n))}
          onClose={() => setNowPlaying(null)}
        />
      )}

      <PlayerBar
        currentFile={currentLive}
        isPlaying={isPlaying}
        currentTime={currentTime}
        onSeek={handleSeek}
        onTogglePlay={handleTogglePlay}
        onNext={handleNext}
        onPrev={handlePrev}
        volume={volume}
        onVolumeChange={handleVolumeChange}
        muted={isMuted}
        onToggleMute={handleToggleMute}
        selectedDevice={selectedDevice}
        loopMode={loopMode}
        onToggleLoop={handleToggleLoop}
        isShuffle={isShuffle}
        onToggleShuffle={handleToggleShuffle}
        isQueueOpen={isQueueOpen}
        onToggleQueue={() => setIsQueueOpen(o => !o)}
        queueFiles={queueFiles}
        onPlayQueued={handlePlayQueued}
        onMoveQueued={handleMoveQueued}
        onClearQueue={handleClearQueue}
        onRemoveFromQueue={handleRemoveFromQueue}
        onSaveQueueAsPlaylist={handleSaveQueueAsPlaylist}
        onToggleFavorite={handleToggleFavorite}
        isFavorite={currentFile ? favorites.some(f => f.path === currentFile.path) : false}
        eqEnabled={eqEnabled}
        setEqEnabled={setEqEnabled}
        onOpenEq={openEq}
        signal={signal}
        stream={stream && currentLive && stream.path === currentLive.path ? stream : null}
        onOpenNowPlaying={() => (nowPlaying ? setNowPlaying(n => ({ ...n, closing: true })) : openNowPlaying(undefined, 'player'))}
      />

      {storageDialog && (
        <StorageDialog
          files={live(storageDialog.files)} label={storageDialog.label} storages={storages}
          onClose={() => setStorageDialog(null)}
          onDone={(msg) => { showToast(msg, 'info'); refreshStorages(); }}
        />
      )}

      <Modal isOpen={isInfoModalOpen} onClose={() => setIsInfoModalOpen(false)} title="What the badges mean">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px' }}>
          {[...SOURCE_HELP, ...QUALITY_HELP].map((b, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <span style={{ minWidth: 130, display: 'flex', gap: 4, flexWrap: 'wrap' }}>{b.tags.map(([cls, label]) => <span key={label} className={`badge ${cls} mono`}>{label}</span>)}</span>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{b.text}</span>
            </div>
          ))}
        </div>
      </Modal>

      <Presence show={!!toastMessage} ms={260}>
        <div className={`toast ${toastType === 'error' ? 'error' : toastType === 'info' ? 'info' : ''}`} role="status">
          <Icon name={toastType === 'error' ? 'alert' : toastType === 'info' ? 'info' : 'check'} />
          {toastMessage}
        </div>
      </Presence>

      {playlistModalData && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setPlaylistModalData(null); }}>
          <div className="card modal-card">
            <h3>{playlistModalData.length > 1 ? `Add ${playlistModalData.length} tracks to playlist` : 'Add to playlist'}</h3>
            <div className="list">
              {playlists.length ? playlists.map(p => (
                <button key={p.id} className="menu-item" onClick={() => confirmAddPlaylist(p.id, playlistModalData)}>
                  <Icon name="playlist" />{p.name}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 12 }}>{p.songs?.length || 0}</span>
                </button>
              )) : <div className="empty">No playlists yet.</div>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => { setPlaylistModalData(null); navigate('playlists'); setCreatePlaylistSignal(n => n + 1); }}>New playlist</button>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setPlaylistModalData(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <DialogHost />

      {metaFiles && (
        <MetadataDialog
          files={metaFiles}
          onClose={() => setMetaFiles(null)}
          onDone={(r) => {
            if (!r?.success) { showToast(`Could not save tags: ${r?.error || 'unknown error'}`, 'error'); return; }
            if (r.coverOnly) { showToast('Cover saved'); return; }
            const byPath = new Map((r.files || []).filter(Boolean).map(f => [f.path, f]));
            setMusicFiles(prev => prev.map(f => byPath.get(f.path) || f));
            setCurrentFile(f => (f && byPath.has(f.path) ? byPath.get(f.path) : f));
            if (r.errors?.length) showToast(`${r.errors.length} ${r.errors.length === 1 ? 'file' : 'files'} could not be changed: ${r.errors[0].error}`, 'error');
            else showToast(byPath.size === 1 ? 'Track info saved' : `Saved ${byPath.size} tracks`);
          }}
        />
      )}

      {whatsNew && <WhatsNewDialog releases={whatsNew} onClose={() => setWhatsNew(null)} />}

      {coverFiles && (
        <CoverDialog
          files={coverFiles}
          onClose={() => setCoverFiles(null)}
          onSaved={(r) => showToast(r.errors?.length ? `Cover saved, but ${r.errors.length} ${r.errors.length === 1 ? 'file' : 'files'} could not be changed` : 'Cover saved', r.errors?.length ? 'error' : 'success')}
        />
      )}

      {lyricsFile && (
        <LyricsDialog
          file={lyricsFile}
          onClose={() => setLyricsFile(null)}
          playingPath={currentFile?.path}
          isPlaying={isPlaying}
          onPlayFile={(f) => playMusic(f, 0, [f])}
          onTogglePlay={handleTogglePlay}
          onSeek={handleSeek}
          onSaved={(r) => showToast(r.error ? `Could not save lyrics: ${r.error}` : r.cloudOnly ? 'Lyrics saved to your library' : `Lyrics saved${r.saved?.length ? ` (${r.saved.join(' + ').replace('lrc', '.lrc file')})` : ''}`, r.error ? 'error' : 'success')}
        />
      )}

      {spectrumFile && (
        <SpectrumModal file={spectrumFile} onClose={() => setSpectrumFile(null)} theme={theme} />
      )}

      <div className="float-stack">
        <Presence show={update.state === 'ready' && !updateDismissed}>
          <div className="card float-card">
            <div className="row">
              <Icon name="download" style={{ color: 'var(--accent)' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>TeleCloud {update.next} is ready</b>
                <small>Installs when you restart, or the next time you quit.</small>
              </div>
            </div>
            <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" style={{ padding: '5px 12px' }} onClick={() => setUpdateDismissed(true)}>Later</button>
              <button className="btn-primary" style={{ padding: '6px 14px', fontSize: 13 }} onClick={() => window.ipcRenderer.invoke('update:install')}>Restart now</button>
            </div>
          </div>
        </Presence>
        <Presence show={!!scanProgress}>
          {scanProgress ? (
          <div className="card float-card">
            <div className="row">
              {scanProgress.status === 'inProgress' ? <span className="ring" /> : <Icon name="check" style={{ color: 'var(--ok)' }} />}
              <div style={{ minWidth: 0 }}>
                <b>{scanProgress.status === 'inProgress'
                  ? (scanProgress.type === 'scanning' ? 'Scanning…' : 'Refreshing…')
                  : (scanProgress.type === 'scanning' ? 'Scan complete' : 'Refresh complete')}</b>
                <small>{scanProgress.message}</small>
              </div>
              {scanProgress.status === 'inProgress' && (
                <button className="btn-ghost" style={{ marginLeft: 'auto', padding: '5px 12px' }} onClick={() => window.ipcRenderer.invoke('library:cancel')} title="Stop scanning; tracks read so far are kept">
                  Stop
                </button>
              )}
            </div>
            {scanProgress.status === 'inProgress' && scanProgress.total > 0 && (
              <div style={{ marginTop: 10 }}><Progress value={(scanProgress.current / scanProgress.total) * 100} /></div>
            )}
          </div>
          ) : null}
        </Presence>
        {downloadToasts.map(toast => (
          <div key={toast.id} className={`card float-card ${toast.leaving ? 'leaving' : ''}`}>
            <div className="row" style={{ marginBottom: 8 }}>
              {toast.progress === 100 ? <Icon name="check" style={{ color: 'var(--ok)' }} /> : <Icon name="download" />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>{toast.progress === 100 ? 'Download complete' : 'Downloading…'}</b>
                <small>{toast.name}</small>
              </div>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>{toast.progress}%</span>
            </div>
            <div className="progress"><span style={{ width: `${toast.progress}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
    </SongActions.Provider>
  );
}

export default App;