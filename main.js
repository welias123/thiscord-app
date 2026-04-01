const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let pendingAuthUrl = null;

// ── Single instance lock (required for Windows deep-link handling) ─
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Windows: app already running — another instance was launched with a thiscord:// URL
app.on('second-instance', (event, commandLine) => {
  // In dev mode, commandLine is: [electron.exe, '--', app_path, thiscord://...]
  // In prod mode, commandLine is: [app.exe, thiscord://...]
  const url = commandLine.find(arg => arg.startsWith('thiscord://'));
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (url) mainWindow.webContents.send('auth-callback', url);
  }
});

// macOS: OS asks us to open a URL via our registered protocol
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('auth-callback', url);
  } else {
    pendingAuthUrl = url; // will be sent once window is ready
  }
});

// Register thiscord:// as a custom URI scheme
// In dev mode (npm start), Electron runs as electron.exe so we pass the app path manually
if (process.defaultApp) {
  app.setAsDefaultProtocolClient('thiscord', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('thiscord');
}

// ── Window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.loadFile('src/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Windows: app was launched directly via thiscord:// (not second-instance)
    // In dev mode argv = [electron, '.', thiscord://...], prod = [app.exe, thiscord://...]
    const startupUrl = process.argv.slice(process.defaultApp ? 2 : 1).find(arg => arg.startsWith('thiscord://'));
    const urlToSend = startupUrl || pendingAuthUrl;
    if (urlToSend) {
      mainWindow.webContents.send('auth-callback', urlToSend);
      pendingAuthUrl = null;
    }
  });

  // Auto-updater
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Check on launch, then every hour while the app is open
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', info);
  });
  autoUpdater.on('update-downloaded', (info) => {
    // Install immediately — user sees a 5-second countdown then the app restarts
    mainWindow?.webContents.send('update-downloaded', info);
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => {
    callback(true);
  });

  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0] });
    });
  });
}

app.whenReady().then(() => {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC ───────────────────────────────────────────────────────────
ipcMain.handle('get-capture-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// Open a URL in the system browser
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

ipcMain.on('install-update', () => autoUpdater.quitAndInstall());
