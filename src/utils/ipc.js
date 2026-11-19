// Listening to the main process. The context bridge hands the main process a new copy of a listener on every
// call, so window.ipcRenderer.removeListener(channel, fn) never finds the one that was added: listeners piled
// up (and kept running) each time a page or panel opened. on() returns its own remover; it is kept here, by
// channel and listener, so ipcOff(bridge, channel, fn) removes exactly what ipcOn added.
const removers = new Map(); // channel -> Map(listener -> [remove, ...])

export function ipcOn(bridge, channel, listener) {
  const remove = bridge?.on?.(channel, listener);
  if (typeof remove !== 'function') return () => {};
  let byFn = removers.get(channel);
  if (!byFn) { byFn = new Map(); removers.set(channel, byFn); }
  const list = byFn.get(listener) || [];
  list.push(remove);
  byFn.set(listener, list);
  return () => ipcOff(bridge, channel, listener);
}

export function ipcOff(bridge, channel, listener) {
  const byFn = removers.get(channel);
  const list = byFn?.get(listener);
  if (!list?.length) return;
  list.pop()();
  if (!list.length) byFn.delete(listener);
  if (!byFn.size) removers.delete(channel);
}
