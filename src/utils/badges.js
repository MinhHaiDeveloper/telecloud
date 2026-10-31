// What the tags next to tracks mean (shared by the Source popover and the badges dialog)

export const SOURCE_HELP = [
  { tags: [['b-local', 'Local']], text: 'The file is on this computer. Plays instantly, no internet needed.' },
  { tags: [['b-local', 'Local'], ['b-cloud', 'Cloud']], text: 'On this computer and backed up to TeleCloud.' },
  { tags: [['b-cloud', 'Cloud']], text: 'Only in TeleCloud. Streams from Telegram when you play it (starts in a second or two).' },
  { tags: [['b-cloud', 'Cloud'], ['b-cached', 'Cached']], text: 'Only in TeleCloud, but already downloaded to the cache: plays instantly and offline. The oldest cached tracks are removed when the cache is full.' },
];

export const QUALITY_HELP = [
  { tags: [['b-hires', 'FLAC 24/96']], text: 'Hi-Res: lossless above 16-bit or 48 kHz, or DSD.' },
  { tags: [['b-lossless', 'FLAC 16/44.1']], text: 'CD-quality lossless.' },
  { tags: [['b-lossy', 'MP3 320']], text: 'Lossy: the format and its bitrate in kbps, read from the file (MP3 320, AAC 256, MP3 96…). Higher sounds closer to the original.' },
];
