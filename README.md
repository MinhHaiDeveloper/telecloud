<p align="center">
  <img src="public/icon.png" width="128" alt="TeleCloud">
</p>

<h1 align="center">TeleCloud</h1>

<p align="center">A hi-res music player for Windows that backs up your library to your own Telegram account.</p>

---

## What it does

TeleCloud plays the music files on your computer the way they were recorded, and keeps a private copy of them in Telegram. Telegram gives every account unlimited storage, so your whole collection is safe and can be streamed back to any computer where you sign in.

- **Plays your files as they are.** FLAC, ALAC, WAV, AIFF, APE, WavPack, DSD and the common lossy formats. With an exclusive output device, the sound goes to your DAC untouched (bit-perfect).
- **Backs up to Telegram.** Your music goes into a private channel that only you can see. Files are encrypted before they leave your computer.
- **Streams from the cloud.** Tracks that are only in TeleCloud play straight from Telegram and are kept in a cache for next time.
- **Restores on a new computer.** Sign in, restore, and your library comes back with its tags, lyrics and album covers.

## Download and install

1. Download `TeleCloud-Setup-<version>.exe` from the [Releases](https://github.com/MinhHaiDeveloper/telecloud/releases) page.
2. Run it and follow the installer. Everything TeleCloud needs is included.
3. Open TeleCloud from the Start menu or the desktop shortcut.

TeleCloud runs on Windows 10 and Windows 11 (64-bit).

> Windows may show a "Windows protected your PC" screen the first time, because the app is new and not yet widely downloaded. Click **More info** and then **Run anyway**.

## Getting started

### 1. Add your music

Open **Settings > Library**, click **Add folder** and choose where your music lives. You can add several folders. TeleCloud reads your tags and covers and keeps the library up to date when you add, move or delete files.

### 2. Choose how it sounds

In **Settings > Playback**:

- **Output device:** pick your DAC or headphones. Devices marked *exclusive* give bit-perfect playback; *System default* shares the sound with other apps.
- **ReplayGain:** evens out the volume between tracks or albums.
- **Crossfade:** blends the end of one track into the next (in shared mode).
- **Limit output format:** caps the sample rate and bit depth if your device cannot handle very high resolutions.

The **Signal path** panel on the right shows exactly what happens to the sound on its way to your device.

### 3. Equalizer (optional)

**Settings > Equalizer** has a 31-band equalizer. Drag the points on the curve or scroll over them, and changes are heard immediately.

- **AutoEQ:** choose your headphones and a target sound, and TeleCloud builds a correction for you.
- **Import and export** presets in the format used by Squiglink.
- **Undo and redo** with `Ctrl+Z` and `Ctrl+Y`.

### 4. Back up to TeleCloud (optional)

Open **Settings > TeleCloud Sync** and follow the steps:

1. **Get your Telegram app keys.** Go to [my.telegram.org/apps](https://my.telegram.org/apps), sign in with your phone number and create an app (any name works). Copy the **API ID** and **API hash** into TeleCloud. They stay on your computer, protected by Windows.
2. **Sign in.** Enter your phone number and the code Telegram sends you, plus your password if you use two-step verification.
3. **Choose where to store your music.** A private channel is recommended. Saved Messages also works.
4. **Keep encryption on** (recommended) and **save your recovery key** somewhere outside this computer, for example in a password manager. You need it to open your backup after reinstalling Windows or on another computer.
5. Click **Back up now**. You can pause at any time and continue later.

## Using TeleCloud

### Finding your music

Browse by **Library**, **Albums**, **Artists**, **Playlists**, **Favourites** and **Recently played**, or press `Ctrl+K` to search. The **Discover** page shows your recently added albums and what you played last.

### Where a track lives

Each track shows small labels in the **Source** column. The info icon next to "Source" explains them.

| Label | Meaning |
|---|---|
| Local | The file is on this computer. |
| Local + Cloud | On this computer and backed up to TeleCloud. |
| Cloud | Only in TeleCloud. It streams from Telegram when you play it. |
| Cloud + Cached | Only in TeleCloud, but already downloaded, so it plays instantly and offline. |

The **Quality** column shows the format: for example **FLAC 24/96** for hi-res, **FLAC 16/44.1** for CD quality, or **MP3 320** for lossy files (the number is the bitrate).

### Selecting several tracks

- `Ctrl` + click selects or unselects one track.
- `Shift` + click selects every track between two clicks.
- `Ctrl+A` selects every track in the list, `Esc` clears the selection.

A bar appears at the bottom, where you can play the selection, add it to a playlist, back it up, or remove it from TeleCloud.

### Several storages

You can keep up to five storages, such as "Hi-Res Vault" for your best albums and the default channel for everything else. Add them in **Settings > TeleCloud Sync > Storages**, then use **Back up to...** on a track, an album, a playlist or a selection. Each track is kept in one storage only, so nothing is uploaded twice.

### Removing music from TeleCloud

Use **Remove from TeleCloud** in a track's menu, in an album or playlist menu, or on a selection. Only those tracks are deleted from Telegram; the rest of the storage stays.

- If the file is still on your computer, it simply becomes a Local track again.
- If the track only existed in TeleCloud, it leaves your library for good. TeleCloud asks before doing this.

### Saving a track to your computer

Choose **Download** in the menu of a cloud track to keep a copy on your computer. The download folder can be changed in **Settings > Downloads**.

### Restoring on another computer

Install TeleCloud, sign in with the same Telegram account, enter your recovery key under **Encryption**, and choose **Restore**. Your tracks appear with their tags, lyrics and covers, ready to stream or download.

## Keeping your backup safe

The **Do's & don'ts** button in **Settings > TeleCloud Sync** has the full list. The most important points:

**Do**

- Leave TeleCloud open until the backup has finished.
- Press **Pause** before quitting in the middle of a backup.
- Keep your recovery key outside this computer.
- Remove or move tracks from inside TeleCloud.

**Don't**

- Delete, edit or forward TeleCloud files in Telegram yourself.
- Delete the `library.tcm` file in your storage chats. It is the index other computers restore from.
- Leave or delete a storage channel in Telegram. Remove it in TeleCloud's settings instead.
- Restart the app when it says it is waiting. That is Telegram's speed limit, and TeleCloud continues by itself.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Play / pause | `Space` |
| Next track | `Right arrow` |
| Previous track | `Left arrow` |
| Volume up / down | `Up arrow` / `Down arrow` |
| Seek forward / back | `Ctrl+Right` / `Ctrl+Left` |
| Mute | `M` |
| Search | `Ctrl+K` |
| Select all tracks | `Ctrl+A` |

You can change the playback shortcuts in **Settings > Keyboard**.

## Questions

**Is my music private?**
Yes. It is stored in your own Telegram account, in a channel only you can see. With encryption on, the files cannot be played by anyone who does not have your recovery key, Telegram included.

**How much can I store?**
Telegram does not limit the total size. Single files can be up to 2 GB, which covers almost any album track.

**Does streaming change the sound?**
No. The exact file you uploaded is streamed back, and TeleCloud checks it against the original before saving it to the cache.

**How much disk space does the cache use?**
5 GB by default. You can change it or clear it in **Settings > TeleCloud Sync > Cache**. The oldest tracks are removed first when it is full.

**I lost my recovery key.**
Your backup can still be used on the computer where you made it. You can see the key there under **Settings > TeleCloud Sync > Encryption**. Without the key, encrypted files cannot be opened anywhere else.

## Feedback

TeleCloud is in beta and made by a single developer. If something does not work as expected, or you have an idea, please open an issue on the [Issues](https://github.com/MinhHaiDeveloper/telecloud/issues) page.

TeleCloud is not affiliated with Telegram.

## License

TeleCloud is free software under the [GNU General Public License v3.0](LICENSE).
