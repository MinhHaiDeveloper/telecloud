// The app's own window, as opposed to the floating lyrics window: the one that plays, gets events and
// comes back to the front. Set when it is created.
const { BrowserWindow } = require('electron');

let main = null;
const set = (win) => { main = win; };
const get = () => (main && !main.isDestroyed() ? main : BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.tcFloating) || null);

module.exports = { set, get };
