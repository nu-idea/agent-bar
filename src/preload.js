// The only bridge between the windows and the main process. Windows get data and can ask
// to move the pill, toggle the panel, read/write settings or quit — nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentBar', {
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),

  getSummary: () => ipcRenderer.invoke('get-summary'),
  onSummary: (cb) => ipcRenderer.on('summary', (_e, s) => cb(s)),
  pillMove: (dx, dy) => ipcRenderer.send('pill-move', { dx, dy }),
  pillMoved: () => ipcRenderer.send('pill-moved'),
  pillClick: () => ipcRenderer.send('pill-click'),
  quit: () => ipcRenderer.send('quit'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  onLang: (cb) => ipcRenderer.on('lang', (_e, lang) => cb(lang)),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  listSounds: () => ipcRenderer.invoke('list-sounds'),
  playSound: (value, volume) => ipcRenderer.invoke('play-sound', value, volume),
  toggleMute: (id) => ipcRenderer.invoke('toggle-mute', id),
  hideSession: (id) => ipcRenderer.invoke('hide-session', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  openSession: (id) => ipcRenderer.invoke('open-session', id),
});
