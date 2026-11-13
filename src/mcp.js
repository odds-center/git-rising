// Git Rising MCP server (stdio). Lets Claude list/open repos, inspect history and run git actions
// through Git Rising. Talks to the running app over its local API; if the app isn't running,
// it starts the same API in-process (headless) so read-only tools still work.
//
// Run:  ELECTRON_RUN_AS_NODE=1 "<Git Rising binary>" <path>/src/mcp.js     (or: node src/mcp.js)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const RUNTIME = path.join(os.homedir(), '.config', 'git-rising', 'runtime.json');
const VERSION = '0.2.10';
let base = null, headless = false;

function appRuntime() {
  try {
    const r = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
    process.kill(r.pid, 0); // throws if not alive
    return r;
  } catch { return null; }
}
async function ping(url) { try { const r = await fetch(url + '/api/ping'); return (await r.json()).gittree === true; } catch { return false; } }
async function ensureBase() {
  const rt = appRuntime();
  if (rt && (await ping(`http://127.0.0.1:${rt.port}`))) return (base = `http://127.0.0.1:${rt.port}`), (headless = false), base;
  if (base && headless) return base;
  const { startServer } = await import('./server.js');
  const { port } = await startServer({});
  headless = true;
  return (base = `http://127.0.0.1:${port}`);
}
async function call(p, params = {}, body) {
  await ensureBase();
  const url = `${base}/api/${p}?${new URLSearchParams(params)}`;
  const r = body !== undefined
    ? await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gittree': '1' }, body: JSON.stringify(body) })
    : await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function launchApp(repo) {
  const exe = process.execPath;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const isElectron = /Git Rising|electron/i.test(exe);
  if (!isElectron) throw new Error('Git Rising 앱이 실행 중이 아니에요. 앱을 먼저 실행해 주세요.');
  spawn(exe, repo ? [repo] : [], { detached: true, stdio: 'ignore', env }).unref();
}
async function waitApp(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rt = appRuntime();
    if (rt && (await ping(`http://127.0.0.1:${rt.port}`))) { base = `http://127.0.0.1:${rt.port}`; headless = false; return true; }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const ACTIONS = ['fetch', 'pull', 'push', 'checkout', 'branch', 'merge', 'ff', 'rebase', 'cherrypick', 'revert', 'reset', 'moveBranch', 'syncUpstream', 'deleteBranch', 'deleteRemoteBranch', 'tag', 'deleteTag', 'stash', 'pop', 'abort', 'cont', 'remoteToSsh'];

const TOOLS = [
  {
    name: 'list_repos',
    description: '내 컴퓨터에서 자동으로 찾은 git 저장소 목록 (최근 작업 순). query 로 이름/경로 필터.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, refresh: { type: 'boolean', description: '홈 폴더를 다시 스캔' }, limit: { type: 'number' } } },
    run: async ({ query, refresh, limit = 50 }) => {
      const r = await call('repos', refresh ? { refresh: 1 } : {});
      const q = (query || '').toLowerCase();
      const list = r.repos.filter((x) => !q || x.name.toLowerCase().includes(q) || x.path.toLowerCase().includes(q)).slice(0, limit);
      return { count: list.length, total: r.repos.length, scanRoots: r.config.scanRoots, repos: list.map((x) => ({ name: x.name, path: x.path, branch: x.branch, worktrees: (x.worktrees || []).map((w) => ({ path: w.path, branch: w.branch })), lastActivity: x.activity ? new Date(x.activity).toISOString() : null })) };
    },
  },
  {
    name: 'open_repo',
    description: 'Git Rising 앱에서 저장소를 새 탭으로 엽니다 (앱이 꺼져 있으면 실행).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: p }) => {
      const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
      await ensureBase();
      if (headless) { launchApp(abs); const ok = await waitApp(); return { opened: abs, launched: true, ready: ok }; }
      const r = await call('ui', {}, { action: 'open', path: abs });
      if (!r.windows) launchApp(abs);
      return { opened: abs };
    },
  },
  {
    name: 'repo_overview',
    description: '저장소 요약: 현재 브랜치, 원격 대비 ahead/behind, 커밋 안 한 변경, 진행 중인 merge/rebase, 스태시, 워크트리, 최근 커밋.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, recent: { type: 'number' } }, required: ['path'] },
    run: async ({ path: repo, recent = 15 }) => {
      const s = await call('snapshot', { repo, limit: recent });
      const cur = s.refs.refs.find((r) => r.type === 'branch' && r.name === s.repo.branch);
      return {
        path: s.repo.path, branch: s.repo.branch, head: s.repo.head, upstream: cur?.upstream || null, track: cur?.track || null,
        inProgress: s.info.op, stashes: s.refs.stashes, remotes: s.info.remotes, worktrees: s.info.worktrees,
        changes: s.status.files, recentCommits: s.log.commits.map((c) => ({ sha: c.sha.slice(0, 10), subject: c.subject, author: c.author, date: new Date(c.time * 1000).toISOString() })),
      };
    },
  },
  {
    name: 'list_branches',
    description: '로컬/원격 브랜치와 태그 목록 (upstream, ahead/behind 포함).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: repo }) => {
      const r = await call('refs', { repo });
      return { refs: r.refs.map((x) => ({ type: x.type, name: x.name, sha: x.sha.slice(0, 10), upstream: x.upstream, track: x.track })) };
    },
  },
  {
    name: 'repo_log',
    description: '커밋 그래프 순서의 로그 (모든 브랜치).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' }, skip: { type: 'number' } }, required: ['path'] },
    run: async ({ path: repo, limit = 50, skip = 0 }) => {
      const r = await call('log', { repo, limit, skip });
      return { hasMore: r.hasMore, commits: r.commits.map((c) => ({ sha: c.sha.slice(0, 10), parents: c.parents.map((p) => p.slice(0, 10)), subject: c.subject, author: c.author, date: new Date(c.time * 1000).toISOString() })) };
    },
  },
  {
    name: 'show_commit',
    description: '커밋 상세(메시지, 변경 파일). select=true 면 앱 화면에서도 그 커밋을 선택해 보여줍니다.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, sha: { type: 'string' }, select: { type: 'boolean' } }, required: ['path', 'sha'] },
    run: async ({ path: repo, sha, select }) => {
      const d = await call('commit', { repo, sha });
      if (select && !headless) await call('ui', {}, { action: 'select', path: repo, sha: d.sha }).catch(() => {});
      return d;
    },
  },
  {
    name: 'search_commits',
    description: '전체 히스토리에서 메시지/작성자/SHA 로 커밋 검색.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } }, required: ['path', 'query'] },
    run: async ({ path: repo, query }) => call('search', { repo, q: query }),
  },
  {
    name: 'git_action',
    description:
      'Git Rising 을 통해 git 작업 실행. action 과 args:\n' +
      '- fetch / pull / push / stash / pop / syncUpstream(현재 브랜치를 원격과 똑같이 reset --hard)\n' +
      '- checkout {ref, kind: branch|remote|commit}\n- branch {name, sha, checkout?}\n- merge|ff|rebase {ref}\n' +
      '- reset {sha(ref 이름도 가능, 예: master), mode: soft|mixed|hard}  ← 예: develop 에서 master 로 reset --hard\n' +
      '- moveBranch {name, sha} (branch -f)\n- cherrypick|revert {sha}\n- deleteBranch {name, force?} / deleteRemoteBranch {ref: origin/x}\n' +
      '- tag {name, sha, message?} / deleteTag {name}\n- abort|cont {op: merge|rebase|cherry-pick|revert}\n- remoteToSsh {remote?}',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, action: { type: 'string', enum: ACTIONS }, args: { type: 'object' } },
      required: ['path', 'action'],
    },
    run: async ({ path: repo, action, args = {} }) => {
      if (!ACTIONS.includes(action)) throw new Error('unknown action');
      const r = await call('action', { repo }, { action, args });
      return { ok: true, output: (r.output || '').trim() };
    },
  },
  {
    name: 'terminal_tools',
    description:
      '터미널(셸) 도우미. action 없이 부르면 현재 상태(oh-my-zsh 업데이트 방식, 입력 예측·문법 강조 플러그인)를 돌려줍니다.\n' +
      '- omzMode {mode: auto|prompt|reminder|disabled}: oh-my-zsh 업데이트를 자동/물어보기/알림/끔 으로\n' +
      '- omzUpdate: oh-my-zsh 와 추가 플러그인·테마를 지금 업데이트\n' +
      '- plugin {name: zsh-autosuggestions|zsh-syntax-highlighting}: 설치하고 .zshrc 에서 켜기\n' +
      '~/.zshrc 를 고치며 처음 고칠 때 ~/.zshrc.git-rising.bak 백업을 남깁니다.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['omzMode', 'omzUpdate', 'plugin', 'psPrediction'] }, mode: { type: 'string' }, name: { type: 'string' } } },
    run: async ({ action, mode, name }) => (action ? call('shelltools', {}, { action, mode, name }) : call('shelltools')),
  },
  {
    name: 'set_scan_roots',
    description: '저장소 자동 찾기 위치(폴더 목록)와 깊이를 바꾸고 다시 스캔합니다.',
    inputSchema: { type: 'object', properties: { roots: { type: 'array', items: { type: 'string' } }, maxDepth: { type: 'number' } }, required: ['roots'] },
    run: async ({ roots, maxDepth }) => {
      const r = await call('config', {}, { scanRoots: roots.map((x) => x.replace(/^~(?=$|[\\/])/, os.homedir())), maxDepth });
      return { found: r.repos.length, scanRoots: r.config.scanRoots };
    },
  },
];

// ---------- minimal MCP JSON-RPC over stdio ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'git-rising', version: VERSION },
        instructions: 'Git Rising(git GUI) 제어용. 저장소 경로를 모르면 list_repos 로 먼저 찾으세요. 되돌리기 어려운 작업(reset hard, 삭제, syncUpstream)은 사용자에게 확인한 뒤 실행하세요.' };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS.map(({ run, ...t }) => t) };
    else if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) throw Object.assign(new Error('unknown tool'), { code: -32602 });
      try {
        const out = await tool.run(params.arguments || {});
        result = { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
      } catch (e) {
        result = { content: [{ type: 'text', text: '실패: ' + e.message }], isError: true };
      }
    } else throw Object.assign(new Error('method not found'), { code: -32601 });
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
  }
});
rl.on('close', () => process.exit(0));
