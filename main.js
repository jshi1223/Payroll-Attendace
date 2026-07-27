const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {

const PORT = process.env.PORT || 3001;
let mainWindow;
let isQuitting = false;

function loadEnvFile() {
  try {
    const envPath = app.isPackaged
      ? path.join(process.resourcesPath, '.env')
      : path.join(__dirname, '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      process.env[key] = value;
    }
  } catch (e) {
    console.error('Failed to load .env:', e.message);
  }
}

function waitForServer(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      http.get(url, () => resolve()).on('error', () => {
        if (Date.now() - start > timeout) return reject(new Error('Server start timeout'));
        setTimeout(check, 500);
      });
    }
    check();
  });
}

const LOADING_HTML = `<!DOCTYPE html>
<html>
<head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
    display:flex; justify-content:center; align-items:center;
    height:100vh; background:#0f0f23;
  }
  .card {
    background:#1a1a2e; border-radius:16px; padding:40px 50px;
    text-align:center; box-shadow:0 8px 32px rgba(0,0,0,0.4);
    border:1px solid rgba(255,255,255,0.05);
  }
  .logo { font-size:28px; font-weight:700; color:#e94560; margin-bottom:6px; letter-spacing:1px; }
  .subtitle { font-size:12px; color:#8892b0; margin-bottom:30px; letter-spacing:2px; text-transform:uppercase; }
  .spinner {
    width:40px; height:40px; border:3px solid rgba(233,69,96,0.2);
    border-top:3px solid #e94560; border-radius:50%;
    animation:spin 0.8s linear infinite; margin:0 auto 20px;
  }
  @keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
  .status { color:#8892b0; font-size:13px; }
</style></head>
<body>
  <div class="card">
    <div class="logo">KVSK Payroll</div>
    <div class="subtitle">Attendance & Payroll System</div>
    <div class="spinner"></div>
    <div class="status">Starting application...</div>
  </div>
</body></html>`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'KVSK Payroll System',
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true
  });

  mainWindow.loadURL(`data:text/html,${encodeURIComponent(LOADING_HTML)}`);
  mainWindow.webContents.setZoomFactor(0.75);

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.webContents.send('window-close-requested');
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.on('window-close-response', (event, action) => {
  if (action === 'logout-and-close') {
    isQuitting = true;
    app.quit();
  }
});

ipcMain.on('print-page', (event) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.print({ silent: false, printBackground: true });
  }
});

app.whenReady().then(async () => {
  loadEnvFile();
  require('./server.js');

  createWindow();

  try {
    await waitForServer(`http://localhost:${PORT}`);
  } catch (err) {
    console.error(err.message);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://localhost:${PORT}`);
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.setZoomFactor(0.75);
    });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

} // end single instance lock
