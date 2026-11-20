// Settings → General → Performance: the close button can hide TeleCloud to the tray instead of
// quitting. Off by default. Music keeps playing, since playback doesn't depend on the window.
const { app, Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const { readSettings } = require('./paths');
const { tx, onLanguage } = require('./i18n');

let tray = null;
let quitting = false;
let now = { playing: false, hasTrack: false, sleep: null, floating: { open: false, locked: false } }; // what plays, for the menu

// the sleep timer's choices, as in the player bar
const SLEEP = () => [[15, tx('15 minutes')], [30, tx('30 minutes')], [45, tx('45 minutes')], [60, tx('1 hour')], [90, tx('1 hour 30')]];
function menu() {
  const media = (cmd, value) => () => require('./media').command(cmd, value !== undefined ? { value } : {});
  return Menu.buildFromTemplate([
    { label: tx('Show TeleCloud'), click: showWindow },
    { type: 'separator' },
    { label: now.playing ? tx('Pause') : tx('Play'), enabled: now.hasTrack, click: media('toggle') },
    { label: tx('Next'), enabled: now.hasTrack, click: media('next') },
    { label: tx('Previous'), enabled: now.hasTrack, click: media('prev') },
    {
      label: now.sleep ? tx('Sleep timer: {label}', { label: now.sleep.label }) : tx('Sleep timer'),
      submenu: [
        ...SLEEP().map(([m, label]) => ({ label, click: media('sleep', { minutes: m }) })),
        { type: 'separator' },
        { label: tx('End of this track'), enabled: now.hasTrack, click: media('sleep', { kind: 'track' }) },
        { label: tx('End of this album'), enabled: now.hasTrack, click: media('sleep', { kind: 'album' }) },
        { type: 'separator' },
        { label: tx('Off'), enabled: !!now.sleep, click: media('sleep', null) },
      ],
    },
    { type: 'separator' },
    { label: tx('Floating lyrics'), type: 'checkbox', checked: !!now.floating?.open, click: () => require('./floatingLyrics')[now.floating?.open ? 'close' : 'open']() },
    { label: tx('Lock floating lyrics'), type: 'checkbox', checked: !!now.floating?.locked, enabled: !!now.floating?.open, click: () => require('./floatingLyrics').setLocked(!now.floating?.locked) },
    { type: 'separator' },
    { label: tx('Quit TeleCloud'), click: () => app.quit() },
  ]);
}
/** The renderer's state changed: the menu follows, if the tray is there */
function update(next) {
  const was = JSON.stringify(now);
  now = { ...now, ...next };
  if (tray && JSON.stringify(now) !== was) tray.setContextMenu(menu());
}

// a new language: the menu is built again in it
onLanguage(() => { if (tray) tray.setContextMenu(menu()); });

function showWindow() {
  const win = require('./mainWindow').get();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray() {
  if (tray) return;
  const beta = require('../package.json').version.includes('-');
  const icon = path.join(__dirname, app.isPackaged ? '../dist' : '../public', beta ? 'icon-beta.png' : 'icon.png');
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16, quality: 'best' }));
  tray.setToolTip(beta ? 'TeleCloud Beta' : 'TeleCloud');
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
}

function attach(win) {
  win.on('close', (e) => {
    if (quitting || !readSettings().closeToTray) return;
    e.preventDefault();
    ensureTray();
    win.hide();
  });
  win.on('session-end', () => { quitting = true; }); // Windows is shutting down: don't hold it up
}

app.on('before-quit', () => { quitting = true; });
app.on('second-instance', showWindow); // opening TeleCloud again brings this window back

module.exports = { attach, update, _menu: () => menu().items.map(i => ({ label: i.label, enabled: i.enabled, sub: i.submenu ? i.submenu.items.map(s => s.label) : null })) };
