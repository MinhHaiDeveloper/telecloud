// What changed in each version, newest first. About shows it, and so does the note after an update.
// Add an entry here for every release; keep it short and written for people using the app.
export const RELEASES = [
  {
    version: '1.1.0-beta.13',
    items: [
      'TeleCloud is ready to be translated: every text in the app, the tray menu, the titles of the file pickers and the messages can now show in another language. There is no translation yet, so everything is in English as before; once there is one, Settings > Appearance gets a Language choice that changes the app at once, without a restart, and keeps the music playing.',
      'The Remote follows the language TeleCloud is in, on every phone and tablet that opens it.',
      'Counts of a thousand and more (tracks, plays, files) are written with the thousands separator your Windows uses.',
      'For people who want to help with code or translations: CONTRIBUTING.md on GitHub says how.',
    ],
  },
  {
    version: '1.1.0-beta.12',
    items: [
      `VU meters in Now Playing: the VU button (or V) opens a page of two analogue meters, left and right, in four faces: Classic, Blue, Theme (in the colours of your theme, and it follows it) and Backdrop (just the scale and needles over the background). 0 VU can sit at −18, −14 or −10 dBFS, a peak light shows when the music nears full scale, and H leaves the meters alone on screen. They only run while you can see them, and never touch the music: bit-perfect stays bit-perfect.`,
      `Settings has a search box (Ctrl+F there): type a word and every setting that matches shows, from all the tabs, with chips to narrow it to a topic (Bit-perfect, DSD, Lossless & hi-res, Lyrics and more). Pick one and Settings opens at it, lit for a moment.`,
      `In Now Playing the player bar steps out of the way after 5 seconds and comes back when the mouse reaches the bottom edge.`,
      `F11 goes full screen (and back), filling the whole screen.`,
      `Now Playing: the format, moon and volume no longer sit on top of the seek bar's end, and in a small window the lyrics or queue no longer have the song title and badges spilling over them. Closing from the VU page is smooth.`,
    ],
  },
  {
    version: '1.1.0-beta.11',
    items: [
      'Cadence, optional: word-by-word timing worked out on this computer for lyrics that only have line times. Its models are not part of TeleCloud: download them in Settings > Lyrics > Word timing models only if you want them (English and other languages 339 MB, Japanese 341 MB, Voice separation 166 MB) and delete them whenever you like. Lyrics from the sources work as before without them. About a minute a song on a graphics card, 2 to 3 minutes on the processor alone; Chinese is read as pinyin.',
      'The lyrics window is bigger and has two tabs: Sync for plain and line-synced lyrics, and Word by word, where Cadence times the song and any word can be fixed by dragging its edge, nudging it with the arrow keys or tapping Space as it is sung. A guide opens the first time and from How it works.',
      "Word by word editing: time a chorus once and paste it onto its repeats (Ctrl+C, Ctrl+V; Shift+click picks several lines), Ctrl+Z and Ctrl+Y in both tabs, Enter fixes a word's spelling, and the search column folds away with a button so switching tabs moves nothing. Cloud-only tracks are downloaded to the cache first.",
      'The player bar gives the moon, EQ and volume buttons more room. The EQ button opens the equalizer and, pressed again, goes back to where you were; Back from the EQ opened in Settings > Sound returns to Sound.',
      'Lighter on memory: pages and panels no longer leave listeners running behind them, and the cover animations hand back graphics memory when idle.',
      `NetEase's credit lines ({"t":0,"c":[...]}) no longer show inside its line-synced lyrics.`,
    ],
  },
  {
    version: '1.1.0-beta.10',
    items: [
      'ListenBrainz, next to Last.fm in Settings > General: paste your own user token from listenbrainz.org/settings and your listens are sent there too, with "playing now". Plays made offline wait and go out later. Tracks are matched to MusicBrainz when it is sure (from the tags Picard writes, or one search per track), so each listen links to the right recording.',
      'QQ Music is a source for album covers and artist pictures, in 1200 × 1200: strongest for Chinese and other Asian music, where the other sources often have nothing.',
      "Artist biographies from QQ Music too: an artist page shows Last.fm's (in English) when it says enough, QQ Music's (in Chinese) where Last.fm has little or nothing, and a Last.fm | QQ Music switch when both have one.",
      'Settings > Playback > Skip silence: silences of 2 seconds and more, inside a track and between tracks, shrink to half a second. For live albums, podcasts and hidden tracks. Off by default; not bit-perfect while on, and the signal path says so.',
      'Saving lyrics, a cover, an artist picture or Edit info for the track that is playing no longer makes it skip: TeleCloud shows the change at once and writes it into the file when the track stops (or when TeleCloud quits).',
      'The Discord status no longer stays on "Last played" or an earlier song: Discord only passes a change on every 15 seconds or so, so TeleCloud spaces its updates to match and always sends the song playing now (skipping quickly through tracks ends on the right one), sends the cover in the same update, and sends again what Discord missed or refused.',
      'The saved log tells more: what plays now and through which filters, under-runs since start, which lyrics, cover and artist picture sources answered or failed, the TeleCloud sign-in and backups, updates, and how much space the library and caches take. Still no song names unless you include them.',
    ],
  },
  {
    version: '1.1.0-beta.9',
    items: [
      'Settings > Lyrics > Word by word when available (on): NetEase, QQ Music and Kugou are asked for lyrics timed word by word, and those are preferred, so each word lights up as it is sung. Songs without them keep line-synced lyrics. The search window marks them "Word by word".',
      'The lyrics search no longer takes a remix, live, sped-up or instrumental version for the song you are playing (it still lists them, as a close match).',
      'Entering the cover-only view (H), the song title no longer shows for a moment near the player bar.',
    ],
  },
  {
    version: '1.1.0-beta.8',
    items: [
      'Settings > Playback > Exclusive mode buffer, as in Roon: how much music the DAC gets at a time in WASAPI Exclusive (device default, minimum, 20 to 200 ms). If your DAC clicks or skips now and then, try another size: some prefer a larger one, some USB DACs a smaller one. Still bit-perfect.',
      'The saved log sums up audio under-runs every 10 seconds, with the track and the time, instead of a line for each.',
      'When Telegram signs TeleCloud out (a sign-in unused for the time set in Telegram > Settings > Devices, or ended from another device), TeleCloud says so in words, keeps your backups and settings, and signs in again with just a code. The TeleCloud page shows how long Telegram keeps an unused sign-in, and opening TeleCloud keeps it signed in.',
      'The next cover no longer shows for a moment before the liquid change starts.',
      'Now Playing: the waveform sits in the middle of the player bar, and the cover-only view (H) is centred at any window size.',
      'The player holds less music in memory ahead of time, which helps on computers short of memory.',
    ],
  },
  {
    version: '1.1.0-beta.7',
    items: [
      'Smart playlists: a playlist made of rules (artist, genre, year, quality, format, MQA, plays, last played, date added, favourite, where it is), matching all or any, with an order and a limit. It keeps itself up to date and shows on the remote like any playlist.',
      'Playlists import and export as .m3u8 and .m3u. Tracks that are not in your library are listed, not dropped without a word; tracks only in TeleCloud have no file to point at and are counted.',
      'Most played this week, month or year, and On this day: what you were playing around this date in earlier years. On Discover and the Dashboard; the Dashboard can also show a range of dates you pick.',
      'Folders: browse your library the way it sits on disk, and play or shuffle a whole folder.',
      'Play next and Add to queue are in every track menu and the selection bar. Tracks added with Play next one after another keep their order, and a track can be played 2, 3 or 5 times in a row.',
      'The cover change between albums is smoother and more liquid: the new cover floods in as a growing circle, with rings running through both pictures and the colours splitting at its rim. Drawn on the graphics card, so it stays smooth in full screen too.',
      "Behind Now Playing, the cover's colours slowly drift like ink in water, and swirl out from the cover when the album changes, then slowly settle. Dark covers give their own colours, not a black screen.",
      'Opening Now Playing while the cover is changing carries the change on from where it was, instead of jumping to the new cover.',
    ],
  },
  {
    version: '1.1.0-beta.6',
    items: [
      "A waveform seek bar: the track's loudness over time behind the seek bar, worked out once per file. Settings > Appearance can turn it off.",
      'Lyrics word by word: Enhanced LRC (a time for each word) and TTML light up word by word as they are sung, in the side panel, full screen, the floating lyrics and the remote. Word timings saved as JSON can be pasted or opened (Open file… in the lyrics editor) and become Enhanced LRC.',
      "A new album's cover pours in like liquid over the last one, with waves rolling in behind the edge and a swell ahead of it, in the side panel, full screen and the player bar. Within one album, or with Reduce motion, it simply changes.",
      'The saved log now says which Appearance and Playback switches are on (Reduce motion, waveform, side panel, releasing the DAC, fades), the media controls, and the floating lyrics, so problems are easier to follow.',
      'Floating lyrics: a small window over every other one with the line being sung and the next. Drag it anywhere; lock it and clicks go through. From the lyrics card, the tray or Settings > Appearance.',
      'TeleCloud can be your default music player: choose it in "Open with" for FLAC, MP3, WAV, DSF and other music files. A file opened from Explorer plays at once in Now Playing, also from outside your music folders, without being added to the library.',
      'On a Galaxy Z Fold, a long title no longer pushes the open book past its page: the cover makes room.',
      "Explorer's thumbnail of a FLAC keeps showing the album cover after an artist picture is saved. Windows shows a file's last picture, so the cover now always comes last. Tracks saved before keep the old order until their artist picture or cover is saved again.",
    ],
  },
  {
    version: '1.1.0-beta.5',
    items: [
      "TeleCloud is in Windows' media controls: the box by the volume keys and the lock screen show the track and cover, with Play, Pause, Next, Previous and seeking. The keyboard's media keys work with TeleCloud in the background.",
      'Previous, Play/Pause and Next on the taskbar thumbnail, and in the tray menu.',
      'Sleep timer, from the moon in the player bar, the tray or the remote: in minutes, at the end of this track, at the end of the album, or after a number of tracks. The last 10 seconds fade out, and a stop at the end of a track leaves the next one ready.',
      'Settings > Playback > Let other apps use the DAC while paused: in WASAPI Exclusive and native DSD, a video or a game can play while TeleCloud is paused, and Play carries on from the same moment.',
      'Settings > Playback > Fade on play and pause, never while the signal path is bit-perfect.',
      "The remote's signal path now blinks red when the sound clips, as the computer's does.",
    ],
  },
  {
    version: '1.1.0-beta.4',
    items: [
      'Settings > Equalizer is now Sound, with Tone (Warmth, Bass, Treble, Loudness), Space (stereo width, mono, swap, polarity), Effects (Night mode, Air, Tube warmth) and room or headphone correction from an impulse response.',
      'Clipping shows: when the EQ or the sound settings push the music over 0 dBFS, the light in the signal path blinks red. Prevent clipping lowers the level by the biggest boost.',
      'A/B: hear the original at the same loudness, from Settings > Sound or the EQ page.',
      'The EQ page has a live spectrum under the curve, showing the music after every filter as it plays.',
      "When an album ends, another one plays: the artist's next album by year, or else the one beside it in Albums. It joins Up next as the last track starts, so there is no gap. Settings > Playback can turn it off.",
      'Settings > Appearance > Reduce motion: buttons, pages and menus change at once instead of moving or bouncing.',
      'The side panel on the right can be put away, with the panel button at the top, the one beside Now playing, or Ctrl+J. TeleCloud remembers it.',
      'The Signal path card in the side panel can be Full, Compact (only the verdict, such as Bit-perfect) or Off, in Settings > Appearance.',
      'The Settings list has a bar that runs up and down beside it, like the sidebar.',
      'The play button on album covers sits inside the picture, not on its edge.',
      'Light themes have softer, warmer shadows and fresher quality tags, so covers, cards and badges look lighter.',
      'The Formats bar on Discover is longer, and a format with only a few tracks still shows.',
    ],
  },
  {
    version: '1.1.0-beta.3',
    items: [
      'Remote: paired devices show the browser they really use, Samsung Internet, Edge, Firefox, Opera and more, or just "browser" when it is not known.',
      "Remote: a phone coming back from the background no longer flashes \"Can't reach TeleCloud\"; it reconnects at once.",
      'The Public network warning names your Wi-Fi, not the adapter.',
      'Discord shows the artist picture you chose, straight away, also one chosen in an older version: TeleCloud finds that same picture online again. One you uploaded yourself shows none, rather than another picture.',
      "A source that can't be reached says why in plain words, for example a VPN or security app answering instead of Last.fm.",
      'Saved logs tell more: the channel, displays and graphics, audio outputs, MQA, Last.fm, the remote and its devices.',
    ],
  },
  {
    version: '1.1.0-beta.2',
    items: [
      'Remote: albums sort by Latest added and Oldest added, like in the app, and each device remembers its choice.',
      'Remote: Back goes to the same place in a list, with what was already loaded, and so does switching tabs.',
      'Remote: long track names fit. The title gets the whole width and two lines, smaller as it grows; artist and album take a line each, and lyrics and favourite sit beside the quality.',
    ],
  },
  {
    version: '1.1.0-beta.1',
    items: [
      'TeleCloud Remote: a phone, a tablet or another computer on your Wi-Fi controls the music from its browser. Scan the QR code in Settings > Remote; nothing to install.',
      'From the remote: play, skip, seek, volume, Up next, the output and the EQ; browse and search albums, artists, playlists, favourites and recently played; lyrics that follow the music and the signal path.',
      'Each paired device can be set to View only, the computer can have its own name, and the remote follows tag, cover and artist picture changes straight away.',
      'On a Galaxy Z Fold the remote has layouts of its own: two pages around the crease when open, the controls on the bottom half in Flex Mode, and tabs under your thumb on the cover screen.',
      'Keep this computer awake while music plays, and the steps to wake it from a phone (Wake-on-LAN), in Settings > Remote.',
      'On a touch screen, pressing and holding a name cut off with "…" shows it in full.',
    ],
  },
  {
    version: '1.0.0-beta.21',
    items: [
      'The lyrics editor shows the line you are on, has a seek bar with a mark for every synced line, and a green band can follow the music line by line.',
      'Channel balance has a thumb that starts in the middle, the value rides above it, and a double-click centres it.',
      'MQA Studio gets its own blue badge. The MQA badge sits under the format, and the quality help explains both.',
      'The first track after starting TeleCloud plays straight through the output you chose, instead of shared mode for a moment.',
      'Checking a library for MQA no longer makes Windows show a busy cursor, and it is faster.',
    ],
  },
  {
    version: '1.0.0-beta.20',
    items: [
      'MQA is found in the audio itself, even without tags, and gets a violet badge and its own quality filter. It plays as plain PCM; Settings > Playback can send it untouched to an MQA DAC instead.',
      'Channel balance in 0.5 dB steps and headphone crossfeed, in Settings > Playback.',
      'Sorts and filters stay as you left them on Albums, Artists, Library, Favourites, TeleCloud and Playlists, also after a restart.',
      'The signal path is easier to read: a short label for each step and the reason on a line under it.',
      'DSD playback settings sit side by side, and MQA, DSD and the output limit have their own icons.',
      'On Discord, the small artist picture is named after that artist.',
    ],
  },
  {
    version: '1.0.0-beta.19',
    items: [
      'The back button on album and artist pages stays in place, so you can go back from the end of a long list.',
      'The small playing bars use much less CPU.',
    ],
  },
  {
    version: '1.0.0-beta.18',
    items: [
      'Performance settings have Low memory mode and Keep running in the tray. Opening TeleCloud again brings its window back.',
      'A smaller install, a lighter progress bar, and big album and artist pages open faster.',
      'Albums sort by Latest added and Oldest added.',
      'Open file location in the track menu, for tracks with a file on this computer.',
      'Downloads go into a folder named after the album, and Download album shows one progress bar.',
      'Discord shows the last track you played while nothing is loaded, and a small artist picture on the cover.',
    ],
  },
  {
    version: '1.0.0-beta.17',
    items: [
      'Animated GIF artist pictures. They move on the artist\'s own page and come back with Restore on another computer. Tags get the first frame, so your files stay small.',
      'Artist picture has a YouTube tab, asked only when you open it. Apple Music and MusicBrainz are new sources, and Find on VGMdb opens its search in your browser.',
      'DSF files can now hold artist pictures, covers, lyrics and tags.',
      'An output that goes away, like Bluetooth turned off, leaves the list. Playback moves to System default and goes back when that output returns.',
      'Albums can be sorted by Latest and Oldest.',
      'A failed update check now shows one short sentence.',
    ],
  },
  {
    version: '1.0.0-beta.16',
    items: [
      'Going from native DSD to a PCM track no longer stops with "audio output initialization failed". The DAC needs about a second to switch back from DSD, and TeleCloud now waits for it.',
      'If an output isn\'t ready, the track is tried again for a few seconds before an error shows.',
      'A DSD file whose rate the DAC can\'t take as DoP goes straight to PCM, instead of trying DoP again and again.',
    ],
  },
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
