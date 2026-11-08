// What changed in each version, newest first. About shows it, and so does the note after an update.
// Add an entry here for every release; keep it short and written for people using the app.
export const RELEASES = [
  {
    version: '1.0.0-beta.15',
    items: [
      'DSD playback in Settings > Playback: Native through your DAC\'s ASIO driver, DoP in WASAPI Exclusive, or Convert to PCM. What can\'t be done falls back, native to DoP to PCM, and the signal path says why.',
      'Native DSD and DoP send the DSD bits untouched, and the signal path shows Bit-perfect. Checked on a Topping DX1 II: native DSD64 to DSD256, DoP DSD64 and DSD128.',
      'Convert to PCM now sends 352.8 kHz whole-number PCM. Some DACs stayed silent with DSD before.',
      'The signal path says why the sound is resampled, names the device System default uses, and shows when it goes out over Bluetooth.',
      'Saving an artist picture to thousands of tracks shows its progress and can be stopped. TheAudioDB is a new picture source.',
      'Logs no longer hide parts of ordinary words when they hold a music name.',
    ],
  },
  {
    version: '1.0.0-beta.14',
    items: [
      'Artist pictures: find one on Last.fm or Deezer, or upload your own, from the Artist picture button on an artist page. It is saved in the tags of their tracks, where other players can read it too.',
      'Various Artists and Unknown Artist now have their own place at the top of the Artists page, showing their albums one by one.',
      'Two compilations with the same name, such as Greatest Hits, stay two albums unless their disc numbers show they belong together.',
      'Saving an album cover now keeps an artist picture already in the file.',
    ],
  },
  {
    version: '1.0.0-beta.13',
    items: [
      'Eight new themes: Matcha, Sakura, Hojicha, Yozakura, Tube Amp, Ube, Abyss and OLED. Choose one in Settings > Appearance.',
      'Follow the cover: the accent colour can come from the cover playing, and stays readable on every theme.',
      'Equalizer: keep a separate EQ for each output, so your headphones and speakers each have their own.',
      'Library: filter by quality, bit depth or sample rate, and sort by sample rate or bit depth.',
      'ReplayGain Auto: album gain while an album plays in order, track gain on shuffle or mixed lists.',
      'TeleCloud: Check backup compares your library with what is really in Telegram, and can put back what is missing.',
      'Small text is easier to read, and dark covers no longer melt into dark themes.',
    ],
  },
  {
    version: '1.0.0-beta.12',
    items: [
      'Your Discord status now has a Get TeleCloud button that others can click. You can turn it off in Settings > General > Discord.',
    ],
  },
  {
    version: '1.0.0-beta.11',
    items: [
      'Report problems more easily: Settings > About > Logs saves a log to send along. It stays on your computer until you send it yourself.',
      'Music names are hidden in the saved log unless you choose to include them. Keys, passwords and your Telegram session are never included.',
    ],
  },
  {
    version: '1.0.0-beta.10',
    items: [
      'Discord status: show what you are listening to, with the album cover. Turn it on in Settings > General.',
      'New Appearance settings: make the full-screen cover tilt with your mouse, and choose the lyrics size, alignment, glow and speed.',
      'Equalizer: import and export Audacity curves.',
      'Clearer messages when a file cannot be changed, with the option to write to read-only files.',
      'Saving a cover no longer fails when the largest picture is missing.',
      "This What's New note, also in Settings > About.",
    ],
  },
  {
    version: '1.0.0-beta.9',
    items: [
      'The Artists page can show album artists only, or everyone.',
      'The disc icon lines up with its heading.',
      'Clearer message when a lyrics or cover source cannot be reached.',
    ],
  },
  {
    version: '1.0.0-beta.8',
    items: [
      'Albums are grouped by album artist: two albums with the same name stay apart, and guests no longer split an album.',
      'Artist pages list albums they only appear on separately.',
      'Files without tags take their details from the file name and folders.',
      'The library also picks up .wma, .aifc, .m4b, .mka and .mpc files.',
    ],
  },
];

const parts = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.?(\d+))?/i.exec(String(v || ''));
  // a plain release comes after its own betas
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])] : null;
};

/** Below 0: a is older than b */
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The notes to show when the app starts. Nothing on a new install, or when this version was seen.
 * Versions before this feature saved nothing: someone with music folders has updated from one.
 */
export function notesToShow(lastSeen, current, hasLibrary, releases = RELEASES) {
  if (!lastSeen) return hasLibrary ? releases.filter(r => compareVersions(r.version, current) === 0) : [];
  if (compareVersions(lastSeen, current) >= 0) return [];
  return releases.filter(r => compareVersions(r.version, lastSeen) > 0 && compareVersions(r.version, current) <= 0);
}

export const shortVersion = (v) => String(v || '').replace(/^1\.0\.0-/, '');
export const RELEASES_URL = 'https://github.com/MinhHaiDeveloper/telecloud/releases';
