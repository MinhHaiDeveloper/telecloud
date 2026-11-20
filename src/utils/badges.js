import { t } from '../i18n';
// What the tags next to tracks mean (shared by the Source popover and the badges dialog)

export const SOURCE_HELP = [
  { get tags() { return [['b-local', t('Local')]]; }, get text() { return t('The file is on this computer. Plays instantly, no internet needed.'); } },
  { get tags() { return [['b-local', t('Local')], ['b-cloud', t('Cloud')]]; }, get text() { return t('On this computer and backed up to TeleCloud.'); } },
  { get tags() { return [['b-cloud', t('Cloud')]]; }, get text() { return t('Only in TeleCloud. Streams from Telegram when you play it (starts in a second or two).'); } },
  { get tags() { return [['b-cloud', t('Cloud')], ['b-cached', t('Cached')]]; }, get text() { return t('Only in TeleCloud, but already downloaded to the cache: plays instantly and offline. The oldest cached tracks are removed when the cache is full.'); } },
];

export const playsHelp = () => [
  t('A play counts once you have listened to half of the track, or 4 minutes if that comes first.'),
  t('Tracks of 30 seconds or less are not counted, and parts you skip over are not listening time.'),
  t('Each listen counts again, including on repeat. The number updates when the track ends or you move on.'),
  t('The count stays with the track if you move or rename the file.'),
];

export const QUALITY_HELP = [
  { tags: [['b-hires', 'FLAC 24/96']], get text() { return t('Hi-Res: lossless above 16-bit or 48 kHz, or DSD.'); } },
  { tags: [['b-lossless', 'FLAC 16/44.1']], get text() { return t('CD-quality lossless.'); } },
  { tags: [['b-lossy', 'MP3 320']], get text() { return t('Lossy: the format and its bitrate in kbps, read from the file (MP3 320, AAC 256, MP3 96…). Higher sounds closer to the original.'); } },
  { tags: [['b-mqa', 'MQA 88.2']], get text() { return t('MQA, found in the audio itself or its tags. The number is the original rate the encoder recorded. TeleCloud plays it as the plain PCM it is (see Settings > Playback).'); } },
  { tags: [['b-mqa-studio', 'MQA Studio 88.2']], get text() { return t('MQA Studio: MQA that the label or the artist says they checked in the studio. Only a label: the music inside is the same kind of MQA.'); } },
];
