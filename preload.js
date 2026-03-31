const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getCaptureSources:  ()        => ipcRenderer.invoke('get-capture-sources'),
  openExternal:       (url)     => ipcRenderer.invoke('open-external', url),
  onAuthCallback:     (cb)      => ipcRenderer.on('auth-callback', (_, url) => cb(url)),
  minimize:           ()        => ipcRenderer.send('win-minimize'),
  maximize:           ()        => ipcRenderer.send('win-maximize'),
  close:              ()        => ipcRenderer.send('win-close'),
  platform: process.platform,
});
