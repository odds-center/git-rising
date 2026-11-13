// gittree server — git plumbing + a tiny HTTP API bound to 127.0.0.1.
// The Electron main process starts it on a random port and points a window at it.

import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'gittree');
const RECENT_FILE = path.join(CONFIG_DIR, 'recent.json');
const MAX_DIFF_BYTES = 3 * 1024 * 1024;

// Host integration (folder picker, terminal, file manager) is injected by the Electron main process.
const host = {
  startRepo: process.cwd(),
  pickFolder: async () => null,
  openTerminal: async () => {},
  reveal: async () => {},
};

// ---------- git helpers ----------
function git(repo, args, { okCodes = [0], maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, '-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args],
      {
        maxBuffer,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        if (okCodes.includes(code)) return resolve(stdout);
        reject(new Error((stderr || err?.message || 'git failed').trim()));
      }
    );
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
  pushRecent(repo);
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
  const limit = Math.min(5000, Math.max(1, parseInt(q.limit) || 1000));
  const order = q.order === 'date' ? '--date-order' : '--topo-order';
  const revs = ['--branches', '--remotes', '--tags'];
  if (await hasHead(repo)) revs.push('HEAD');
  const refCount = (await git(repo, ['for-each-ref', '--count=1', 'refs/heads', 'refs/remotes', 'refs/tags'])).trim();
  if (!refCount && revs.length === 3) return { commits: [], hasMore: false };
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
  const out = await git(repo, ['status', '--porcelain=v1', '-z', '-uall']);
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
    git(repo, ['status', '--porcelain=v1', '-z', '-uall']),
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
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw httpError(400, 'bad mode');
    return git(repo, ['reset', `--${mode}`, await checkRev(repo, sha)]);
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
  fetch: (repo) => git(repo, ['fetch', '--all', '--prune']),
  pull: (repo) => git(repo, ['pull', '--no-edit']),
  async push(repo) {
    const br = await currentBranch(repo);
    if (!br) throw httpError(400, 'HEAD가 detached 상태입니다');
    const up = await git(repo, ['rev-parse', '--abbrev-ref', '@{u}']).then(() => true, () => false);
    return up ? git(repo, ['push']) : git(repo, ['push', '-u', 'origin', br]);
  },
  stash: (repo) => git(repo, ['stash', 'push', '-u']),
  pop: (repo) => git(repo, ['stash', 'pop']),
  async abort(repo, { op }) {
    if (!['merge', 'rebase', 'cherry-pick', 'revert'].includes(op)) throw httpError(400, 'bad op');
    return git(repo, [op, '--abort']);
  },
  async cont(repo, { op }) {
    if (!['rebase', 'cherry-pick', 'revert'].includes(op)) throw httpError(400, 'bad op');
    return git(repo, ['-c', 'core.editor=true', op, '--continue']);
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

const routes = {
  '/api/ping': async () => ({ gittree: true }),
  '/api/default': async () => ({ repo: host.startRepo }),
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
  '/api/action': apiAction,
};

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
    const handler = routes[url.pathname];
    if (handler) {
      const isWrite = url.pathname === '/api/pick' || url.pathname === '/api/action';
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
    fs.readFile(full, (err, buf) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': (MIME[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      resolve({ port, server });
    });
  });
}
