const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 3001;
let serverProcess;
let mainWindow;
let isQuitting = false;

function waitForServer(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      http.get(url, () => resolve()).on('error', () => {
        if (Date.now() - start > timeout) return reject(new Error('Server start timeout'));
        setTimeout(check, 300);
      });
    }
    check();
  });
}

function startServer() {
  serverProcess = spawn('node', [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env }
  });
  serverProcess.on('error', (err) => {
    console.error('Server failed to start:', err);
  });
  serverProcess.on('exit', (code) => {
    if (code && code !== 0) console.error('Server exited with code', code);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'KVSK Payroll System',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.webContents.setZoomFactor(0.75);

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.webContents.send('window-close-requested');
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('ready-to-show', () => { mainWindow.show(); });
}

ipcMain.on('window-close-response', (event, action) => {
  if (action === 'logout-and-close') {
    isQuitting = true;
    if (serverProcess) serverProcess.kill();
    app.quit();
  }
  /* action === 'stay' → just close the modal, keep app open */
});

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer(`http://localhost:${PORT}`);
  } catch (err) {
    console.error(err.message);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
