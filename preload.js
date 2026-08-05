const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onCloseRequest: (callback) => ipcRenderer.on('window-close-requested', callback),
  closeResponse: (action) => ipcRenderer.send('window-close-response', action),
  printPage: () => ipcRenderer.send('print-page'),
  printHTML: (html) => ipcRenderer.send('print-html', html),
  isElectron: true
});
