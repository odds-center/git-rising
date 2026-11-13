// Self-updater backed by GitHub Releases (works without code signing).
// macOS: downloads the .zip, swaps the .app bundle in place, relaunches.
// Windows: downloads the NSIS installer and runs it silently, then relaunches.
import { app } from 'electron';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'odds-center/git-rising';
const CHECK_EVERY = 6 * 60 * 60 * 1000;

const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

function assetFor(release) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const want =
    process.platform === 'darwin' ? new RegExp(`-mac-${arch}\\.zip$`) : process.platform === 'win32' ? /-win-x64\.exe$/ : null;
  return want && release.assets.find((a) => want.test(a.name));
}

export function createUpdater(notify) {
  const st = { state: 'idle', current: app.getVersion(), version: null, notes: '', progress: 0, error: null, url: null };
  const status = () => ({ ...st, packaged: app.isPackaged });
  const set = (patch) => { Object.assign(st, patch); notify({ type: 'update', ...status() }); };
  let release = null;

  async function check(manual = false) {
    if (!app.isPackaged && !process.env.GR_UPDATE_DEV) { if (manual) set({ state: 'dev' }); return; }
    if (st.state === 'downloading' || st.state === 'ready') return;
    try {
      set({ state: 'checking', error: null });
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'git-rising-updater' },
      });
      if (r.status === 404) return set({ state: 'latest' });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const rel = await r.json();
      const asset = assetFor(rel);
      if (newer(rel.tag_name, st.current) && asset) {
        release = { rel, asset };
        set({ state: 'available', version: rel.tag_name.replace(/^v/, ''), notes: rel.body || '', url: rel.html_url });
      } else set({ state: 'latest' });
    } catch (e) {
      set({ state: 'error', error: e.message });
    }
  }

  async function download() {
    const { asset } = release;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-rising-update-'));
    const file = path.join(dir, asset.name);
    const r = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'git-rising-updater' } });
    if (!r.ok) throw new Error(`download ${r.status}`);
    const total = Number(r.headers.get('content-length')) || asset.size || 0;
    let got = 0, last = 0;
    const body = Readable.fromWeb(r.body);
    body.on('data', (c) => {
      got += c.length;
      const p = total ? Math.round((got / total) * 100) : 0;
      if (p !== last) (last = p), set({ progress: p });
    });
    await pipeline(body, fs.createWriteStream(file));
    return { dir, file };
  }

  async function install() {
    if (!release || st.state === 'downloading') return;
    try {
      set({ state: 'downloading', progress: 0 });
      const { dir, file } = await download();
      if (process.platform === 'darwin') {
        const out = path.join(dir, 'x');
        await /** @type {Promise<void>} */ (new Promise((res, rej) => execFile('ditto', ['-x', '-k', file, out], (e) => (e ? rej(e) : res()))));
        const newApp = fs.readdirSync(out).find((f) => f.endsWith('.app'));
        if (!newApp) throw new Error('zip 안에 .app 이 없습니다');
        const appPath = path.resolve(process.execPath, '..', '..', '..'); // …/Git Rising.app
        const script = `
          while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
          rm -rf "${appPath}.old"; mv "${appPath}" "${appPath}.old" && mv "${path.join(out, newApp)}" "${appPath}" && rm -rf "${appPath}.old"
          xattr -dr com.apple.quarantine "${appPath}" 2>/dev/null
          open "${appPath}"
          rm -rf "${dir}"`;
        spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'win32') {
        spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      }
      set({ state: 'ready' });
      setTimeout(() => app.quit(), 300);
    } catch (e) {
      set({ state: 'error', error: e.message });
    }
  }

  setTimeout(() => check(), 8000);
  setInterval(() => check(), CHECK_EVERY);
  return { status, check, install };
}
