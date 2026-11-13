// Electron main process: starts the local git API server and opens the window.
import { app, BrowserWindow, dialog, shell, Menu } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './server.js';

// GUI apps launched from Finder don't inherit the shell PATH; make sure git is found.
if (process.platform === 'darwin') {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...extra])].filter(Boolean).join(':');
}

// First non-flag CLI argument (after the app/script path) is a repo to open.
function repoFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  const p = args.find((a) => fs.existsSync(a));
  return p ? path.resolve(p) : null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let baseUrl = null;

  const openTerminal = async (dir) => {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      // Prefer Windows Terminal, fall back to cmd.
      const wt = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' });
      wt.on('error', () => spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`], { detached: true, stdio: 'ignore', shell: false }).unref());
      wt.unref();
    } else {
      spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    }
  };

  const createWindow = (repo) => {
    win = new BrowserWindow({
      width: 1500,
      height: 950,
      minWidth: 900,
      minHeight: 500,
      backgroundColor: '#1b1d23',
      title: 'gittree',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadURL(baseUrl + (repo ? `/?repo=${encodeURIComponent(repo)}` : '/'));
    // Links (e.g. copied remote URLs) never navigate the app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(baseUrl)) e.preventDefault();
    });
    win.on('closed', () => (win = null));
  };

  app.on('second-instance', (_e, argv) => {
    const repo = repoFromArgv(argv);
    if (!win) return createWindow(repo);
    if (win.isMinimized()) win.restore();
    win.focus();
    if (repo) win.webContents.executeJavaScript(`window.gittreeOpen && window.gittreeOpen(${JSON.stringify(repo)})`);
  });

  app.whenReady().then(async () => {
    const { port } = await startServer({
      startRepo: repoFromArgv(process.argv) || app.getPath('home'),
      pickFolder: async () => {
        const r = await dialog.showOpenDialog(win, { title: 'Git 저장소 폴더 선택', properties: ['openDirectory'] });
        return r.canceled ? null : r.filePaths[0];
      },
      openTerminal,
      reveal: async (dir) => {
        await shell.openPath(dir);
      },
    });
    baseUrl = `http://127.0.0.1:${port}`;

    const isMac = process.platform === 'darwin';
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(isMac ? [{ role: 'appMenu' }] : []),
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
        },
        { role: 'windowMenu' },
      ])
    );

    createWindow(repoFromArgv(process.argv));
    app.on('activate', () => {
      if (!win) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
