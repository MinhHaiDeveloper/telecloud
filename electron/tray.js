// Settings → General → Performance: the close button can hide TeleCloud to the tray instead of
// quitting. Off by default. Music keeps playing, since playback doesn't depend on the window.
const { app, Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const { readSettings } = require('./paths');

let tray = null;
let quitting = false;
let now = { playing: false, hasTrack: false, sleep: null }; // what plays, for the menu

// the sleep timer's choices, as in the player bar
const SLEEP = [[15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '1 hour 30']];
function menu() {
  const media = (cmd, value) => () => require('./media').command(cmd, value !== undefined ? { value } : {});
  return Menu.buildFromTemplate([
    { label: 'Show TeleCloud', click: showWindow },
    { type: 'separator' },
    { label: now.playing ? 'Pause' : 'Play', enabled: now.hasTrack, click: media('toggle') },
    { label: 'Next', enabled: now.hasTrack, click: media('next') },
    { label: 'Previous', enabled: now.hasTrack, click: media('prev') },
    {
      label: now.sleep ? `Sleep timer: ${now.sleep.label}` : 'Sleep timer',
      submenu: [
        ...SLEEP.map(([m, label]) => ({ label, click: media('sleep', { minutes: m }) })),
        { type: 'separator' },
        { label: 'End of this track', enabled: now.hasTrack, click: media('sleep', { kind: 'track' }) },
        { label: 'End of this album', enabled: now.hasTrack, click: media('sleep', { kind: 'album' }) },
        { type: 'separator' },
        { label: 'Off', enabled: !!now.sleep, click: media('sleep', null) },
      ],
    },
    { type: 'separator' },
    { label: 'Quit TeleCloud', click: () => app.quit() },
  ]);
}
/** The renderer's state changed: the menu follows, if the tray is there */
function update(next) {
  const was = JSON.stringify(now);
  now = { ...now, ...next };
  if (tray && JSON.stringify(now) !== was) tray.setContextMenu(menu());
}

function showWindow() {
  const win = BrowserWindow.getAllWindows()[0];
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
