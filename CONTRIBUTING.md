# Contributing to TeleCloud

Thank you for helping. Bug reports, translations and code are all welcome.

## Reporting a bug

Open an issue on the [Issues](https://github.com/MinhHaiDeveloper/telecloud/issues) page. Say which version you use
(Settings > About) and what you did. A log helps a lot: **Settings > About > Save the log**. Passwords, keys and your
Telegram session are never in it.

## Running from source

You need Windows 10 or 11 (64-bit) and Node.js 20 or later.

```
npm install
npm run dev
```

`npm run dev` starts the interface on port 3000 and opens the app. `mpv.exe` and `mpv.com` must be in the project
folder. Last.fm and YouTube keys are optional and go in `electron/lastfm-key.json` and `electron/youtube-key.json`;
never commit them.

`npm run build` makes an installer in `out/installer`. Every build first checks two things and stops if one fails:
the Settings search index (`src/utils/settingsIndex.js`) and the text catalog (`src/locales/en.json`).

## Writing code

- Keep changes small and focused, one topic per pull request.
- Reuse what is there: the controls in `src/components/ui.jsx`, the styles in `src/styles/`.
- Anything that changes the sound must show in the Signal path, and must never run while playback is bit-perfect
  unless the user turned it on.
- Text in the interface is English, short and plain, and goes through `t()`. See [Text and translations](#text-and-translations).
- A new setting needs a line in `src/utils/settingsIndex.js` so the Settings search finds it. The build tells you if
  one is missing.

## Text and translations

Every piece of text a person reads in the app goes through `t()` from `src/i18n.js`:

```jsx
import { t } from '../i18n';

<button title={t('Play next')}>{t('Play next')}</button>
<span>{t('{count} tracks', { count })}</span>
```

- The English text is the key. Write the whole sentence in one `t()`, with `{name}` for the parts that change; do
  not glue pieces together, since other languages order words differently.
- The first argument must be written out as text, not a variable, so the build can find it.
- Text kept outside a component (a list of tabs or options) is a getter, `get label() { return t('Album'); }`, so it
  follows when the language changes.
- In the main process (`electron/`) the same works with `tx()` from `electron/i18n.js`.
- Names of formats and standards (FLAC, DSD, WASAPI, dB) stay as they are and need no `t()`.

The build collects every text into `src/locales/en.json`. A translation is a file next to it named after the language
(`vi.json`, `zh-CN.json`, `ja.json`), with the same keys and the translated text as values. Text that is missing from
a translation shows in English. The terms in `src/locales/terms.json` (Bit-perfect, WASAPI, DSD, MQA…) stay as they
are; the build fails when a translation leaves one out.

## Sign-off and licence of contributions

TeleCloud is under the [GNU General Public License v3.0](LICENSE). By opening a pull request you agree to the following
for everything you contribute:

1. **Developer Certificate of Origin.** You certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
   you wrote the contribution, or have the right to submit it under the project's licence.
2. **Licence grant.** You license your contribution under the GPL-3.0, and you also grant the project's maintainer a
   perpetual, worldwide, non-exclusive, royalty-free right to use, change and distribute it under other licences,
   including in builds sold through app stores. You keep the copyright to your work.

Add a sign-off line to each commit to confirm both points. `git commit -s` writes it for you:

```
Signed-off-by: Your Name <you@example.com>
```

Pull requests with unsigned commits cannot be merged.

Code from projects whose licence does not allow it cannot be accepted. This includes code copied from other music
players under licences that are not compatible with the GPL-3.0, and from projects with no licence at all.
