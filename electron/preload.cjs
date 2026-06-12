const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  sendDBRequest: (action, payload) => ipcRenderer.invoke('db-request', { action, payload }),
  selectDatabaseFile: (action) => ipcRenderer.invoke('select-database-file', { action }),
  onDBProgress: (callback) => {
    ipcRenderer.removeAllListeners('db-progress');
    ipcRenderer.on('db-progress', (event, data) => callback(data));
  },
});
