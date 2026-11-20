import { t, tKnown } from '../i18n';
// Every setting the Settings page has, for its search box and topic filters (SettingsView.jsx).
//   title: what the row (SettingRow), section heading (<h3>) or block heading says, word for word: the jump
//          finds it by that text. `section: true` marks a heading.
//   tab:   the Settings tab it is on. words: what else people may type. topics: the filter chips it belongs to.
// scripts/check-settings-index.js runs on every `vite build` (a plugin in vite.config.js) and fails the build
// when a SettingRow title in src/components is missing here, or an entry here no longer exists in the code.
// Rows that only show a state (a device, a storage, "Connected as ...") are not settings and stay out (IGNORED).

export const TOPICS = [
  { id: 'bitperfect', label: 'Bit-perfect' }, // a term, kept as it is in every language
  { id: 'dsd', label: 'DSD' },
  { id: 'hires', get label() { return t('Lossless & hi-res'); } },
  { id: 'sound', get label() { return t('Sound shaping'); } },
  { id: 'lyrics', get label() { return t('Lyrics'); } },
  { id: 'cloud', get label() { return t('Cloud & backup'); } },
  { id: 'online', get label() { return t('Online services'); } },
  { id: 'look', get label() { return t('Look & motion'); } },
];

// the title shows in the app's language (the row's own t() text); the English one stays searchable too
const e = (tab, title, words = '', topics = [], section = false) => ({ tab, title: tKnown(title), en: title, words, topics, section });
const s = (tab, title, words = '', topics = []) => e(tab, title, words, topics, true);

export const SETTINGS = [
  // ---- General
  s('general', 'Lyrics', 'lrc synced', ['lyrics']),
  e('general', 'Search online for missing lyrics', 'lrclib netease qq kugou genius find', ['lyrics', 'online']),
  e('general', 'Word by word when available', 'enhanced lrc karaoke yrc qrc krc', ['lyrics']),
  e('general', 'Save found lyrics automatically', 'tag write', ['lyrics']),
  e('general', 'Save lyrics to', 'tag lrc file sidecar', ['lyrics']),
  e('general', 'Sources', 'lyrics provider order priority', ['lyrics', 'online']),
  e('general', 'Word timing models', 'cadence download delete model packs ai align', ['lyrics']),
  s('general', 'Album covers', 'artwork cover art', ['online']),
  e('general', 'Search online for missing covers', 'artwork itunes deezer musicbrainz qq', ['online']),
  e('general', 'Save found covers automatically', 'artwork embed', []),
  e('general', 'Save covers to', 'tag folder.jpg cover.jpg', []),
  s('general', 'Artist pictures', 'artist image photo', ['online']),
  e('general', 'Search online for missing pictures', 'artist image photo', ['online']),
  e('general', 'Save found pictures automatically', 'artist image', []),
  e('general', 'YouTube API key', 'artist picture google', ['online']),
  s('general', 'Discord', 'rich presence status', ['online']),
  e('general', 'Show what you are listening to', 'discord rich presence status', ['online']),
  e('general', 'Show while paused', 'discord', ['online']),
  e('general', 'Show the last track played', 'discord', ['online']),
  e('general', 'Show the album cover', 'discord artwork', ['online']),
  e('general', 'Show a Get TeleCloud button', 'discord link', ['online']),
  e('general', 'Status text', 'discord', ['online']),
  s('general', 'Last.fm', 'scrobble lastfm', ['online']),
  e('general', 'Scrobble plays', 'last.fm lastfm', ['online']),
  s('general', 'ListenBrainz', 'scrobble musicbrainz token', ['online']),
  e('general', 'Send listens', 'listenbrainz scrobble', ['online']),
  s('general', 'Performance', 'speed memory gpu', []),
  e('general', 'Use the high-performance graphics card', 'gpu nvidia discrete', []),
  e('general', 'Low memory mode', 'ram', []),
  e('general', 'Keep running in the tray when closed', 'minimize system tray background', []),
  e('general', 'Show frame rate', 'fps', ['look']),

  // ---- Appearance
  s('appearance', 'Theme', 'colour color dark light vanilla matcha sakura hojicha yozakura tube amp ube abyss oled', ['look']),
  e('appearance', 'Follow the cover', 'accent colour color', ['look']),
  e('appearance', 'Floating lyrics', 'desktop lyrics overlay window', ['lyrics', 'look']),
  e('appearance', 'Lock floating lyrics', 'click through', ['lyrics']),
  s('appearance', 'Layout and motion', 'animation', ['look']),
  e('appearance', 'Signal path in the side panel', 'bit-perfect format', ['look', 'bitperfect']),
  e('appearance', 'Waveform seek bar', 'progress bar', ['look']),
  e('appearance', 'Reduce motion', 'animation accessibility', ['look']),
  s('appearance', 'Full-screen cover', 'now playing', ['look']),
  e('appearance', 'Tilt the cover with the mouse', 'now playing 3d', ['look']),
  e('appearance', 'Tilt strength', 'now playing', ['look']),
  s('appearance', 'Full-screen lyrics', 'now playing', ['lyrics', 'look']),
  e('appearance', 'Current line size', 'font lyrics', ['lyrics', 'look']),
  e('appearance', 'Other lines size', 'font lyrics', ['lyrics', 'look']),
  e('appearance', 'Glow on the current line', 'lyrics shadow', ['lyrics', 'look']),
  e('appearance', 'Alignment', 'lyrics left center right', ['lyrics', 'look']),
  e('appearance', 'Line change speed', 'lyrics scroll animation', ['lyrics', 'look']),

  // ---- Library
  s('library', 'Music folders', 'add folder scan watch import', []),
  s('library', 'Cache & database', 'reset rescan metadata', []),
  e('library', 'Clear cached data & database', 'reset rescan metadata', []),
  s('library', 'Duplicates', 'same track twice', []),
  e('library', 'Skip duplicate tracks', 'same track twice', []),
  s('library', 'When an album ends', 'autoplay continue radio', []),
  e('library', 'Keep playing another album', 'autoplay continue radio', []),

  // ---- Playback
  s('playback', 'Output devices', 'dac wasapi exclusive shared speaker headphones', ['bitperfect', 'hires']),
  s('playback', 'Processing', 'output', []),
  e('playback', 'ReplayGain', 'loudness normalize volume track album gain', ['sound']),
  e('playback', 'Crossfade', 'gapless blend fade', ['sound']),
  e('playback', 'Channel balance', 'left right', ['sound']),
  e('playback', 'Let other apps use the DAC while paused', 'release exclusive wasapi asio', ['bitperfect', 'dsd']),
  e('playback', 'Exclusive mode buffer', 'wasapi latency clicks skips dac', ['bitperfect']),
  e('playback', 'Fade on play and pause', 'pop click', ['bitperfect']),
  e('playback', 'Headphone crossfeed', 'bs2b', ['sound']),
  e('playback', 'Skip silence', 'gap podcast live hidden track', ['sound']),
  e('playback', 'MQA', 'decode unfold renderer tidal', ['hires', 'bitperfect']),
  e('playback', 'DSD playback', 'dop native asio pcm dsf dff sacd', ['dsd', 'hires', 'bitperfect']),
  e('playback', 'Limit output format', 'max sample rate bit depth resample downsample 24 bit 192 khz', ['hires', 'bitperfect', 'dsd']),

  // ---- Sound
  s('eq', 'Equalizer', 'eq', ['sound']),
  e('eq', 'Parametric EQ & AutoEQ', 'equalizer headphones target bands', ['sound']),
  s('eq', 'Tone', 'eq', ['sound']),
  e('eq', 'Warmth', 'tilt bright', ['sound']),
  e('eq', 'Bass', 'low', ['sound']),
  e('eq', 'Treble', 'high', ['sound']),
  e('eq', 'Loudness', 'fletcher munson quiet', ['sound']),
  s('eq', 'Space', 'stereo', ['sound']),
  e('eq', 'Stereo width', 'mono wide', ['sound']),
  e('eq', 'Channels', 'mono swap left right', ['sound']),
  e('eq', 'Polarity', 'phase invert', ['sound']),
  s('eq', 'Effects', '', ['sound']),
  e('eq', 'Night mode', 'compressor dynamic range', ['sound']),
  e('eq', 'Air', 'exciter shine', ['sound']),
  e('eq', 'Tube warmth', 'valve harmonics saturation', ['sound']),
  s('eq', 'Room or headphone correction', 'convolution impulse response wav fir', ['sound']),
  s('eq', 'Headroom and comparing', '', ['sound']),
  e('eq', 'Prevent clipping', 'headroom preamp guard', ['sound', 'bitperfect']),
  e('eq', 'A/B: hear the original', 'compare bypass', ['sound', 'bitperfect']),

  // ---- Keyboard, Downloads
  s('keyboard', 'Keyboard shortcuts', 'hotkeys keys play pause next previous volume', []),
  s('downloads', 'Downloads', 'save offline', ['cloud']),
  e('downloads', 'Download location', 'folder save offline', ['cloud']),

  // ---- TeleCloud Sync
  e('telecloud', 'Back up your library', 'telegram upload backup', ['cloud']),
  e('telecloud', 'Upload speed limit', 'bandwidth', ['cloud']),
  s('telecloud', 'Storages', 'telegram channel chat saved messages folder nas', ['cloud']),
  e('telecloud', 'Add a storage', 'telegram channel chat folder nas drive', ['cloud']),
  e('telecloud', 'Or back up to a folder', 'nas drive folder network share storage without telegram', ['cloud']),
  e('telecloud', 'Library index', 'manifest', ['cloud']),
  e('telecloud', 'Streaming speed', 'test download', ['cloud']),
  e('telecloud', 'Recovery key', 'encryption password', ['cloud']),
  e('telecloud', 'Use the key from another computer', 'encryption recovery', ['cloud']),
  e('telecloud', 'Encrypt files (recommended)', 'aes encryption', ['cloud']),
  s('telecloud', 'Backup', 'telegram restore', ['cloud']),
  e('telecloud', 'Check backup', 'verify repair', ['cloud']),
  e('telecloud', 'Restore library from cloud', 'new computer', ['cloud']),
  s('telecloud', 'Encryption', 'aes key', ['cloud']),
  e('telecloud', 'Encrypt new uploads', 'aes encryption', ['cloud']),
  s('telecloud', 'Cache', 'offline streaming disk space', ['cloud']),
  e('telecloud', 'Cache size', 'offline streaming disk space', ['cloud']),
  e('telecloud', 'Clear cache', 'disk space', ['cloud']),
  s('telecloud', 'Danger zone', 'delete', ['cloud']),
  e('telecloud', 'Delete the TeleCloud backup', 'remove telegram', ['cloud']),

  // ---- Remote, About
  s('remote', 'Remote', 'phone control web', ['online']),
  e('remote', 'Let other devices control TeleCloud', 'phone remote web control', ['online']),
  e('remote', 'Name shown on remotes', 'device name', ['online']),
  e('remote', 'Keep this computer awake while music plays', 'sleep power', []),
  s('about', 'About', 'version update', []),
  s('about', 'Logs', 'report bug debug', []),
  e('about', 'Save the log', 'report bug debug', []),
  e('about', 'How far back', 'log', []),
  e('about', 'From and to', 'log dates', []),
  e('about', 'Include music names', 'log privacy', []),
  e('about', 'Detailed logging', 'log debug verbose', []),
];

// SettingRow titles that show a state or a hint, not a setting
export const IGNORED = [
  'No folders yet',
  'Changes are picked up automatically',
  'Looking for devices…',
  'Click a shortcut, then press the new keys',
  'Not available in this build',
  'Scrobble to Last.fm',
  // shows only once there is a translation: move it to SETTINGS (appearance, look) with the first one
  'Language of the app',
  // the account row when the storages are folders only
  'Backing up to folders',
];

const norm = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Matches for what was typed and the chips picked: every word typed must appear somewhere in the entry */
export function searchSettings(query, topics = [], tabLabel = (id) => id) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  return SETTINGS.filter((it) => {
    if (topics.length && !topics.some(id => it.topics.includes(id))) return false;
    if (!words.length) return true;
    const hay = norm(`${it.title} ${it.en} ${it.words} ${tabLabel(it.tab)} ${it.topics.map(id => TOPICS.find(x => x.id === id)?.label).join(' ')}`);
    return words.every(w => hay.includes(w));
  }).map((it) => {
    // titles that start with what was typed first, then rows before headings
    const title = norm(it.title);
    const rank = (words.length && title.startsWith(words[0]) ? 0 : words.length && title.includes(words[0]) ? 1 : 2) * 2 + (it.section ? 1 : 0);
    return { ...it, rank };
  }).sort((a, b) => a.rank - b.rank);
}
