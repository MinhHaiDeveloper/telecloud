# Security

## Reporting a problem

Please report security problems **privately**, through GitHub's
[private vulnerability reporting](https://github.com/MinhHaiDeveloper/telecloud/security/advisories/new), not in a
public issue. You will get an answer as soon as the developer can, and credit in the release notes if you would like it.

Only the latest release and the latest beta get fixes.

## How the backup is protected

The full description, for users, is on the [Security page](https://telecloud-music.pages.dev/security/). In short:

- **One key, made on your computer.** A random 256-bit master key, shown once as a recovery key. It is never sent
  anywhere. On your computer it is protected by Windows' data protection (DPAPI), with your Telegram sign-in.
  Separate keys for files and for track info are derived from it (HKDF-SHA256).
- **Music files:** AES-256-CTR with a random IV per file, so a track can stream and seek without being downloaded
  whole. File names are replaced by a random-looking name.
- **Track info, the library index's checksum:** AES-256-GCM, so a wrong key or a changed caption is caught.
- **Storages:** your own Telegram chats, or a folder you pick (a second drive, a NAS, a synced cloud folder). The same
  encryption applies to both. No server belongs to TeleCloud.

## Integrity: "CTR has no MAC, so who checks the data?"

Everything that comes back is checked against a checksum kept where it cannot be changed without your key:

| What | Checked against | Where it is kept |
|---|---|---|
| A track | SHA-256 of the original file | Its caption, sealed with AES-GCM |
| The library index | SHA-256 of the index | Its caption, sealed with AES-GCM (from 1.1.0-beta.18) |
| An album cover | Its name, the start of its SHA-1 | The library index |
| An artist GIF | Its name, the start of its SHA-256 | The library index |

A track is hashed while it streams or downloads and only becomes a cached file if it matches. A cover or GIF that does
not match is not saved, and a library index that does not match is reported by Check backup instead of being read.
The code is in [`electron/telecloud/`](electron/telecloud) (`crypto.js`, `caption.js`, `stream.js`, `worker.js`), and
[`src/README.md`](src/README.md#telecloud) describes it for developers.

## What it does not protect against

- Someone who controls your Windows account, or malware running in it: they can use TeleCloud as you can.
- Someone who takes over your Telegram account: they cannot read the files, but they could delete them. Turn on
  Telegram's two-step verification.
- A lost recovery key: there is no way around it, by design.
- File sizes and upload times, which the storage (Telegram, or whoever runs the folder) can see.

## The Remote

The Remote works only on your home network. A device pairs with a one-time key from the QR code, then keeps its own
token in a cookie the page cannot read; TeleCloud stores only a hash of each token. Devices can be made watch-only or
removed, and a new key signs every device out.
