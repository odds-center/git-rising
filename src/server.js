// gittree server — git plumbing + a tiny HTTP API bound to 127.0.0.1.
// The Electron main process starts it on a random port and points a window at it.

import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'git-rising');
const RECENT_FILE = path.join(CONFIG_DIR, 'recent.json');
const MAX_DIFF_BYTES = 3 * 1024 * 1024;

// Host integration (folder picker, terminal, file manager) is injected by the Electron main process.
const host = {
  startRepo: process.cwd(),
  pickFolder: async () => null,
  openTerminal: async () => {},
  reveal: async () => {},
  askpass: null, // { script, port, token } — set by main process
  update: null, // { status(), check(), install() }
  version: '0.0.0',
  openPath: async () => {},
  mcp: null, // { command, json, install() }
  cacheStatic: false,
};

function askpassEnv() {
  const a = host.askpass;
  if (!a) return {};
  return {
    GIT_ASKPASS: a.script,
    SSH_ASKPASS: a.script,
    SSH_ASKPASS_REQUIRE: 'force',
    GR_PORT: String(a.port),
    GR_TOKEN: a.token,
    GR_NODE: process.execPath,
    GR_ASKPASS_JS: a.js,
  };
}

// ---------- global event bus (askpass prompts, update notices) ----------
const busClients = new Set();
export function broadcast(evt) {
  for (const c of busClients) c.write(`data: ${JSON.stringify(evt)}\n\n`);
}
function handleBus(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': ok\n\n');
  busClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); busClients.delete(res); });
  if (host.update) res.write(`data: ${JSON.stringify({ type: 'update', ...host.update.status() })}\n\n`);
}

// askpass: ssh/git call our helper script, which POSTs the prompt here; the UI answers.
const asks = new Map();
const presetAnswers = [];
async function handleAskpass(req, res) {
  if (!host.askpass || req.headers['x-askpass'] !== host.askpass.token) return res.writeHead(403).end();
  const { prompt = '' } = await readBody(req).catch(() => ({}));
  const pre = presetAnswers.findIndex((p) => prompt.includes(p.match));
  if (pre !== -1) {
    const [p] = presetAnswers.splice(pre, 1);
    return res.writeHead(200).end(p.value);
  }
  if (!busClients.size) return res.writeHead(403).end();
  const id = crypto.randomBytes(8).toString('hex');
  const timer = setTimeout(() => finish(null), 5 * 60 * 1000);
  const finish = (value) => {
    clearTimeout(timer);
    asks.delete(id);
    if (value == null) res.writeHead(403).end();
    else res.writeHead(200).end(value);
    broadcast({ type: 'askpass-done', id });
  };
  asks.set(id, { finish, prompt });
  req.on('close', () => asks.has(id) && finish(null));
  broadcast({ type: 'askpass', id, prompt });
}
async function apiAskpassAnswer(_q, body) {
  const a = asks.get(body?.id);
  if (!a) throw httpError(404, '이미 끝난 요청입니다');
  if (body.cancel) return a.finish(null), { ok: true };
  const value = String(body.value ?? '');
  // remember a key passphrase in the macOS keychain so next time is automatic
  const km = a.prompt.match(/passphrase for (?:key )?'?([^':]+)'?/i);
  a.finish(value);
  if (body.save && km && process.platform === 'darwin') {
    presetAnswers.push({ match: km[1], value });
    const r = await runCmd('ssh-add', ['--apple-use-keychain', km[1]]);
    return { ok: true, saved: r.code === 0, output: r.out };
  }
  return { ok: true };
}

// ---------- SSH helpers ----------
async function apiSsh() {
  const dir = path.join(os.homedir(), '.ssh');
  let keys = [];
  try {
    keys = fs.readdirSync(dir).filter((f) => f.endsWith('.pub')).map((f) => {
      const pub = fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\s+/);
      return { name: f.slice(0, -4), path: path.join(dir, f.slice(0, -4)), type: pub[0], comment: pub[2] || '' };
    }).filter((k) => fs.existsSync(k.path));
  } catch {}
  const agent = await runCmd('ssh-add', ['-l'], { timeout: 5000 });
  return { keys, agent: agent.out, platform: process.platform };
}

// ---------- text decoding ----------
// git hands us raw bytes. Most are UTF-8, but old Korean/Japanese/Chinese sources are often
// EUC-KR(CP949) / Shift_JIS / GBK. Decode strictly as UTF-8 first; if that fails, decode line by
// line so a diff can mix a UTF-8 header with legacy-encoded content without turning into mojibake.
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const LEGACY = ['euc-kr', 'shift_jis', 'gbk'].map((e) => { try { return new TextDecoder(e, { fatal: true }); } catch { return null; } }).filter(Boolean);
function decodeLine(buf) {
  try { return UTF8_STRICT.decode(buf); } catch {}
  for (const d of LEGACY) { try { return d.decode(buf); } catch {} }
  return buf.toString('utf8');
}
export function decodeSmart(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return UTF8_STRICT.decode(buf); } catch {}
  const out = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) { out.push(decodeLine(buf.subarray(start, i))); start = i + 1; }
  }
  return out.join('\n');
}
// English git messages (we parse a few) but UTF-8 character handling.
function gitEnv(extra = {}) {
  const env = { ...process.env, ...askpassEnv(), ...extra, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANGUAGE: 'en', LC_MESSAGES: 'C' };
  delete env.LC_ALL;
  if (process.platform !== 'win32') { env.LANG = 'en_US.UTF-8'; env.LC_CTYPE = 'en_US.UTF-8'; }
  return env;
}

// ---------- git helpers ----------
function git(repo, args, { okCodes = [0], maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'i18n.logOutputEncoding=UTF-8', ...args],
      { maxBuffer, encoding: 'buffer', env: gitEnv() },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        if (okCodes.includes(code)) return resolve(decodeSmart(stdout));
        reject(new Error((decodeSmart(stderr) || err?.message || 'git failed').trim()));
      }
    );
  });
}

// Commands that aren't git (ssh, ssh-add). Resolves with combined output; never throws on exit code.
function runCmd(cmd, args, { cwd, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, encoding: 'utf8', env: { ...process.env, ...askpassEnv() } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

const toplevelCache = new Map();
async function resolveRepo(p) {
  if (!p) throw httpError(400, 'repo is required');
  const abs = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  if (toplevelCache.has(abs)) return toplevelCache.get(abs);
  let top;
  try {
    top = (await git(abs, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw httpError(400, `Not a git repository: ${abs}`);
  }
  toplevelCache.set(abs, top);
  return top;
}

async function hasHead(repo) {
  try {
    await git(repo, ['rev-parse', '--verify', '-q', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const SHA_RE = /^[0-9a-f]{4,64}$/i;
function checkSha(s) {
  if (!SHA_RE.test(s || '')) throw httpError(400, 'bad sha');
  return s;
}

// ---------- recent repos ----------
function readRecent() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function pushRecent(repo) {
  const list = [repo, ...readRecent().filter((r) => r !== repo)].slice(0, 15);
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2));
  } catch {}
}

// ---------- API handlers ----------
const FIELD = '\x00';
const RECORD = '\x1e';

async function apiRepo(q) {
  const repo = await resolveRepo(q.repo);
  if (q.open) pushRecent(repo);
  let branch = null;
  try {
    branch = (await git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim() || null;
  } catch {}
  const head = (await hasHead(repo)) ? (await git(repo, ['rev-parse', 'HEAD'])).trim() : null;
  return { path: repo, name: path.basename(repo), branch, head };
}

async function apiLog(q) {
  const repo = await resolveRepo(q.repo);
  const skip = Math.max(0, parseInt(q.skip) || 0);
  const limit = Math.min(10000, Math.max(1, parseInt(q.limit) || 600));
  const order = q.order === 'date' ? '--date-order' : '--topo-order';
  let revs = ['--branches', ...(q.remotes === '0' ? [] : ['--remotes']), '--tags'];
  if (await hasHead(repo)) revs.push('HEAD');
  if (q.refs) {
    const list = String(q.refs).split(',').map((r) => r.trim()).filter(Boolean);
    for (const r of list) await checkRev(repo, r);
    revs = list;
  }
  const refCount = (await git(repo, ['for-each-ref', '--count=1', 'refs/heads', 'refs/remotes', 'refs/tags'])).trim();
  if (!refCount && !q.refs && !revs.includes('HEAD')) return { commits: [], hasMore: false };
  const out = await git(repo, [
    'log',
    ...revs,
    order,
    `--format=${RECORD}%H%x00%P%x00%an%x00%ae%x00%at%x00%s`,
    `--skip=${skip}`,
    `-n${limit + 1}`,
  ]);
  const commits = out
    .split(RECORD)
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, author, email, time, subject] = rec.replace(/\n$/, '').split(FIELD);
      return { sha, parents: parents ? parents.split(' ') : [], author, email, time: Number(time), subject };
    });
  const hasMore = commits.length > limit;
  if (hasMore) commits.pop();
  return { commits, hasMore };
}

async function apiRefs(q) {
  const repo = await resolveRepo(q.repo);
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(objectname)%00%(*objectname)%00%(refname)%00%(upstream:short)%00%(upstream:track)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  const refs = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [obj, peeled, ref, upstream, track] = line.split(FIELD);
    const sha = peeled || obj;
    let type, name;
    if (ref.startsWith('refs/heads/')) (type = 'branch'), (name = ref.slice(11));
    else if (ref.startsWith('refs/remotes/')) {
      type = 'remote';
      name = ref.slice(13);
      if (name.endsWith('/HEAD')) continue;
    } else (type = 'tag'), (name = ref.slice(10));
    refs.push({ type, name, sha, upstream: upstream || null, track: track || null });
  }
  let stashes = 0;
  try {
    stashes = (await git(repo, ['stash', 'list'])).split('\n').filter(Boolean).length;
  } catch {}
  return { refs, stashes };
}

function parseNameStatusZ(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    if (!st) continue;
    const code = st[0];
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++];
      const p = parts[i++];
      files.push({ status: code, path: p, oldPath });
    } else {
      files.push({ status: code, path: parts[i++] });
    }
  }
  return files;
}

function parseNumstatZ(out) {
  const parts = out.split('\0');
  const map = new Map();
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++];
    if (!head) continue;
    const [a, d, p] = head.split('\t');
    let file = p;
    if (p === '') {
      i++; // old path
      file = parts[i++];
    }
    map.set(file, { add: a === '-' ? null : Number(a), del: d === '-' ? null : Number(d) });
  }
  return map;
}

async function apiCommit(q) {
  const repo = await resolveRepo(q.repo);
  const sha = checkSha(q.sha);
  const out = await git(repo, [
    'show',
    '-s',
    '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B',
    sha,
  ]);
  const [full, parents, author, email, atime, committer, cemail, ctime, body] = out.split(FIELD);
  const parentList = parents ? parents.split(' ') : [];
  const base = parentList.length ? [parentList[0], full] : ['--root', full];
  const [ns, nums] = await Promise.all([
    git(repo, ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', ...base]),
    git(repo, ['diff-tree', '-r', '-M', '--no-commit-id', '--numstat', '-z', ...base]),
  ]);
  const stats = parseNumstatZ(nums);
  const files = parseNameStatusZ(ns).map((f) => ({ ...f, ...(stats.get(f.path) || {}) }));
  return {
    sha: full,
    parents: parentList,
    author,
    email,
    time: Number(atime),
    committer,
    committerEmail: cemail,
    committerTime: Number(ctime),
    message: (body || '').replace(/\s+$/, ''),
    files,
  };
}

async function apiStatus(q) {
  const repo = await resolveRepo(q.repo);
  const out = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const ent = parts[i++];
    if (!ent) continue;
    const x = ent[0],
      y = ent[1],
      p = ent.slice(3);
    let oldPath;
    if (x === 'R' || x === 'C') oldPath = parts[i++];
    let status;
    if (x === '?') status = '?';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'U';
    else if (x === 'A') status = 'A';
    else if (x === 'D' || y === 'D') status = 'D';
    else if (x === 'R') status = 'R';
    else status = 'M';
    files.push({ status, path: p, oldPath, staged: x !== ' ' && x !== '?', unstaged: y !== ' ' });
  }
  return { files };
}

async function apiDiff(q) {
  const repo = await resolveRepo(q.repo);
  const file = q.path;
  if (!file) throw httpError(400, 'path is required');
  const paths = q.oldPath ? [q.oldPath, file] : [file];
  let out;
  if (q.sha === 'WIP') {
    if (q.untracked === '1') {
      out = await git(repo, ['diff', '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] });
    } else if (await hasHead(repo)) {
      out = await git(repo, ['diff', '-M', 'HEAD', '--', ...paths]);
    } else {
      out = await git(repo, ['diff', '--cached', '--', ...paths]);
    }
  } else {
    const sha = checkSha(q.sha);
    const parent = q.parent ? checkSha(q.parent) : null;
    const base = parent ? [parent, sha] : ['--root', sha];
    out = await git(repo, ['diff-tree', '-p', '-M', '--no-commit-id', ...base, '--', ...paths]);
  }
  let truncated = false;
  if (out.length > MAX_DIFF_BYTES) {
    out = out.slice(0, MAX_DIFF_BYTES);
    truncated = true;
  }
  return { patch: out, truncated };
}

async function apiFingerprint(q) {
  const repo = await resolveRepo(q.repo);
  const [refs, head, status] = await Promise.all([
    git(repo, ['for-each-ref', '--format=%(objectname) %(refname)']),
    git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [0, 1] }),
    git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']),
  ]);
  let sym = '';
  try {
    sym = await git(repo, ['symbolic-ref', '-q', 'HEAD']);
  } catch {}
  const h = crypto.createHash('sha1');
  h.update(refs + '|' + head + '|' + sym + '|' + status);
  return { fp: h.digest('hex') };
}

async function apiPick() {
  return { path: (await host.pickFolder()) || null };
}


// ---------- repo state (merge/rebase in progress, worktrees, remote url) ----------
async function apiInfo(q) {
  const repo = await resolveRepo(q.repo);
  const gitDir = path.resolve(repo, (await git(repo, ['rev-parse', '--git-dir'])).trim());
  const exists = (f) => fs.existsSync(path.join(gitDir, f));
  let op = null;
  if (exists('rebase-merge') || exists('rebase-apply')) op = 'rebase';
  else if (exists('MERGE_HEAD')) op = 'merge';
  else if (exists('CHERRY_PICK_HEAD')) op = 'cherry-pick';
  else if (exists('REVERT_HEAD')) op = 'revert';
  const wt = await git(repo, ['worktree', 'list', '--porcelain']).catch(() => '');
  const worktrees = [];
  let cur = null;
  for (const line of wt.split('\n')) {
    if (line.startsWith('worktree ')) worktrees.push((cur = { path: line.slice(9) }));
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
  }
  const remotes = {};
  const rv = await git(repo, ['remote', '-v']).catch(() => '');
  for (const line of rv.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (m) remotes[m[1]] = webUrl(m[2]);
  }
  return { op, worktrees, remotes };
}

function webUrl(u) {
  let m = u.match(/^git@([^:]+):(.+?)(\.git)?$/) || u.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = u.match(/^https?:\/\/(?:[^@/]+@)?(.+?)(\.git)?$/);
  return m ? `https://${m[1]}` : null;
}

// ---------- write actions ----------
async function checkBranchName(repo, name) {
  if (!name || name.startsWith('-')) throw httpError(400, 'invalid name');
  try {
    await git(repo, ['check-ref-format', '--branch', name]);
  } catch {
    throw httpError(400, `invalid branch name: ${name}`);
  }
  return name;
}
async function checkTagName(repo, name) {
  if (!name || name.startsWith('-')) throw httpError(400, 'invalid name');
  try {
    await git(repo, ['check-ref-format', `refs/tags/${name}`]);
  } catch {
    throw httpError(400, `invalid tag name: ${name}`);
  }
  return name;
}
async function checkRev(repo, rev) {
  if (!rev || rev.startsWith('-')) throw httpError(400, 'invalid ref');
  try {
    return (await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim();
  } catch {
    throw httpError(400, `unknown ref: ${rev}`);
  }
}
async function isMerge(repo, sha) {
  const p = (await git(repo, ['rev-list', '--parents', '-n1', sha])).trim().split(' ');
  return p.length > 2;
}
async function currentBranch(repo) {
  try {
    return (await git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

// https://…, ssh://…, git@host:owner/repo, or a local path — never something git would read as an option
const checkRemoteUrl = (u) => typeof u === 'string' && u.length < 2000 && !u.startsWith('-') && /^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:|\/|~|[A-Za-z]:[\\/])/.test(u);

async function apiRemotes(q) {
  const repo = await resolveRepo(q.repo);
  const out = await git(repo, ['remote', '-v']).catch(() => '');
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
    if (!m) continue;
    const r = map.get(m[1]) || { name: m[1] };
    r[m[3] === 'fetch' ? 'url' : 'pushUrl'] = m[2];
    r.kind = /^https?:/.test(r.url || m[2]) ? 'https' : /^(git@|ssh:)/.test(r.url || m[2]) ? 'ssh' : 'other';
    r.web = webUrl(r.url || m[2]);
    map.set(m[1], r);
  }
  return { remotes: [...map.values()] };
}

async function apiClone(_q, body) {
  const url = String(body?.url || '').trim();
  if (!checkRemoteUrl(url)) throw httpError(400, '주소가 올바르지 않아요 (https://… 또는 git@…)');
  const parent = path.resolve(String(body?.parent || path.join(os.homedir(), 'Desktop')).replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(parent)) throw httpError(400, `폴더가 없어요: ${parent}`);
  const name = (String(body?.name || '').trim() || url.replace(/[\\/]+$/, '').split(/[\\/:]/).pop().replace(/\.git$/, '')).replace(/[^\w.\-가-힣]/g, '-');
  if (!name || name.startsWith('.')) throw httpError(400, '폴더 이름을 정할 수 없어요');
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw httpError(409, `이미 있는 폴더예요: ${target}`);
  try { await git(parent, ['clone', '--', url, target]); }
  catch (e) { throw httpError(409, e.message); }
  rescan();
  return { path: target };
}

const actions = {
  async checkout(repo, { ref, kind }) {
    if (kind === 'remote') {
      // origin/feat/x -> local feat/x tracking it
      const remote = ref.split('/')[0];
      const local = ref.slice(remote.length + 1);
      await checkBranchName(repo, local);
      const exists = await git(repo, ['show-ref', '--verify', '-q', `refs/heads/${local}`]).then(() => true, () => false);
      if (exists) return git(repo, ['checkout', local]);
      await checkRev(repo, ref);
      return git(repo, ['checkout', '-b', local, '--track', ref]);
    }
    if (kind === 'branch') return git(repo, ['checkout', await checkBranchName(repo, ref)]);
    return git(repo, ['checkout', '--detach', await checkRev(repo, ref)]);
  },
  async merge(repo, { ref }) {
    await checkRev(repo, ref);
    return git(repo, ['merge', '--no-edit', ref]);
  },
  async ff(repo, { ref }) {
    await checkRev(repo, ref);
    return git(repo, ['merge', '--ff-only', ref]);
  },
  async rebase(repo, { ref }) {
    await checkRev(repo, ref);
    return git(repo, ['rebase', ref]);
  },
  async branch(repo, { name, sha, checkout }) {
    await checkBranchName(repo, name);
    const rev = await checkRev(repo, sha);
    return checkout ? git(repo, ['checkout', '-b', name, rev]) : git(repo, ['branch', name, rev]);
  },
  async cherrypick(repo, { sha }) {
    const rev = await checkRev(repo, sha);
    return git(repo, ['cherry-pick', ...((await isMerge(repo, rev)) ? ['-m', '1'] : []), rev]);
  },
  async revert(repo, { sha }) {
    const rev = await checkRev(repo, sha);
    return git(repo, ['revert', '--no-edit', ...((await isMerge(repo, rev)) ? ['-m', '1'] : []), rev]);
  },
  async reset(repo, { sha, mode }) {
    if (!['soft', 'mixed', 'hard', 'keep'].includes(mode)) throw httpError(400, 'bad mode');
    return git(repo, ['reset', `--${mode}`, await checkRev(repo, sha)]);
  },
  async moveBranch(repo, { name, sha }) {
    await checkBranchName(repo, name);
    if (name === (await currentBranch(repo))) throw httpError(400, '현재 브랜치는 리셋으로 옮기세요');
    return git(repo, ['branch', '-f', name, await checkRev(repo, sha)]);
  },
  async syncUpstream(repo) {
    const up = (await git(repo, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')).trim();
    if (!up) throw httpError(400, '현재 브랜치에 연결된 원격 브랜치(upstream)가 없습니다');
    await git(repo, ['fetch', up.split('/')[0]]);
    return git(repo, ['reset', '--hard', up]);
  },
  async sshTest(repo, { host: h }) {
    const target = /^[\w.-]+$/.test(h || '') ? h : 'github.com';
    const r = await runCmd('ssh', ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', `git@${target}`], { timeout: 60000 });
    const ok = /successfully authenticated|welcome to gitlab|logged in as/i.test(r.out);
    if (!ok) throw httpError(409, r.out || 'ssh 연결 실패');
    return r.out;
  },
  async sshAdd(repo, { key }) {
    if (!key || !fs.existsSync(key) || !key.startsWith(path.join(os.homedir(), '.ssh'))) throw httpError(400, 'bad key');
    const args = process.platform === 'darwin' ? ['--apple-use-keychain', key] : [key];
    const r = await runCmd('ssh-add', args, { timeout: 5 * 60 * 1000 });
    if (r.code !== 0) throw httpError(409, r.out || 'ssh-add 실패');
    return r.out;
  },
  async remoteToHttps(repo, { remote = 'origin' }) {
    if (!/^[\w.-]+$/.test(remote)) throw httpError(400, 'bad remote');
    const url = (await git(repo, ['remote', 'get-url', remote])).trim();
    const m = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/) || url.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
    if (!m) throw httpError(400, `이미 https 주소입니다: ${url}`);
    const next = `https://${m[1]}/${m[2]}.git`;
    await git(repo, ['remote', 'set-url', remote, next]);
    return `${url} → ${next}`;
  },
  async remoteAdd(repo, { name, url }) {
    if (!/^[\w.-]+$/.test(name || '') || !checkRemoteUrl(url)) throw httpError(400, '이름 또는 주소가 올바르지 않아요');
    await git(repo, ['remote', 'add', name, url]);
    return `${name} → ${url}`;
  },
  async remoteSetUrl(repo, { name, url }) {
    if (!/^[\w.-]+$/.test(name || '') || !checkRemoteUrl(url)) throw httpError(400, '이름 또는 주소가 올바르지 않아요');
    await git(repo, ['remote', 'set-url', name, url]);
    return `${name} → ${url}`;
  },
  async remoteRemove(repo, { name }) {
    if (!/^[\w.-]+$/.test(name || '')) throw httpError(400, 'bad remote');
    return git(repo, ['remote', 'remove', name]);
  },
  async remoteToSsh(repo, { remote = 'origin' }) {
    if (!/^[\w.-]+$/.test(remote)) throw httpError(400, 'bad remote');
    const url = (await git(repo, ['remote', 'get-url', remote])).trim();
    const m = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (!m) throw httpError(400, `이미 ssh 주소입니다: ${url}`);
    const next = `git@${m[1]}:${m[2]}.git`;
    await git(repo, ['remote', 'set-url', remote, next]);
    return `${url} → ${next}`;
  },
  async deleteBranch(repo, { name, force }) {
    await checkBranchName(repo, name);
    return git(repo, ['branch', force ? '-D' : '-d', name]);
  },
  async deleteRemoteBranch(repo, { ref }) {
    const remote = ref.split('/')[0];
    const name = ref.slice(remote.length + 1);
    await checkBranchName(repo, name);
    if (!/^[\w.-]+$/.test(remote)) throw httpError(400, 'bad remote');
    return git(repo, ['push', remote, '--delete', name]);
  },
  async tag(repo, { name, sha, message }) {
    await checkTagName(repo, name);
    const rev = await checkRev(repo, sha);
    return message ? git(repo, ['tag', '-a', name, '-m', message, rev]) : git(repo, ['tag', name, rev]);
  },
  async deleteTag(repo, { name }) {
    await checkTagName(repo, name);
    return git(repo, ['tag', '-d', name]);
  },
  async fetch(repo, { prune = true } = {}) {
    const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) throw httpError(400, '등록된 원격 저장소가 없어요 (git remote add origin <주소>)');
    const results = await Promise.all(remotes.map(async (r) => {
      try { await git(repo, ['fetch', ...(prune ? ['--prune'] : []), r]); return { r, ok: true }; }
      catch (e) {
        const url = (await git(repo, ['remote', 'get-url', r]).catch(() => '')).trim();
        return { r, ok: false, msg: `[${r}] ${url}\n${e.message}` };
      }
    }));
    const failed = results.filter((x) => !x.ok);
    if (failed.length === remotes.length) throw httpError(409, failed.map((f) => f.msg).join('\n\n'));
    return failed.length ? `⚠ 일부 원격은 가져오지 못했어요 (나머지는 완료)\n\n${failed.map((f) => f.msg).join('\n\n')}` : '';
  },
  pull: (repo, { mode } = {}) => git(repo, ['pull', '--no-edit', ...(mode === 'rebase' ? ['--rebase'] : mode === 'ff-only' ? ['--ff-only'] : mode === 'merge' ? ['--no-rebase'] : [])]),
  async push(repo) {
    const br = await currentBranch(repo);
    if (!br) throw httpError(400, 'HEAD가 detached 상태입니다');
    const up = await git(repo, ['rev-parse', '--abbrev-ref', '@{u}']).then(() => true, () => false);
    return up ? git(repo, ['push']) : git(repo, ['push', '-u', 'origin', br]);
  },
  stash: (repo, { untracked = true, message } = {}) => git(repo, ['stash', 'push', ...(untracked ? ['-u'] : []), ...(message ? ['-m', String(message).slice(0, 200)] : [])]),
  pop: (repo) => git(repo, ['stash', 'pop']),
  async abort(repo, { op }) {
    if (!['merge', 'rebase', 'cherry-pick', 'revert'].includes(op)) throw httpError(400, 'bad op');
    return git(repo, [op, '--abort']);
  },
  async cont(repo, { op }) {
    if (!['rebase', 'cherry-pick', 'revert'].includes(op)) throw httpError(400, 'bad op');
    return git(repo, ['-c', 'core.editor=true', op, '--continue']);
  },
  async showItem(repo, { path: p }) {
    const full = insideRepo(repo, p);
    if (!fs.existsSync(full)) throw httpError(404, '작업 폴더에 이 파일이 없어요');
    await host.showItem?.(full);
    return '';
  },
  async terminal(repo) {
    await host.openTerminal(repo);
    return '';
  },
  async reveal(repo) {
    await host.reveal(repo);
    return '';
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(httpError(400, 'bad json'));
      }
    });
  });
}

async function apiAction(q, body) {
  const repo = await resolveRepo(q.repo);
  const fn = actions[body.action];
  if (!fn) throw httpError(400, 'unknown action');
  try {
    const out = await fn(repo, body.args || {});
    return { ok: true, output: out };
  } catch (e) {
    throw httpError(e.status || 409, e.message);
  }
}



// ---------- raw file contents for previews (images, pdf, video, office docs) ----------
const BLOB_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', avif: 'image/avif', apng: 'image/apng', pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg',
  md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', tsv: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
};
function gitBuf(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out, errOut) =>
      err ? reject(httpError(404, String(errOut || err.message).trim())) : resolve(out));
  });
}
function insideRepo(repo, p) {
  const full = path.resolve(repo, p);
  if (full !== repo && !full.startsWith(repo + path.sep)) throw httpError(400, 'bad path');
  return full;
}
async function readBlob(q) {
  const repo = await resolveRepo(q.repo);
  const file = String(q.path || '');
  if (!file) throw httpError(400, 'path is required');
  if (q.sha === 'WIP') return { buf: await fs.promises.readFile(insideRepo(repo, file)), file };
  const rev = q.sha === 'HEAD' ? 'HEAD' : checkSha(q.sha);
  return { buf: await gitBuf(repo, ['cat-file', 'blob', `${rev}:${file.replace(/\\/g, '/')}`]), file };
}
async function handleBlob(req, res, q) {
  const { buf, file } = await readBlob(q);
  const type = BLOB_MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  if (q.text === '1') { // decoded text (handles EUC-KR etc.) for md / csv previews
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=600' });
    return res.end(decodeSmart(buf));
  }
  const headers = { 'content-type': type, 'cache-control': 'private, max-age=600', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' };
  if (type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) { // video seeking
    const start = range[1] ? +range[1] : 0;
    const end = range[2] ? Math.min(+range[2], buf.length - 1) : buf.length - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 });
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'content-length': buf.length });
  res.end(buf);
}
async function apiOpenFile(q, body) {
  const repo = await resolveRepo(q.repo);
  if (body.sha === 'WIP') return host.openPath(insideRepo(repo, body.path)), { ok: true };
  const { buf } = await readBlob({ repo, sha: body.sha, path: body.path });
  const dir = path.join(os.tmpdir(), 'git-rising-open', String(body.sha).slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, path.basename(body.path));
  fs.writeFileSync(out, buf);
  await host.openPath(out);
  return { ok: true, path: out };
}

// vendored browser libraries for previews / terminal (served from node_modules)
const VENDOR = {
  'docx-preview.js': 'docx-preview/dist/docx-preview.min.js',
  'jszip.js': 'jszip/dist/jszip.min.js',
  'xlsx.js': 'xlsx/dist/xlsx.full.min.js',
  'marked.js': 'marked/lib/marked.umd.js',
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'xterm-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
};
function vendorPath(name) {
  const rel = VENDOR[name];
  if (!rel) return null;
  // package "exports" can block require.resolve of dist files → use node_modules directly
  const direct = path.join(__dirname, '..', 'node_modules', rel);
  if (fs.existsSync(direct)) return direct;
  try { return require.resolve(rel); } catch { return null; }
}

// ---------- embedded terminal (node-pty over WebSocket) ----------
let ptyMod = null, WSS = null;
function loadTerm() {
  if (WSS) return true;
  try {
    // npm sometimes drops the exec bit on node-pty's helper → "posix_spawnp failed"
    if (process.platform === 'darwin') {
      try {
        const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `darwin-${process.arch}`);
        const helper = path.join(dir, 'spawn-helper');
        if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755);
      } catch {}
    }
    ptyMod = require('node-pty');
    const { WebSocketServer } = require('ws');
    WSS = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    return true;
  } catch (e) {
    console.error('terminal unavailable:', e.message);
    return false;
  }
}
function defaultShell() {
  if (process.platform === 'win32') {
    const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find((p) => fs.existsSync(p));
    return { file: pwsh || 'powershell.exe', args: ['-NoLogo'] };
  }
  const sh = process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  return { file: sh, args: ['-l'] };
}
async function handleTermUpgrade(req, socket, head, allowedOrigin) {
  if (req.headers.origin !== allowedOrigin || !loadTerm()) return socket.destroy();
  const url = new URL(req.url, 'http://x');
  let repo;
  try { repo = await resolveRepo(url.searchParams.get('repo')); } catch { return socket.destroy(); }
  WSS.handleUpgrade(req, socket, head, (ws) => {
    let { file, args } = defaultShell();
    const custom = url.searchParams.get('shell');
    if (custom && fs.existsSync(custom)) { file = custom; args = /pwsh|powershell|cmd\.exe/i.test(custom) ? [] : ['-l']; }
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'GitRising', LANG: process.env.LANG || 'en_US.UTF-8' };
    for (const k of ['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GR_PORT', 'GR_TOKEN', 'GR_NODE', 'GR_ASKPASS_JS', 'ELECTRON_RUN_AS_NODE']) delete env[k];
    let p;
    try {
      p = ptyMod.spawn(file, args, { name: 'xterm-256color', cols: +url.searchParams.get('cols') || 100, rows: +url.searchParams.get('rows') || 24, cwd: repo, env });
    } catch (e) { ws.send(`\r\n터미널을 시작할 수 없어요: ${e.message}\r\n`); return ws.close(); }
    // batch output into ~8ms frames: far fewer messages under heavy output
    let buf = '', timer = null;
    p.onData((d) => { buf += d; if (!timer) timer = setTimeout(() => { timer = null; if (ws.readyState === 1) ws.send(buf); buf = ''; }, 8); });
    p.onExit(() => { setTimeout(() => ws.close(), 20); });
    ws.on('message', (m) => {
      const s = m.toString();
      if (s.startsWith('\x00\x01R')) { try { const { cols, rows } = JSON.parse(s.slice(3)); p.resize(Math.max(2, cols), Math.max(1, rows)); } catch {} }
      else p.write(s);
    });
    ws.on('close', () => { try { p.kill(); } catch {} });
  });
}

// ---------- snapshot: everything the UI needs in one round-trip ----------
async function apiSnapshot(q) {
  const repo = await resolveRepo(q.repo);
  const parts = new Set((q.parts || 'repo,refs,info,status,log').split(','));
  const out = {};
  const jobs = [];
  if (parts.has('repo')) jobs.push(apiRepo({ repo, open: q.open }).then((v) => (out.repo = v)));
  if (parts.has('refs')) jobs.push(apiRefs({ repo }).then((v) => (out.refs = v)));
  if (parts.has('info')) jobs.push(apiInfo({ repo }).then((v) => (out.info = v)));
  if (parts.has('status')) jobs.push(apiStatus({ repo }).then((v) => (out.status = v)));
  if (parts.has('log')) jobs.push(apiLog({ repo, limit: q.limit, order: q.order, refs: q.refs, remotes: q.remotes }).then((v) => (out.log = v)));
  await Promise.all(jobs);
  return out;
}

// ---------- file history: commits that touched a path ----------
async function apiFileLog(q) {
  const repo = await resolveRepo(q.repo);
  const file = String(q.path || '');
  if (!file) throw httpError(400, 'path is required');
  const revs = ['--branches', '--remotes', '--tags'];
  if (await hasHead(repo)) revs.push('HEAD');
  const out = await git(repo, ['log', ...revs, '--topo-order', '--format=%H', '-n3000', '--', file]).catch(() => '');
  return { shas: out.split('\n').filter(Boolean) };
}

// ---------- full-history search (message / author / sha) ----------
async function apiSearch(q) {
  const repo = await resolveRepo(q.repo);
  const term = String(q.q || '').trim();
  if (!term) return { shas: [] };
  const revs = ['--branches', '--remotes', '--tags'];
  if (await hasHead(repo)) revs.push('HEAD');
  const base = ['log', ...revs, '--topo-order', '--format=%H', '-n2000', '-i', '--fixed-strings'];
  const [byMsg, byAuthor, bySha] = await Promise.all([
    git(repo, [...base, `--grep=${term}`]).catch(() => ''),
    git(repo, [...base, `--author=${term}`]).catch(() => ''),
    /^[0-9a-f]{4,40}$/i.test(term)
      ? git(repo, ['rev-parse', '--verify', '-q', `${term}^{commit}`]).catch(() => '')
      : Promise.resolve(''),
  ]);
  const seen = new Set();
  const shas = [];
  for (const s of [...bySha.split('\n'), ...byMsg.split('\n'), ...byAuthor.split('\n')]) {
    if (s && !seen.has(s)) seen.add(s), shas.push(s);
  }
  return { shas };
}

// ---------- live updates: fs.watch + Server-Sent Events (replaces polling) ----------
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
async function refsHash(repo) {
  const [refs, head, sym] = await Promise.all([
    git(repo, ['for-each-ref', '--format=%(objectname) %(refname)']),
    git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [0, 1] }),
    git(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] }),
  ]);
  let stash = '';
  try { stash = await git(repo, ['rev-parse', '-q', '--verify', 'refs/stash'], { okCodes: [0, 1] }); } catch {}
  return sha1(refs + head + sym + stash);
}
async function statusHash(repo) {
  return sha1(await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']));
}

const watchers = new Map();
async function createWatcher(repo) {
  const gitDir = path.resolve(repo, (await git(repo, ['rev-parse', '--git-dir'])).trim());
  const commonDir = path.resolve(repo, (await git(repo, ['rev-parse', '--git-common-dir'])).trim());
  const w = { clients: new Set(), handles: [], timer: null, poll: null, want: { refs: false, status: false }, busy: false };
  [w.refs, w.status] = await Promise.all([refsHash(repo), statusHash(repo)]);
  const emit = (data) => { for (const c of w.clients) c.write(`data: ${JSON.stringify(data)}\n\n`); };
  const check = async () => {
    if (w.busy) { w.timer = setTimeout(check, 300); return; }
    w.busy = true;
    const want = w.want;
    w.want = { refs: false, status: false };
    try {
      const ev = {};
      if (want.refs) { const h = await refsHash(repo); if (h !== w.refs) (w.refs = h), (ev.refs = true); }
      if (want.status) {
        const wait = 1000 - (Date.now() - (w.lastStatus || 0));
        if (wait > 0 && !want.refs) { w.want.status = true; w.busy = false; w.timer = setTimeout(check, wait); return; }
        w.lastStatus = Date.now();
        const h = await statusHash(repo);
        if (h !== w.status) (w.status = h), (ev.status = true);
      }
      if (ev.refs || ev.status) emit(ev);
    } catch {}
    w.busy = false;
  };
  const fire = (kind) => {
    w.want[kind] = true;
    clearTimeout(w.timer);
    w.timer = setTimeout(check, 250);
  };
  const onGit = (_ev, f) => {
    f = String(f || '').replace(/\\/g, '/');
    if (f.includes('objects/') || f.endsWith('.lock') || f.startsWith('logs/') || f.includes('/logs/')) return;
    if (f === 'index' || f.endsWith('/index')) return fire('status');
    fire('refs');
    if (f === 'HEAD' || f.endsWith('/HEAD')) fire('status');
  };
  const onTree = (_ev, f) => {
    f = String(f || '').replace(/\\/g, '/');
    if (/(^|\/)(\.git|node_modules)(\/|$)/.test(f)) return;
    fire('status');
  };
  const watch = (dir, cb) => {
    try { w.handles.push(fs.watch(dir, { recursive: true }, cb)); return true; } catch { return false; }
  };
  const ok = watch(gitDir, onGit) & (commonDir === gitDir || watch(commonDir, onGit)) & watch(repo, onTree);
  // Fallback when recursive watching isn't available: slow poll.
  if (!ok) w.poll = setInterval(() => { fire('refs'); fire('status'); }, 4000);
  w.close = () => { clearTimeout(w.timer); clearInterval(w.poll); for (const h of w.handles) try { h.close(); } catch {} };
  return w;
}

async function handleEvents(req, res, q) {
  const repo = await resolveRepo(q.repo);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': ok\n\n');
  let w = watchers.get(repo);
  if (!w) { w = createWatcher(repo); watchers.set(repo, w); }
  w = await w;
  w.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    w.clients.delete(res);
    if (!w.clients.size) { w.close(); watchers.delete(repo); }
  });
}

// ---------- repository discovery ----------
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const REPOS_FILE = path.join(CONFIG_DIR, 'repos.json');
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJSON(f, v) { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch {} }
function getConfig() {
  const c = readJSON(CONFIG_FILE, {});
  return { scanRoots: c.scanRoots?.length ? c.scanRoots : [os.homedir()], maxDepth: c.maxDepth || 5 };
}

// Heavy or permission-sensitive folders that never hold the user's own repos.
const SKIP_DIRS = new Set([
  'node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Photos', 'Public', 'AppData',
  'Program Files', 'Program Files (x86)', 'Windows', 'ProgramData', '$Recycle.Bin', 'System Volume Information',
  'vendor', 'Pods', 'bower_components', 'site-packages', '__pycache__', 'venv', 'env', 'DerivedData', 'Caches',
]);

async function repoEntry(dir, isFile) {
  let gitDir = path.join(dir, '.git');
  let worktree = false, main = null;
  if (isFile) {
    try {
      const m = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1]);
      const wm = gitDir.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
      if (wm) { worktree = true; main = wm[1]; }
      else if (/[\\/]\.git[\\/]modules[\\/]/.test(gitDir)) return null; // submodule checkout, not a repo of its own
    } catch { return null; }
  }
  let branch = null;
  try {
    const head = (await fs.promises.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch { return null; }
  let activity = 0;
  for (const f of ['HEAD', 'index', 'FETCH_HEAD', path.join('logs', 'HEAD')]) {
    try { activity = Math.max(activity, (await fs.promises.stat(path.join(gitDir, f))).mtimeMs); } catch {}
  }
  return { path: dir, name: path.basename(dir), branch, activity, worktree, ...(main ? { main } : {}) };
}

async function scanRepos({ scanRoots, maxDepth }, budgetMs = 20000) {
  const start = Date.now();
  const found = [];
  const queue = scanRoots.map((r) => [path.resolve(r.replace(/^~(?=$|[\\/])/, os.homedir())), 0]);
  let qi = 0;
  const visit = async (dir, depth) => {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    const g = ents.find((e) => e.name === '.git');
    if (g) {
      const e = await repoEntry(dir, g.isFile());
      if (e) found.push(e);
      return; // don't descend into repos (submodules, vendored copies)
    }
    if (depth >= maxDepth) return;
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      queue.push([path.join(dir, e.name), depth + 1]);
    }
  };
  const worker = async () => {
    while (qi < queue.length && Date.now() - start < budgetMs) {
      const [d, dep] = queue[qi++];
      await visit(d, dep);
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  const repos = await foldWorktrees(found);
  return { repos, scannedAt: Date.now(), complete: qi >= queue.length, ms: Date.now() - start };
}

// A worktree is just another checkout of a repo: list the repo once and hang its worktrees off it.
async function foldWorktrees(found) {
  const byPath = new Map(found.filter((r) => !r.worktree).map((r) => [r.path, { ...r, worktrees: [] }]));
  for (const w of found.filter((r) => r.worktree)) {
    let m = byPath.get(w.main);
    if (!m) { // main repo lives outside the scanned folders — still the thing to open
      const e = await repoEntry(w.main, false).catch(() => null);
      if (!e) continue;
      m = { ...e, worktrees: [] };
      byPath.set(w.main, m);
    }
    m.worktrees.push({ path: w.path, name: w.name, branch: w.branch, activity: w.activity });
    m.activity = Math.max(m.activity, w.activity);
  }
  return [...byPath.values()];
}

let scanning = null;
function rescan() {
  if (!scanning) {
    scanning = scanRepos(getConfig())
      .then((r) => { writeJSON(REPOS_FILE, r); return r; })
      .finally(() => (scanning = null));
  }
  return scanning;
}

async function apiRepos(q) {
  const cfg = getConfig();
  let data = readJSON(REPOS_FILE, null);
  if (!data || q.refresh) data = await rescan();
  else {
    // cheap freshness: re-stat cached entries, drop ones that vanished
    const fresh = await Promise.all(data.repos.map(async (r) => {
      const e = await repoEntry(r.path, false).catch(() => null);
      if (!e) return null;
      const wts = (r.worktrees || []).filter((w) => fs.existsSync(path.join(w.path, '.git')));
      for (const w of wts) { try { w.activity = Math.max(w.activity, fs.statSync(path.join(e.path, '.git', 'worktrees', path.basename(w.path), 'HEAD')).mtimeMs); } catch {} }
      return { ...e, worktrees: wts, activity: Math.max(e.activity, ...wts.map((w) => w.activity)) };
    }));
    data = { ...data, repos: fresh.filter(Boolean) };
    if (Date.now() - data.scannedAt > 10 * 60 * 1000) rescan();
  }
  const repos = data.repos.sort((a, b) => b.activity - a.activity);
  return { repos, scannedAt: data.scannedAt, complete: data.complete, ms: data.ms, config: cfg, scanning: !!scanning };
}

async function apiConfig(_q, body) {
  const cur = readJSON(CONFIG_FILE, {});
  if (Array.isArray(body?.scanRoots)) cur.scanRoots = body.scanRoots.map(String).filter(Boolean).slice(0, 20);
  if (body?.maxDepth) cur.maxDepth = Math.min(8, Math.max(1, parseInt(body.maxDepth) || 5));
  writeJSON(CONFIG_FILE, cur);
  return apiRepos({ refresh: 1 });
}

const routes = {
  '/api/ping': async () => ({ gittree: true }),
  '/api/default': async () => ({ repo: host.startRepo, home: os.homedir() }),
  '/api/recent': async () => ({ recent: readRecent() }),
  '/api/repo': apiRepo,
  '/api/log': apiLog,
  '/api/refs': apiRefs,
  '/api/commit': apiCommit,
  '/api/status': apiStatus,
  '/api/diff': apiDiff,
  '/api/fingerprint': apiFingerprint,
  '/api/pick': apiPick,
  '/api/info': apiInfo,
  '/api/snapshot': apiSnapshot,
  '/api/search': apiSearch,
  '/api/filelog': apiFileLog,
  '/api/remotes': apiRemotes,
  // UI state (tabs, preferences, column widths). Kept in a file because the app's origin
  // (127.0.0.1:<random port>) changes every launch, which would orphan localStorage.
  '/api/state': async (_q, body) => {
    const f = path.join(CONFIG_DIR, 'ui-state.json');
    if (body && typeof body === 'object') { writeJSON(f, body); return { ok: true }; }
    return readJSON(f, {});
  },
  '/api/clone': apiClone,
  '/api/repos': apiRepos,
  '/api/config': apiConfig,
  '/api/askpass/answer': apiAskpassAnswer,
  '/api/openfile': apiOpenFile,
  '/api/ui': async (_q, body) => (broadcast({ type: 'ui', ...body }), { ok: true, windows: busClients.size }),
  '/api/mcp': async (_q, body) => {
    if (!host.mcp) throw httpError(404, 'MCP 는 설치된 앱에서만 사용할 수 있어요');
    if (body?.action === 'install') return { output: await host.mcp.install() };
    return { command: host.mcp.command, json: host.mcp.json };
  },
  '/api/ssh': apiSsh,
  '/api/version': async () => ({ version: host.version, platform: process.platform }),
  '/api/update': async (_q, body) => {
    if (!host.update) return { state: 'unsupported' };
    if (body?.action === 'check') await host.update.check(true);
    if (body?.action === 'install') host.update.install();
    return host.update.status();
  },
  '/api/action': apiAction,
};

const staticCache = new Map();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function startServer(hooks = {}) {
  Object.assign(host, hooks);
  let allowedHosts = new Set();
  const server = http.createServer(async (req, res) => {
    // Guard against DNS-rebinding: only answer requests addressed to localhost.
    if (!allowedHosts.has(req.headers.host)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/bus') return handleBus(req, res);
    if (url.pathname === '/api/blob') {
      return handleBlob(req, res, Object.fromEntries(url.searchParams)).catch((e) => {
        if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(e.message);
      });
    }
    if (url.pathname.startsWith('/vendor/')) {
      const vp = vendorPath(url.pathname.slice(8));
      if (!vp) return res.writeHead(404).end();
      return fs.readFile(vp, (err, buf) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': (MIME[path.extname(vp)] || 'text/plain') + '; charset=utf-8', 'cache-control': 'max-age=86400' });
        res.end(buf);
      });
    }
    if (url.pathname === '/api/askpass') return handleAskpass(req, res).catch(() => res.end());
    if (url.pathname === '/api/events') {
      handleEvents(req, res, Object.fromEntries(url.searchParams)).catch((e) => {
        if (!res.headersSent) res.writeHead(400);
        res.end(e.message);
      });
      return;
    }
    const handler = routes[url.pathname];
    if (handler) {
      const WRITE = ['/api/pick', '/api/action', '/api/config', '/api/askpass/answer', '/api/openfile', '/api/ui', '/api/clone'];
      const MIXED = ['/api/update', '/api/mcp', '/api/state']; // GET = read status, POST = do something
      const isWrite = WRITE.includes(url.pathname) || (MIXED.includes(url.pathname) && req.method !== 'GET');
      if (isWrite && (req.method !== 'POST' || req.headers['x-gittree'] !== '1')) {
        // custom header => browsers can't send it cross-origin without a preflight we never approve
        res.writeHead(405).end();
        return;
      }
      try {
        const body = req.method === 'POST' ? await readBody(req) : null;
        const data = await handler(Object.fromEntries(url.searchParams), body);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    const send = (buf) => {
      res.writeHead(200, { 'content-type': (MIME[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(buf);
    };
    if (staticCache.has(full)) return send(staticCache.get(full));
    fs.readFile(full, (err, buf) => {
      if (err) return res.writeHead(404).end('not found');
      if (host.cacheStatic) staticCache.set(full, buf);
      send(buf);
    });
  });
  let origin = '';
  server.on('upgrade', (req, socket, head) => {
    if (!allowedHosts.has(req.headers.host) || !req.url.startsWith('/api/term')) return socket.destroy();
    handleTermUpgrade(req, socket, head, origin).catch(() => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(hooks.port) || 0, '127.0.0.1', () => {
      const { port } = server.address();
      allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      origin = `http://127.0.0.1:${port}`;
      resolve({ port, server, host });
    });
  });
}
