const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onCloseRequest: (callback) => ipcRenderer.on('window-close-requested', callback),
  closeResponse: (action) => ipcRenderer.send('window-close-response', action),
  printPage: () => ipcRenderer.send('print-page'),
  isElectron: true
});
