const { app, BrowserWindow, ipcMain, clipboard, dialog, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { startServer } = require('../server/index.cjs');

                                                                            
                                                          
app.setPath('userData', path.join(app.getPath('appData'), 'Pokemon Stadium 2D'));
app.setName('Empress: Pokémon 2D');
app.setAppUserModelId('local.pokemon.stadium2d');
let mainWindow;
let gameServer;
let shuttingDown = false;
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Empress: Pokémon 2D', `The game could not start.\n\n${error.message}`);
    app.quit();
  });
}

function addresses(port) {
  const found = new Set();
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
        found.add(`http://${entry.address}:${port}`);
      }
    }
  }
  return [...found];
}

function authorized(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw Error('Unknown window');
  const origin = new URL(event.senderFrame.url).origin;
  if (origin !== `http://127.0.0.1:${gameServer.port}`) throw Error('Untrusted frame');
}

async function start() {
  const rootDir = path.resolve(__dirname, '..');
  const saveDir = path.join(app.getPath('userData'), 'profile');
  fs.mkdirSync(saveDir, { recursive: true });
  try {
    gameServer = await startServer({ port: 3210, host: '0.0.0.0', rootDir, saveDir });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    gameServer = await startServer({ port: 0, host: '0.0.0.0', rootDir, saveDir });
  }

  ipcMain.handle('stadium:info', event => {
    authorized(event);
    return { port: gameServer.port, addresses: addresses(gameServer.port), version: app.getVersion(), platform: process.platform };
  });
  ipcMain.handle('stadium:copy', (event, text) => {
    authorized(event);
    if (typeof text !== 'string' || text.length > 4096) throw Error('Invalid invite');
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('stadium:fullscreen', (event, value) => {
    authorized(event);
    mainWindow.setFullScreen(Boolean(value));
    return mainWindow.isFullScreen();
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1024, minHeight: 720,
    backgroundColor: '#0b1021', title: `Empress: Pokémon 2D · v${app.getVersion()}`,
    icon: path.join(rootDir, 'desktop', 'icon.png'),
    autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false, spellcheck: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.on('page-title-updated', event => {
    event.preventDefault();
    mainWindow.setTitle(`Empress: Pokémon 2D · v${app.getVersion()}`);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== `http://127.0.0.1:${gameServer.port}`) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(`http://127.0.0.1:${gameServer.port}`);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!gameServer || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve(gameServer.close()).catch(() => {}).finally(() => app.quit());
  setTimeout(() => app.exit(0), 2000).unref();
});
