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
  selectImportFile: () => ipcRenderer.invoke('select-import-file'),
  onDBProgress: (callback) => {
    ipcRenderer.removeAllListeners('db-progress');
    ipcRenderer.on('db-progress', (event, data) => callback(data));
  },
  checkUpdate: (updateUrl) => ipcRenderer.invoke('check-update', { updateUrl }),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  startDownloadUpdate: (downloadUrl) => ipcRenderer.invoke('start-download-update', { downloadUrl }),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onDownloadProgress: (callback) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (event, data) => callback(data));
  },
});
