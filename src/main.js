// Electron main process: starts the local git API server and opens the window.
import { app, BrowserWindow, dialog, shell, Menu } from 'electron';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, broadcast } from './server.js';
import { createUpdater } from './updater.js';

// GUI apps launched from Finder don't inherit the shell PATH; make sure git/ssh are found.
if (process.platform === 'darwin') {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...extra])].filter(Boolean).join(':');
}

// Apps started from Finder/Dock don't see what ~/.zshrc sets up (PATH, SSH_AUTH_SOCK from 1Password/gpg-agent,
// GIT_SSH_COMMAND …), so git behaves differently than in the terminal. Read the login shell's env once.
function importShellEnv() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || '/bin/zsh';
  execFile(shell, ['-ilc', 'printf "\\n__GR_ENV__\\n"; env'], { timeout: 8000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
    const i = (stdout || '').indexOf('__GR_ENV__');
    if (i === -1) return;
    const skip = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TERM_PROGRAM', 'ELECTRON_RUN_AS_NODE']);
    for (const line of stdout.slice(i + 11).split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !skip.has(m[1])) process.env[m[1]] = m[2];
    }
  });
}
importShellEnv();

// First existing path argument is a repo to open.
function repoFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  const p = args.find((a) => fs.existsSync(a));
  return p ? path.resolve(p) : null;
}

// ssh / git call this helper for passwords & passphrases; it forwards the prompt to the UI.
function writeAskpass(port, token) {
  const dir = path.join(app.getPath('userData'), 'askpass');
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'askpass.cjs');
  fs.writeFileSync(
    js,
    `const http = require('http');
const prompt = process.argv.slice(2).join(' ');
const req = http.request({ host: '127.0.0.1', port: +process.env.GR_PORT, path: '/api/askpass', method: 'POST',
  headers: { 'x-askpass': process.env.GR_TOKEN, 'content-type': 'application/json' } }, (res) => {
  let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c));
  res.on('end', () => { if (res.statusCode !== 200) process.exit(1); process.stdout.write(b + '\\n'); });
});
req.on('error', () => process.exit(1));
req.end(JSON.stringify({ prompt }));
`
  );
  let script;
  if (process.platform === 'win32') {
    script = path.join(dir, 'askpass.cmd');
    fs.writeFileSync(script, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%GR_NODE%" "%GR_ASKPASS_JS%" %*\r\n');
  } else {
    script = path.join(dir, 'askpass.sh');
    fs.writeFileSync(script, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$GR_NODE" "$GR_ASKPASS_JS" "$@"\n');
    fs.chmodSync(script, 0o755);
  }
  return { script, js, port, token };
}

// Where MCP clients (Claude) find the running app.
const RUNTIME = path.join(os.homedir(), '.config', 'git-rising', 'runtime.json');
function writeRuntime(port) {
  try { fs.mkdirSync(path.dirname(RUNTIME), { recursive: true }); fs.writeFileSync(RUNTIME, JSON.stringify({ port, pid: process.pid, version: app.getVersion() })); } catch {}
}

// How to register the MCP server with Claude Code.
function mcpInfo() {
  const exe = process.execPath;
  const script = path.join(app.getAppPath(), 'src', 'mcp.js');
  const q = (s) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);
  const command = `claude mcp add --scope user git-rising -e ELECTRON_RUN_AS_NODE=1 -- ${q(exe)} ${q(script)}`;
  const json = { mcpServers: { 'git-rising': { command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
  const install = () => new Promise((resolve, reject) => {
    // run through the login shell so the user's PATH (where `claude` lives) is available
    const shellCmd = `claude mcp remove --scope user git-rising >/dev/null 2>&1; ${command}`;
    const [file, args] = process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', `claude mcp remove --scope user git-rising & ${command}`]]
      : [process.env.SHELL || '/bin/zsh', ['-lc', shellCmd]];
    execFile(file, args, { timeout: 30000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err && !/added|already/i.test(out)) reject(new Error(out || err.message + '\n(claude CLI 가 설치돼 있는지 확인하세요)'));
      else resolve(out || '등록 완료 — Claude Code 를 다시 시작하면 git-rising 도구가 보여요');
    });
  });
  return { command, json, install };
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
      const wt = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' });
      wt.on('error', () => spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`], { detached: true, stdio: 'ignore' }).unref());
      wt.unref();
    } else {
      spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    }
  };

  const createWindow = (repo) => {
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 860,
      minHeight: 480,
      show: false,
      backgroundColor: '#0e1013',
      title: 'Git Rising',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 14, y: 16 },
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, plugins: true, preload: path.join(app.getAppPath(), 'src', 'preload.cjs') },
    });
    win.once('ready-to-show', () => win.show());
    win.loadURL(baseUrl + (repo ? `/?repo=${encodeURIComponent(repo)}` : '/'));
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
    const token = crypto.randomBytes(24).toString('hex');
    const hooks = {
      startRepo: repoFromArgv(process.argv),
      version: app.getVersion(),
      cacheStatic: app.isPackaged,
      pickFolder: async () => {
        const r = await dialog.showOpenDialog(win, { title: 'Git 저장소 폴더 선택', properties: ['openDirectory'] });
        return r.canceled ? null : r.filePaths[0];
      },
      openTerminal,
      reveal: async (dir) => { await shell.openPath(dir); },
      openPath: async (p) => { const err = await shell.openPath(p); if (err) throw new Error(err); },
      showItem: async (p) => shell.showItemInFolder(p),
    };
    const { port, host } = await startServer(hooks);
    // attach to the server's live host object (it copies `hooks` at start)
    host.askpass = writeAskpass(port, token);
    host.update = createUpdater(broadcast);
    host.mcp = mcpInfo();
    baseUrl = `http://127.0.0.1:${port}`;
    writeRuntime(port);

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
    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { try { fs.unlinkSync(RUNTIME); } catch {} });
}
