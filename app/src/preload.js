const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autopane', {
  run: (task, startUrl) => ipcRenderer.invoke('run', { task, startUrl }),
  stop: () => ipcRenderer.invoke('stop'),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
});
