const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getCaptureSources:  ()        => ipcRenderer.invoke('get-capture-sources'),
  openExternal:       (url)     => ipcRenderer.invoke('open-external', url),
  onAuthCallback:     (cb)      => ipcRenderer.on('auth-callback', (_, url) => cb(url)),
  minimize:           ()        => ipcRenderer.send('win-minimize'),
  maximize:           ()        => ipcRenderer.send('win-maximize'),
  close:              ()        => ipcRenderer.send('win-close'),
  platform: process.platform,
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, info) => cb(info)),
  installUpdate:      ()   => ipcRenderer.send('install-update'),
});
