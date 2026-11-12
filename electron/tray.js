// Settings → General → Performance: the close button can hide TeleCloud to the tray instead of
// quitting. Off by default. Music keeps playing, since playback doesn't depend on the window.
const { app, Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const { readSettings } = require('./paths');

let tray = null;
let quitting = false;

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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show TeleCloud', click: showWindow },
    { type: 'separator' },
    { label: 'Quit TeleCloud', click: () => app.quit() },
  ]));
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

module.exports = { attach };
