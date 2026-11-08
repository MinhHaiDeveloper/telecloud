# TeleCloud: technical documentation

For what the app does and how to use it, see the [main README](../README.md). This file is for people working on the code.

TeleCloud is a hi-res music player for Windows, built with Electron and React. mpv plays the audio, and the user's own Telegram account stores the backup. No server belongs to the project.

## Tech stack

| Part | Used for |
|---|---|
| Electron | Desktop shell, main process, background processes |
| React and Vite | Interface in `src/` |
| mpv (`mpv.exe`, included in the repo) | Playback, EQ filters, spectrum decoding |
| `better-sqlite3` | Library, play history and TeleCloud tables |
| `music-metadata` | Reading tags and cover art |
| `node-taglib-sharp` | Writing tags and cover art |
| `telegram` (GramJS) | Telegram access, in its own process |
| `electron-updater` | Updates from GitHub Releases |
| `electron-store` | Encrypted TeleCloud credentials and options |

## Getting started

You need Node.js (currently developed on v24) and Windows 10 or 11, 64-bit.

```bash
git clone https://github.com/MinhHaiDeveloper/telecloud.git
cd telecloud
npm install
npm run dev
```

`npm run dev` starts Vite on port 3000 and opens Electron on it.

Every user enters their own Telegram app keys in the app, so no keys are needed to build it. Last.fm is the exception: it reads the app's key from `electron/lastfm-key.json`, or from `LASTFM_API_KEY` and `LASTFM_API_SECRET`. That file is not in git. Without it the app works, but Last.fm stays unavailable.

## Project layout

```
electron/            main process
  telecloud/         Telegram backup, streaming, restore
src/
  components/        React components
  hooks/             useEq, useSlidingIndicator
  utils/             logic with no interface
  styles/            tokens.css, app.css, components.css
scripts/release.js   build one channel into beta/ or release/
```

### Main process (`electron/`)

| File | Responsibility |
|---|---|
| `main.js` | Startup, window, `media://` protocol, folder watching |
| `preload.js` | The only bridge to the page, with allowlists of channels |
| `paths.js` | Decides which paths may be read, played, written or deleted |
| `database.js` | `music_files` table, migrations |
| `music.js` | Scanning, syncing with the database, JSON stores |
| `tags.js`, `tagPool.js`, `tagWorker.js` | Reading tags on worker threads |
| `tagEdit.js` | Writing tags from Edit info |
| `inferTags.js` | Filling in missing tags from the file name and folders |
| `fileWrite.js` | Plain-language write errors, writing to read-only files on request |
| `player.js` | mpv over JSON IPC, EQ chain, crossfade, output devices |
| `covers.js` | Finding and caching cover art |
| `coverSearch.js` | Online cover sources, saving covers |
| `lyrics.js` | Lyrics sources and saving |
| `stats.js` | Play history, play counts, Dashboard data |
| `lastfm.js` | Scrobbling and artist biographies |
| `discord.js` | Discord status over its local pipe |
| `autoeq.js` | Headphone measurements and target curves |
| `spectrum.js`, `spectrumCore.js` | Spectrogram and lossless check |
| `watcher.js` | Native folder watching, followed by a normal refresh |
| `updater.js` | Update checks and installation |
| `logger.js`, `logExport.js` | Log files and the log export |
| `credentialManager.js` | Encrypting Telegram credentials with Windows DPAPI |

### TeleCloud (`electron/telecloud/`)

| File | Responsibility |
|---|---|
| `service.js` | Sign-in, backup queue, cache, restore, storages, index |
| `store.js` | TeleCloud tables |
| `workerClient.js` | Starts the worker and passes calls to it |
| `worker.js` | Everything that talks to Telegram, in a separate process |
| `stream.js` | Local HTTP server that streams cloud tracks to mpv |
| `crypto.js` | Client-side encryption |
| `caption.js` | The text stored with each message in Telegram |

### Interface (`src/`)

`App.jsx` holds the shared state: library, playback, queue, navigation. Views get what they need as props or through the `SongActions` context in `components/songActions.js`.

| File | Responsibility |
|---|---|
| `utils/albums.js` | Which tracks form an album and who owns it. Every page uses it |
| `utils/audio.js` | Formatting, quality labels, signal path, duplicates, cover addresses |
| `utils/autoEqMath.js` | Filter responses, AutoEQ, Squiglink and Audacity formats |
| `utils/appearance.js` | Full-screen look, saved in `localStorage` |
| `utils/whatsNew.js` | Release notes shown in the app |
| `utils/badges.js` | Text for the Source, Quality and Plays help |
| `components/ui.jsx` | Shared controls, dialogs, `useDetailScroll` |

## How it works

### Security boundary

The page runs with `contextIsolation`, `sandbox` and no `nodeIntegration`. It reaches the main process only through `window.ipcRenderer` in `preload.js`.

- A new IPC channel must be added to `INVOKE_CHANNELS` or `EVENT_CHANNELS`, otherwise the call is refused.
- Any handler that takes a path from the page must check it with `paths.js`.

### Library

`syncLibrary` in `music.js` compares the music folders with the database by path, size and modified time. Only new or changed files are read, on worker threads, and the results reach the page in batches.

A backed-up track whose file disappears becomes cloud-only. Tracks in a folder that can't be read, such as an unplugged drive, are kept. A backed-up file whose bytes change is uploaded again.

Older libraries gain `album_artist` from `backfillAlbumArtists`, which runs once in the background and changes only that column.

### Albums and artists

`Various Artists` and `Unknown Artist` are labels, not artists (`artistLabel`). They are pinned first on the Artists page, hold the albums nobody is named on, show a grid of those covers, and never get a search or a bio.

`albumIndex` in `utils/albums.js` groups tracks like this:

- The same name and overlapping album artists make one album, however many guests the tracks have.
- The same name with different album artists makes separate albums.
- Without an album artist tag, tracks in one folder stay together, and across folders they join when the main artist matches.

An album without the tag belongs to an artist who is on more than half of its tracks. Otherwise it shows as Various Artists.

`inferTags.js` fills in missing title, artist, album, track, disc and year when a row goes to the page. These values are for display and are never written to the file. The `metadata.inferred` field lists which ones they are.

### Playback

`player.js` runs one mpv process and controls it over a named pipe. Exclusive WASAPI gives bit-perfect output, with volume fixed at 100. Each EQ band is a filter in the mpv `lavfi` chain.

Extra copies of a track are removed from the queue when playback starts, in `playMusic`.

**EQ per output.** With the option on, `useEq` keeps one profile per device id in `profiles` in `eq.json`. The top-level values stay as the shared EQ. A device seen for the first time starts from what is on.

**ReplayGain Auto.** The renderer decides: album gain when shuffle is off and a neighbour in the queue belongs to the same album, otherwise track gain. It tells `player.js` through `player:replaygain-auto`.

### Themes

A theme is a block of CSS tokens on `[data-theme]`: Dark and Vanilla in `styles/tokens.css`, the others in `styles/themes.css`. `utils/themes.js` lists them. Adding one takes a token block and a line in that list. Text on the accent colour uses `--on-accent`, never a fixed white.

**Follow the cover.** `useCoverAccent` overrides the accent tokens on the root element with a colour from the cover playing. `utils/coverAccent.js` picks the main hue, then moves its lightness until it reads on the theme's page and card colours. Covers without a clear colour keep the theme's accent.

### DSD

mpv can't send DSD to a DAC. It decodes it to floating-point PCM at 1/8 of the DSD rate (2822.4 kHz for DSD512), so `dsdOptions` in `player.js` asks for 352.8 kHz whole-number PCM instead, or the highest rate of that family under the output limit.

**DoP** (Settings > Playback > DSD playback) packs 16 DSD bits under an alternating 0x05/0xFA marker into each 24-bit sample (`dsd.js`, DSF and plain DFF). The samples are served from 127.0.0.1 as a WAV (RF64 past 4 GB) and mpv reads them with no filters. Not raw PCM: mpv's raw reader stops at 384 kHz, and DSD256 as DoP is 705.6 kHz. It is used only in WASAPI Exclusive with the EQ off and under the chosen highest rate. The file starts muted, and `judgeDop` unmutes it only when mpv opened the device at exactly the DoP rate as whole numbers. Otherwise the rate is remembered as refused for that device, and the track goes on as PCM from the same moment. Turning the EQ on or switching to shared mode does the same.

**Native DSD** goes through `native/asio/tc-asio.exe`, a small C++ program on the Steinberg ASIO SDK (used under its GPL-3.0 option; the SDK files are in `native/asio/sdk`). Build it with `native\asio\build.cmd` before packaging; electron-builder copies it next to mpv.exe. It reads the DSF/DFF itself and copies the bytes to the driver's DSD buffers, reversing the bit order when the driver wants the other one, so nothing changes on the way. Pauses and gaps send DSD silence (0x69), never zeros. A gapless join works when the next file has the same rate and channels.

`asio.js` runs the helper; `player.js` tries native first when it is chosen. mpv is closed while ASIO has the DAC and started again for the next PCM file. A driver that can't play the file (no DSD, not that rate, busy, an error while playing) hands the track to mpv at the same moment: DoP if it can, else PCM. The reason shows in the signal path and the log. The EQ can't touch native DSD, so turning it on does the same. "TeleCloud test output" (only with TC_ASIO_TEST_OUT set) plays in real time into files, so tests check every byte without hardware.

ASIO is a trademark of Steinberg Media Technologies GmbH.

### Covers

`media://<encoded path>[?r=revision]` serves artwork for library tracks. Lookup goes through `artFor` in `main.js`:

- **File on this computer:** embedded art, then a picture in the folder such as `cover.jpg`.
- **Cloud-only track:** the stored TeleCloud cover first, then the cached copy's art.

Results are cached in `cover-cache` at up to 600 px. After a save, `bumpCovers` gives the affected tracks a new address, so the browser doesn't keep showing the old picture.

Saving goes to `cover.jpg`, to the tags, or both. If a folder holds another album, the cover goes to the tags instead. Embedded art has priority over `cover.jpg`, so replacing a cover also replaces the embedded one. Files that change this way are backed up again.

### Artist pictures

`artistImages.js` works like the cover search: an ordered list of sources and results to pick from. Last.fm's API only returns a placeholder, so that source reads the artist's public page. Sources: this computer, Last.fm, Deezer and TheAudioDB (its public free key; its terms ask for credit, which the source badge on each result gives). A saved picture goes into the tags of the artist's own tracks as an `Artist` picture (ID3 type 8), beside the front cover. A copy in `artist-images` lets the pages show it without reading the files, and is the only copy for cloud-only tracks. A track counts as an artist's own only if it belongs to them alone, so a picture is never written into a shared track. M4A and other formats without picture labels are skipped, because the picture would become a second cover there. `Various Artists` and `Unknown Artist` are never searched.

### TeleCloud

Telegram work runs in a `utilityProcess` (`worker.js`), so the interface stays smooth. The worker receives `{ id, method, params }` and answers with a result or an error; progress arrives as events.

**Upload.** Files move in 512 KB parts and are never held whole in memory. The same audio already in a storage is linked rather than uploaded twice.

**Encryption.** There is one random master key per user, shown as a recovery key. Audio uses AES-256-CTR, so any byte range can be decrypted on its own. Captions use AES-256-GCM, so a wrong key or tampering is detected.

**Streaming.** `stream.js` serves each cloud track from `127.0.0.1` at a secret address, and mpv reads it with byte-range requests. Seeking works, and the bytes are exactly the uploaded file. Blocks are cached on disk and become a normal cached file once complete and verified.

**Index.** The manifest (`library.tcm`) holds tags, lyrics and cover references. It is pinned in the chat and rewritten after changes. Restore on another computer reads it, and falls back to the captions if it can't.

**Check backup.** `checkBackup` lists each chat and compares it with the library, `cloud_index`, the manifest and the covers. It only compares message ids and sizes, so damage inside a file of the right size isn't seen. `repairBackup` queues tracks still on this computer again, uploads lost covers from the local copy, and saves the index. It deletes a wrong-size copy from the chat first, otherwise the same hash would link back to it.

**Caption prefixes in Telegram:** `tc1:` for audio, `tcm1:` for the manifest, `tcc1:` for covers. They also tell TeleCloud's messages apart from the user's own.

### Discord

`discord.js` talks to the Discord desktop app over its local pipe, using the application ID in that file. It is off by default. The cover is a public picture from the online sources, otherwise the `telecloud` art asset. A **Get TeleCloud** button links to the website unless turned off. Updates go out at most once every 4 seconds. The app never uploads files for this.

### Logs

`logger.js` is started first in `main.js` and records everything sent to `console`, plus window errors, crashes, the worker, scan threads and mpv warnings.

- Files are in `logs/YYYY-MM-DD.log`. Limits: 14 days, 50 MB in total, 15 MB per day. Repeated lines are folded.
- `redact` removes secrets before writing, and `logExport.js` runs it again on export. Credentials are registered with `addSecrets` when they are loaded.
- The export also hides music names unless the user includes them. `system.txt` lists settings only from the `SAFE_SETTINGS` allowlist.

When adding a log line, don't log credentials, captions or track names. Paths are fine, because the export hides them.

## Data on disk

Everything is in `%APPDATA%\telecloud`.

| Location | Contents |
|---|---|
| `music-library.db` | SQLite database |
| `settings.json` and other stores in `music.js` | Settings, playlists, favourites |
| `lyrics-settings.json`, `cover-settings.json`, `discord-settings.json` | Options of each feature |
| `telecloud-sync.json` | Telegram credentials and options |
| `lastfm.json` | Last.fm account, with the session key encrypted |
| `audio-cache/` | Downloaded cloud tracks |
| `cover-cache/` | Cover cache and TeleCloud covers |
| `telecloud/` | Cached manifests |
| `logs/` | Log files |

Database tables:

| Table | Holds |
|---|---|
| `music_files` | One row per track: tags, `album_artist`, audio details, `storage_type` (`local`, `cloud`, `both`), `telegram_message_id`, `telegram_channel_id`, `cache_path`, `cloud_checksum`, `cloud_cover` |
| `plays` | Listening history. Title, artist and album are kept with each play |
| `storages` | Telegram chats used as storage, up to 5 |
| `cloud_index` | One row per file message: checksum, size, IV, track info |
| `upload_queue` | Backups waiting, running or failed; survives restarts |
| `cloud_covers` | Which cover is in which storage |
| `sync_state` | Older per-file sync details |

A cloud-only track restored on another computer has a path like `tc://<chat>/<message>`.

## Building

```bash
npm run build:beta
```

```bash
npm run build:release
```

`build:beta` needs a pre-release version such as `1.0.0-beta.12` in `package.json`, and `build:release` needs a plain one. Each version builds once: the script stops if its folder already exists. The result goes to `beta/telecloud-<version>/` or `release/telecloud-<version>/`.

If `build:beta` fails with `EPERM` on `win-unpacked.tmp`, another program is holding the folder. The cause hasn't been pinned down. Building outside the project works:

```bash
npx vite build
```

```bash
npx electron-builder --win --publish never "-c.directories.output=C:\some\other\folder"
```

Then copy the installer, its `.blockmap` and `latest.yml` to the `beta/` folder yourself.

### Releasing

1. Set the new version in `package.json`, and add its notes at the top of `RELEASES` in `src/utils/whatsNew.js`.
2. Build, then commit and **push before creating the release**, so the tag points at the right commit.
3. Create the GitHub release with the tag `v<version>`, and tick pre-release for a beta.
4. Upload the `.exe`, the `.blockmap` and `latest.yml`. Auto-update needs all three.

Beta installs also receive pre-releases; stable installs only receive releases.

## Testing hooks

There is no test suite in the repo. These environment variables let a script run the real app without touching real devices or services:

| Variable | Effect |
|---|---|
| `TELECLOUD_MPV_AO` | Audio output for mpv, for example `null` for silence |
| `TELECLOUD_DISCORD_PIPE` | Pipe to use instead of the real Discord |
| `TELECLOUD_FAKE_CLIENT` | Module to use instead of the real Telegram client |
| `TELECLOUD_IN_PROCESS` | Runs the TeleCloud worker in the same process |
| `TELECLOUD_MANIFEST_EVERY` | How many tracks between index saves during a backup |
| `LASTFM_API_URL`, `LASTFM_AUTH_URL` | Addresses to use instead of Last.fm |

## License

[GPL-3.0](../LICENSE)
