// What changed in each version, newest first. About shows it, and so does the note after an update.
// Add an entry here for every release; keep it short and written for people using the app.
export const RELEASES = [
  {
    version: '1.0.0',
    sections: [
      {
        title: 'Sound',
        items: [
          'Bit-perfect playback through WASAPI Exclusive, and a Signal path that shows every step from the file to your DAC and says when something changes the sound.',
          "DSD as native DSD through your DAC's ASIO driver, as DoP, or converted to PCM, falling back on its own when one way can't be used.",
          'MQA found in the audio itself, with violet MQA and blue MQA Studio badges; send it untouched to an MQA DAC or play it as plain PCM.',
          'A 31-band equalizer with AutoEQ, Squiglink and Audacity curves, and a separate EQ for each output.',
          'ReplayGain (Auto: album gain for albums, track gain on shuffle), crossfade, channel balance in 0.5 dB steps and headphone crossfeed.',
          'Outputs that come and go, like Bluetooth, are followed, and the first track plays straight through the output you chose.',
        ],
      },
      {
        title: 'Your library',
        items: [
          'Albums grouped by album artist, compilations kept apart, and Various Artists and Unknown Artist in their own place.',
          'Filter and sort by quality, bit depth and sample rate; albums by title, artist, tracks, latest or oldest added. Sorts and filters stay as you left them.',
          'Files without tags take their details from the file name and folders; .wma, .aifc, .m4b, .mka, .mpc and DSF tags are read too.',
          'Artist pictures from Last.fm, Deezer, TheAudioDB, Apple Music, MusicBrainz or YouTube, or your own, animated GIFs included, saved in the tags.',
          'Lyrics found online and kept in sync with the music, with an editor that follows the line you are on. Album covers found online too.',
          'Download a track or an album into a folder named after it, and Open file location for files on this computer.',
        ],
      },
      {
        title: 'TeleCloud',
        items: [
          'Your music backed up to a private Telegram channel, encrypted before it leaves your computer, in up to five storages.',
          'Tracks only in TeleCloud stream straight away and are kept in a cache; Restore brings your library back on another computer, with tags, lyrics, covers and artist GIFs.',
          'Check backup compares your library with what is really in Telegram and puts back what is missing.',
        ],
      },
      {
        title: 'Look and feel',
        items: [
          'Ten themes, an accent colour that can follow the cover, and a full-screen player with tilting cover and adjustable lyrics.',
          "Discord status with the album cover, the artist's picture and a Get TeleCloud button.",
          'Low memory mode, Keep running in the tray, a smaller install and light, quick pages, even with large libraries.',
          'Settings > About > Logs saves a log for reporting problems, with music names hidden unless you include them.',
        ],
      },
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
