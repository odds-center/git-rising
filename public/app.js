'use strict';
/* Git Rising — renderer. Vanilla JS, no framework.
 * Perf notes: rows are a recycled DOM pool, the graph is one viewport-sized canvas,
 * layout is computed incrementally, live updates arrive over SSE (no polling),
 * commit details / diffs are cached, and everything pauses while the window is hidden. */

// ================================================================ utils
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Persistent UI state. Stored by the app in a file (not localStorage): the page origin is
// 127.0.0.1:<random port>, so localStorage would be empty on every launch.
const STATE = (() => {
  try { const x = new XMLHttpRequest(); x.open('GET', '/api/state', false); x.send(); return JSON.parse(x.responseText) || {}; } catch { return {}; }
})();
let stateTimer = null;
const flushState = () => { clearTimeout(stateTimer); stateTimer = null; fetch('/api/state', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-gittree': '1' }, body: JSON.stringify(STATE) }).catch(() => {}); };
const LS = {
  get(k, d) { return k in STATE ? STATE[k] : d; },
  set(k, v) { STATE[k] = v; if (!stateTimer) stateTimer = setTimeout(flushState, 250); },
};
addEventListener('pagehide', () => stateTimer && flushState());
const nfc = (s) => String(s ?? '').normalize('NFC'); // macOS file names arrive decomposed (ㅎㅏㄴ) → compose for display
const escN = (s) => esc(nfc(s));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
let ROW = 24, LANE = 14, PAD = 10, NODE_R = 4;

// ---------------------------------------------------------------- preferences (설정)
const PREF_DEF = {
  theme: LS.get('theme', 'dark'), accent: 'indigo', fontSize: 13, density: 'normal', dateMode: 'relative',
  avatars: true, avatarPhotos: true, gravatar: false, repoLogos: true, diffMode: 'unified', showRemotes: true, showTags: true, order: 'topo', colAuthor: true, colDate: true, colSha: true,
  autoFetch: LS.get('autoFetch', false) ? 5 : 0, pullMode: 'default', stashUntracked: true, confirmPush: false, fetchPrune: true,
  worktreeGuard: true, aiUsage: false, termShell: '', termFont: 12, restoreTabs: true, openDiffOnSelect: false,
};
const P = Object.assign({}, PREF_DEF, LS.get('prefs', {}));
// one-time: profile photos / avatars became the default in 0.2.1
if (!LS.get('m021')) { P.avatars = true; P.avatarPhotos = true; LS.set('prefs', P); LS.set('m021', 1); }
const ACCENTS = { indigo: ['#7c8aff', '#5463ff'], blue: ['#4c9aff', '#1f6feb'], violet: ['#a77bff', '#7c4dff'], green: ['#3fcf8e', '#14a06a'], orange: ['#ff9a4c', '#e2700c'], pink: ['#f06bb3', '#d63384'], teal: ['#2fc6c6', '#0e9a9a'] };
const DENSITY = { compact: 21, normal: 24, comfy: 28 };
const COL_DEF = { ref: 160, graph: 0, author: 110, date: 84, sha: 72 }; // graph 0 = auto
const COL_MIN = { ref: 60, graph: 28, author: 48, date: 48, sha: 40 };
const CW = Object.assign({}, COL_DEF, LS.get('cols', {}));
const COLORS = ['#6b8cff', '#b07aff', '#ef62b0', '#ff7b5c', '#f2b740', '#3ec486', '#2db7cc', '#9183ff', '#e8577a', '#62aef7'];
const laneColor = (i) => COLORS[i % COLORS.length];
const home = () => S.homeDir || '';
const tilde = (p) => (home() && p.startsWith(home()) ? '~' + p.slice(home().length) : p);

const ICONS = {
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  down: '<path d="M12 4v12"/><path d="m6 11 6 6 6-6"/><path d="M5 21h14"/>',
  up: '<path d="m18 9-6-6-6 6"/><path d="M12 3v13"/><path d="M5 21h14"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  unarchive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M20 8v11a2 2 0 0 1-2 2h-2"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'chev-down': '<path d="m6 9 6 6 6-6"/>',
  'chev-up': '<path d="m18 15-6-6-6 6"/>',
  'chev-right': '<path d="m9 18 6-6-6-6"/>',
  chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
  laptop: '<rect width="18" height="12" x="3" y="4" rx="2"/><path d="M2 20h20"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  commit: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-2.93 1.41-1.41M17.66 6.34l1.41-1.41M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  ff: '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  rebase: '<circle cx="5" cy="6" r="3"/><path d="M5 9v12"/><circle cx="19" cy="18" r="3"/><path d="m15 9-3-3 3-3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/>',
  checkout: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
  'cloud-down': '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.39 15.4A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  move: '<path d="M18 8l4 4-4 4"/><path d="M2 12h20"/>',
  cherry: '<path d="M2 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"/><path d="M12 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"/><path d="M7 14c3.22-2.91 4.29-8.75 5-12 1.66 2.38 4.94 9 5 12"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'branch-plus': '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M15 6a9 9 0 0 0-9 9"/><path d="M18 15v6"/><path d="M21 18h-6"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  graph: '<circle cx="5" cy="6" r="3"/><path d="M5 9v6"/><circle cx="5" cy="18" r="3"/><path d="M12 3v18"/><circle cx="19" cy="6" r="3"/><path d="M16 15.7A9 9 0 0 0 19 9"/>',
  'file-code': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>',
  'file-image': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="12" r="2"/><path d="m20 17-1.3-1.3a2.4 2.4 0 0 0-3.4 0L9 22"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  'file-sheet': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2M14 13h2M8 17h2M14 17h2"/>',
  'file-video': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 11 5 3-5 3v-6Z"/>',
  'file-audio': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="17" r="2"/><path d="M12 17v-6l3 1"/>',
  'file-archive': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 7V6M10 12v-1M10 18v-2"/>',
  'file-json': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;
function hydrateIcons(root = document) { root.querySelectorAll('i[data-i]').forEach((el) => { el.outerHTML = icon(el.dataset.i); }); }

async function api(p, params = {}) {
  const r = await fetch(`/api/${p}?${new URLSearchParams(params)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function post(p, params, body) {
  const r = await fetch(`/api/${p}?${new URLSearchParams(params || {})}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gittree': '1' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg, kind = '', actions = []) {
  msg = String(msg ?? '');
  const box = $('#toasts');
  for (const old of box.children) if (old.dataset.msg === msg) old.remove();
  const nl = msg.indexOf('\n');
  const title = (nl === -1 ? msg : msg.slice(0, nl)).trim();
  const body = nl === -1 ? '' : msg.slice(nl + 1).trim();
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || 'info');
  t.dataset.msg = msg;
  t.innerHTML = `<span class="t-ic">${icon(kind === 'ok' ? 'check-circle' : kind === 'err' ? 'alert' : 'info')}</span><span class="t-title"></span>
    ${actions.map((a, i) => `<button class="t-btn${a.primary ? ' primary' : ''}" data-a="${i}">${esc(a.label)}</button>`).join('')}
    <button class="t-x" title="닫기">${icon('x')}</button>
    ${body ? `<button class="t-body" title="눌러서 펼치기 / 접기"><span></span>${icon('chev-down')}</button>` : ''}`;
  t.querySelector('.t-title').textContent = title;
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 170); };
  let timer = null;
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(close, ms); };
  const hold = () => { clearTimeout(timer); timer = null; };
  if (body) {
    const b = t.querySelector('.t-body');
    b.firstElementChild.textContent = body;
    b.onclick = () => { t.classList.toggle('open'); hold(); };
  }
  t.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => { close(); actions[+b.dataset.a].run(); }));
  t.querySelector('.t-x').onclick = close;
  t.onmouseenter = hold;
  t.onmouseleave = () => { if (!t.classList.contains('open')) arm(1800); };
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  arm(kind === 'err' ? 9000 : actions.length ? 7000 : body ? 4500 : 2400);
}
const p2 = (n) => String(n).padStart(2, '0');
function fmtDate(sec) { const d = new Date(sec * 1000); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function relDate(sec) {
  const s = Date.now() / 1000 - sec;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return fmtDate(sec).slice(0, 10);
}
function initials(name) {
  name = (name || '?').trim();
  if (/[^\x00-\x7f]/.test(name[0])) return name.replace(/\s/g, '').slice(0, 2);
  const w = name.split(/[\s._-]+/).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase();
}
function hue(str) { let h = 0; for (const c of str || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
const avColor = (email) => `hsl(${hue(email)} 42% 45%)`;
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('복사됨  ' + text, 'ok'); } catch { toast('복사 실패', 'err'); } }

// ================================================================ state
const S = {
  tabs: LS.get('tabs', []), repo: null, info: null,
  meta: { op: null, worktrees: [], remotes: {} },
  commits: [], hasMore: false, index: new Map(), off: 0, L: null,
  refs: [], refsBySha: new Map(), labelCache: new Map(), stashes: 0, status: [],
  selected: null, detail: null, detailFiles: [],
  find: '', findShas: [], findSet: new Set(), findPos: -1,
  ver: 0, collapsed: new Set(LS.get('collapsed', ['sec:tags'])), fileView: LS.get('fileView', 'path'),
  cache: new Map(), es: null, live: false, repos: null, version: '', platform: '',
};

// ================================================================ author photos / repo logos
const AV = new Map(); // email → { img, ok }
function avatarImg(c) {
  if (!P.avatarPhotos || !c.email || !S.repo) return null;
  let e = AV.get(c.email);
  if (!e) {
    e = { img: new Image(), ok: false };
    AV.set(c.email, e);
    e.img.onload = () => { e.ok = true; renderRows(); };
    e.img.src = avatarURL(c.email, c.sha, c.author);
  }
  return e.ok ? e.img : null;
}
const avatarURL = (email, sha, name = '') => `/api/avatar?${new URLSearchParams({ repo: S.repo, email, sha, name, ...(P.gravatar ? { gravatar: '1' } : {}) })}`;
// letter tile that is covered by the logo image once (if) it loads
const logoHTML = (repoPath, cls = 'repo-ic') => {
  const name = repoPath.split(/[\\/]/).pop() || '?';
  return `<span class="${cls}" style="--h:${hue(name)}">${esc(nfc(name)[0].toUpperCase())}${P.repoLogos ? `<img loading="lazy" src="/api/repoicon?repo=${encodeURIComponent(repoPath)}" onload="this.parentNode.classList.add('has-img')" onerror="this.remove()">` : ''}</span>`;
};

// ================================================================ incremental graph layout
class Layout {
  constructor() { this.lanes = []; this.srcs = []; this.rows = []; this.maxLanes = 1; }
  free() { const i = this.lanes.findIndex((l) => l == null); return i === -1 ? this.lanes.length : i; }
  push(list) {
    const { lanes, srcs, rows } = this;
    for (const c of list) {
      const r = rows.length;
      let col = lanes.indexOf(c.sha);
      if (col === -1) col = this.free();
      const edges = [];
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] == null) continue;
        const dst = lanes[i] === c.sha ? col : i;
        for (const s of srcs[i]) edges.push({ x1: s, x2: dst, lane: i, top: s !== i, bot: dst !== i });
      }
      if (r > 0) rows[r - 1].edges = edges;
      for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) { lanes[i] = null; srcs[i] = []; }
      for (let i = 0; i < lanes.length; i++) if (lanes[i] != null) srcs[i] = [i];
      const ps = c.parents;
      if (ps.length) {
        lanes[col] = ps[0]; srcs[col] = [col];
        for (let k = 1; k < ps.length; k++) {
          let j = lanes.indexOf(ps[k]);
          if (j === -1) { j = this.free(); lanes[j] = ps[k]; srcs[j] = [col]; } else srcs[j].push(col);
        }
      } else { lanes[col] = null; srcs[col] = []; }
      while (lanes.length && lanes[lanes.length - 1] == null) { lanes.pop(); srcs.pop(); }
      rows.push({ col, edges: [] });
      if (col + 1 > this.maxLanes) this.maxLanes = col + 1;
      if (lanes.length > this.maxLanes) this.maxLanes = lanes.length;
    }
  }
  tail() {
    const out = [];
    this.lanes.forEach((l, i) => { if (l != null) for (const s of this.srcs[i]) out.push({ x1: s, x2: i, lane: i, top: s !== i, bot: false }); });
    return out;
  }
}

// ================================================================ data
const logParams = () => ({ order: P.order, ...(P.showRemotes ? {} : { remotes: '0' }), ...(S.solo ? { refs: S.solo } : {}) });
const viewLen = () => S.commits.length + S.off;
const rowAt = (v) => (v < S.off ? WIP_ROW : S.commits[v - S.off]);
const vIndex = (sha) => (sha === 'WIP' ? (S.off ? 0 : -1) : S.index.has(sha) ? S.index.get(sha) + S.off : -1);
const WIP_ROW = { sha: 'WIP', parents: [], subject: '', author: '', email: '', time: 0, wip: true };

function applyRefs(refs) {
  S.refs = refs.refs; S.stashes = refs.stashes;
  S.refsBySha = new Map(); S.labelCache = new Map();
  for (const r of S.refs) { if (!S.refsBySha.has(r.sha)) S.refsBySha.set(r.sha, []); S.refsBySha.get(r.sha).push(r); }
}
function applyStatus(st) {
  S.status = st.files;
  S.off = S.status.length && S.info?.head ? 1 : 0;
}

async function loadRepo(repo, { keep = false, open = false } = {}) {
  if (!repo) return;
  const switching = repo !== S.repo;
  S.repo = repo;
  setLoading('불러오는 중…');
  try {
    const limit = keep ? Math.min(5000, Math.max(600, S.commits.length)) : 600;
    if (switching) S.solo = null;
    const snap = await api('snapshot', { repo, limit, open: open ? 1 : '', ...logParams() });
    if (S.repo !== repo) return;
    if (snap.repo.path !== repo) {
      S.tabs = S.tabs.map((t) => (t === repo ? snap.repo.path : t)).filter((t, i, a) => a.indexOf(t) === i);
      S.repo = snap.repo.path; saveTabs();
    }
    S.info = snap.repo; S.meta = snap.info;
    applyRefs(snap.refs); applyStatus(snap.status);
    S.commits = snap.log.commits; S.hasMore = snap.log.hasMore;
    if (switching) {
      S.selected = null; S.detail = null; closeDiff(); closeFind();
      $('#graph-scroll').scrollTop = 0;
      connectLive();
      termOnRepoSwitch();
    }
    rebuild();
    renderTabs(); renderSidebar(); renderBanner(); renderStatusbar(); renderActions();
    if (S.selected && vIndex(S.selected) < 0) S.selected = null;
    if (S.selected) selectCommit(S.selected, { scroll: false, force: true }); else renderDetail();
    $('#empty').hidden = true;
  } catch (e) {
    if (S.repo === repo) showEmpty(e.message);
  } finally { setLoading(''); }
}

function rebuild() {
  S.index = new Map(S.commits.map((c, i) => [c.sha, i]));
  S.L = new Layout();
  S.L.push(S.commits);
  relayout();
}
function relayout() {
  S.graphW = CW.graph || Math.min(Math.max(44, PAD * 2 + S.L.maxLanes * LANE), 300);
  applyCols();
  $('#graph-inner').style.height = viewLen() * ROW + (S.hasMore ? 32 : 0) + 'px';
  S.ver++;
  renderRows();
  renderStatusbar();
}

async function loadMore() {
  if (!S.hasMore || S.loadingMore) return;
  S.loadingMore = true;
  setLoading('더 불러오는 중…');
  try {
    const repo = S.repo;
    const log = await api('log', { repo, skip: S.commits.length, limit: 2000, ...logParams() });
    if (repo !== S.repo) return;
    const base = S.commits.length;
    S.commits.push(...log.commits);
    log.commits.forEach((c, i) => S.index.set(c.sha, base + i));
    S.hasMore = log.hasMore;
    S.L.push(log.commits);
    relayout();
  } catch (e) { toast(e.message, 'err'); }
  finally { S.loadingMore = false; setLoading(''); }
}
async function ensureLoaded(sha) {
  for (let i = 0; i < 40 && vIndex(sha) < 0 && S.hasMore; i++) await loadMore();
  return vIndex(sha) >= 0;
}

async function refreshStatus() {
  const repo = S.repo;
  const snap = await api('snapshot', { repo, parts: 'status,info' });
  if (repo !== S.repo) return;
  const hadWip = S.off;
  S.meta = snap.info;
  applyStatus(snap.status);
  if (hadWip !== S.off) relayout(); else { S.ver++; renderRows(); }
  renderBanner(); renderActions();
  if (S.detail?.wip) { if (S.off) renderDetail(); else { S.selected = null; S.detail = null; renderDetail(); } }
}

function setLoading(t) { $('#sb-loading').textContent = t; }
function showEmpty(msg) {
  const e = $('#empty');
  e.hidden = false;
  e.innerHTML = `<h2>${msg ? '저장소를 열 수 없어요' : 'Git Rising'}</h2><div>${esc(msg || '내 컴퓨터의 저장소를 자동으로 찾아뒀어요.')}</div>
    <div style="display:flex;gap:8px"><button class="btn primary" id="e-find">${icon('search')} 저장소 찾기 <kbd>⌘O</kbd></button><button class="btn" id="e-pick">${icon('folder')} 폴더 선택…</button><button class="btn" id="e-clone">${icon('cloud-down')} 복제 (clone)…</button></div>
    <div style="font-size:.9em">폴더를 창에 끌어다 놓아도 열려요</div>`;
  $('#e-find').onclick = () => openPalette('repos');
  $('#e-pick').onclick = pickRepo;
  $('#e-clone').onclick = cloneRepo;
}

// ================================================================ live updates (SSE)
function connectLive() {
  S.es?.close(); S.es = null; S.live = false;
  if (!S.repo || document.hidden) return renderStatusbar();
  const es = new EventSource(`/api/events?repo=${encodeURIComponent(S.repo)}`);
  S.es = es;
  es.onopen = () => { S.live = true; renderStatusbar(); };
  es.onerror = () => { S.live = false; renderStatusbar(); };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.refs) liveRefresh();
    else if (ev.status) refreshStatus().catch(() => {});
  };
}
const liveRefresh = debounce(() => loadRepo(S.repo, { keep: true }), 150);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { S.es?.close(); S.es = null; S.live = false; renderStatusbar(); }
  else if (S.repo) { connectLive(); loadRepo(S.repo, { keep: true }); }
});

function connectBus() {
  const bus = new EventSource('/api/bus');
  bus.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'askpass') askpass(ev);
    if (ev.type === 'askpass-done' && S.askId === ev.id) closeModal();
    if (ev.type === 'update') updateState(ev);
    if (ev.type === 'ui') uiCommand(ev);
  };
}
async function uiCommand(ev) {
  if (ev.action === 'pref' && ev.key in PREF_DEF) setPref(ev.key, ev.value);
  if (ev.action === 'open' && ev.path) { await openTab(ev.path); window.focus(); }
  if (ev.action === 'select' && ev.path) { if (ev.path !== S.repo) await openTab(ev.path); if (ev.sha) selectCommit(ev.sha); }
}

// ================================================================ rows (recycled DOM pool) + canvas
function refLabels(sha) {
  if (S.labelCache.has(sha)) return S.labelCache.get(sha);
  const refs = S.refsBySha.get(sha) || [];
  const out = [], locals = new Map();
  for (const r of refs) if (r.type === 'branch') { const x = { ...r, remotes: [] }; out.push(x); locals.set(r.name, x); }
  for (const r of refs) if (r.type === 'remote' && P.showRemotes) {
    const short = r.name.slice(r.name.indexOf('/') + 1);
    if (locals.has(short)) locals.get(short).remotes.push(r.name); else out.push({ ...r, remotes: [r.name] });
  }
  for (const r of refs) if (r.type === 'tag' && P.showTags) out.push(r);
  const hb = S.info?.branch;
  out.sort((a, b) => Number(b.name === hb && b.type === 'branch') - Number(a.name === hb && a.type === 'branch'));
  S.labelCache.set(sha, out);
  return out;
}
function pillHTML(r, color) {
  const isHead = r.type === 'branch' && r.name === S.info?.branch;
  const ic = r.type === 'tag' ? icon('tag') : isHead ? icon('check') : r.type === 'remote' ? icon('cloud') : '';
  const cloud = r.type === 'branch' && r.remotes?.length ? icon('cloud') : '';
  const tip = [r.type === 'tag' ? '태그 ' + r.name : r.name, ...(r.remotes || []).filter((x) => x !== r.name)].join('\n');
  return `<span class="pill ${r.type}${isHead ? ' head' : ''}" style="--pc:${color}" data-ref="${esc(r.type)}:${esc(r.name)}" title="${esc(tip)}">${ic}<span class="t">${escN(r.name)}</span>${cloud}</span>`;
}
const pool = [];
let poolSize = 0;
function fillRow(el, v) {
  const c = rowAt(v);
  const col = c.wip ? laneColor(headCol()) : laneColor(S.L.rows[v - S.off].col);
  let ref = '';
  if (!c.wip) {
    const labels = refLabels(c.sha);
    if (labels.length) {
      ref = pillHTML(labels[0], col);
      if (labels.length > 1) ref += `<span class="more">+${labels.length - 1}</span>`;
    }
  }
  el.innerHTML = c.wip
    ? `<div class="c-ref"></div><div class="c-graph"></div><div class="c-msg"><span class="wip">커밋 안 한 변경 ${S.status.length}개</span></div><div></div><div></div><div></div>`
    : `<div class="c-ref">${ref}</div><div class="c-graph"></div><div class="c-msg">${c.sha === S.info?.head ? `<span class="here" title="지금 체크아웃된 위치 (HEAD)">${icon('checkout')}현재 위치</span>` : ''}${escN(c.subject)}</div><div class="c-author">${escN(c.author)}</div><div class="c-date" title="${fmtDate(c.time)}">${P.dateMode === 'absolute' ? fmtDate(c.time).slice(2) : relDate(c.time)}</div><div class="c-sha">${c.sha.slice(0, 7)}</div>`;
}
function headCol() { const i = S.index.get(S.info?.head); return i == null ? 0 : S.L.rows[i].col; }

let rafPending = false;
function renderRows() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; paint(); }); } }
function paint() {
  const sc = $('#graph-scroll');
  const n = viewLen();
  const h = sc.clientHeight;
  const need = Math.ceil(h / ROW) + 12;
  if (need > poolSize) {
    for (let k = poolSize; k < need; k++) { const el = document.createElement('div'); el.className = 'row'; el._v = -1; $('#rows').append(el); pool.push(el); }
    poolSize = need;
    pool.forEach((el) => (el._v = -1));
  }
  const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 4);
  const last = Math.min(n - 1, first + poolSize - 1);
  for (let v = first; v <= last; v++) {
    const el = pool[v % poolSize];
    if (el._v !== v || el._ver !== S.ver) {
      fillRow(el, v); el._v = v; el._ver = S.ver;
      el.style.transform = `translateY(${v * ROW}px)`; el.dataset.v = v; el.style.display = '';
    }
    const c = rowAt(v);
    el.classList.toggle('selected', c.sha === S.selected);
    el.classList.toggle('head', !c.wip && c.sha === S.info?.head);
    el.classList.toggle('match', !!S.find && S.findSet.has(c.sha));
    el.classList.toggle('dim', !!S.find && S.findShas.length > 0 && !S.findSet.has(c.sha));
  }
  for (const el of pool) if (el._v < first || el._v > last) { el.style.display = 'none'; el._v = -1; }
  let lm = $('#rows .load-more');
  if (S.hasMore) {
    if (!lm) { lm = document.createElement('div'); lm.className = 'load-more'; lm.textContent = '스크롤하면 더 불러옵니다'; $('#rows').append(lm); }
    lm.style.top = n * ROW + 'px';
  } else lm?.remove();
  drawGraph(first, last);
  if (S.hasMore && last >= n - 40) loadMore();
}

let canvasSize = '';
function drawGraph(first, last) {
  const cv = $('#graph-canvas');
  const sc = $('#graph-scroll');
  const dpr = window.devicePixelRatio || 1;
  const w = CW.ref + S.graphW, h = sc.clientHeight;
  const key = `${w}x${h}@${dpr}`;
  if (key !== canvasSize) {
    canvasSize = key;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cv.width = Math.ceil(w * dpr); cv.height = Math.ceil(h * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const n = viewLen();
  if (!n) return;
  const top = sc.scrollTop, x0 = CW.ref;
  const X = (lane) => x0 + PAD + lane * LANE + LANE / 2;
  const Y = (v) => v * ROW + ROW / 2 - top;
  const bg = S.theme.bg;
  g.save();
  g.beginPath(); g.rect(x0, 0, S.graphW, h); g.clip();
  g.lineWidth = 1.6; g.lineCap = 'round';
  const off = S.off;
  // edges between commit rows
  const cFirst = Math.max(0, first - off - 1), cLast = Math.min(S.commits.length - 1, last - off);
  for (let r = cFirst; r <= cLast; r++) {
    const row = S.L.rows[r];
    const isLast = r === S.commits.length - 1;
    const es = isLast ? S.L.tail() : row.edges;
    const y1 = Y(r + off), y2 = y1 + ROW;
    for (const e of es) {
      const a = X(e.x1), b = X(e.x2);
      g.strokeStyle = laneColor(e.lane);
      g.beginPath(); g.moveTo(a, y1);
      if (a === b) g.lineTo(b, y2);
      else {
        const rad = Math.min(6, Math.abs(b - a) / 2), sx = Math.sign(b - a);
        if (e.top && !e.bot) { g.lineTo(b - sx * rad, y1); g.quadraticCurveTo(b, y1, b, y1 + rad); g.lineTo(b, y2); }
        else if (e.bot && !e.top) { g.lineTo(a, y2 - rad); g.quadraticCurveTo(a, y2, a + sx * rad, y2); g.lineTo(b, y2); }
        else { const my = (y1 + y2) / 2; g.bezierCurveTo(a, my, b, my, b, y2); }
      }
      g.stroke();
    }
  }
  // WIP: dashed link to HEAD
  if (off) {
    const hi = S.index.get(S.info.head);
    const x = X(headCol());
    g.setLineDash([3, 3]); g.strokeStyle = laneColor(headCol());
    g.beginPath(); g.moveTo(x, Y(0)); g.lineTo(x, hi == null ? h : Y(hi + off)); g.stroke(); g.setLineDash([]);
  }
  // nodes
  for (let v = first; v <= last; v++) {
    const c = rowAt(v);
    const col = c.wip ? headCol() : S.L.rows[v - off].col;
    const x = X(col), y = Y(v), color = laneColor(col);
    if (c.wip) {
      g.setLineDash([2, 2]); g.strokeStyle = color; g.fillStyle = bg; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, NODE_R + 0.5, 0, 7); g.fill(); g.stroke(); g.setLineDash([]); g.lineWidth = 1.6;
      continue;
    }
    const merge = c.parents.length > 1;
    if (P.avatars && !merge) {
      const r = NODE_R;
      const peb = (rr) => { g.beginPath(); g.roundRect(x - rr, y - rr, rr * 2, rr * 2, rr * 0.72); };
      g.fillStyle = color; peb(r + 1.5); g.fill();
      const photo = avatarImg(c);
      if (photo) {
        g.save(); peb(r - 0.3); g.clip(); g.drawImage(photo, x - r, y - r, r * 2, r * 2); g.restore();
        if (c.sha === S.info?.head) { g.strokeStyle = S.theme.text; g.lineWidth = 1.6; peb(r + 4); g.stroke(); }
        g.lineWidth = 1.6;
        continue;
      }
      g.fillStyle = avColor(c.email); peb(r - 0.3); g.fill();
      g.fillStyle = '#fff'; g.font = `600 ${Math.round(r * 0.95)}px ${getComputedStyle(document.body).fontFamily}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(initials(c.author), x, y + 0.5);
      if (c.sha === S.info?.head) { g.strokeStyle = S.theme.text; g.lineWidth = 1.4; peb(r + 4); g.stroke(); }
      g.lineWidth = 1.6;
      continue;
    }
    g.fillStyle = merge ? bg : color; g.strokeStyle = color; g.lineWidth = 1.8;
    g.beginPath(); g.arc(x, y, merge ? NODE_R - 0.5 : NODE_R, 0, 7); g.fill(); if (merge) g.stroke();
    if (c.sha === S.info?.head) { g.strokeStyle = S.theme.text; g.lineWidth = 1.4; g.beginPath(); g.arc(x, y, NODE_R + 3, 0, 7); g.stroke(); }
    g.lineWidth = 1.6;
  }
  g.restore();
  // ref connector
  g.globalAlpha = 0.45; g.lineWidth = 1.2;
  for (let v = first; v <= last; v++) {
    const c = rowAt(v);
    if (c.wip || !S.refsBySha.has(c.sha)) continue;
    const col = S.L.rows[v - off].col;
    g.strokeStyle = laneColor(col);
    g.beginPath(); g.moveTo(x0 - 2, Y(v)); g.lineTo(X(col) - NODE_R - 2, Y(v)); g.stroke();
  }
  g.globalAlpha = 1;
}

// ================================================================ popover: every branch / tag on a commit
let refPopTimer = null;
function hideRefPop() { clearTimeout(refPopTimer); $('#refpop')?.remove(); }
function showRefPop(rowEl) {
  const c = rowAt(+rowEl.dataset.v);
  if (!c || c.wip) return;
  const labels = refLabels(c.sha);
  if (labels.length < 2) return;
  hideRefPop();
  const col = laneColor(S.L.rows[+rowEl.dataset.v - S.off].col);
  const pop = document.createElement('div');
  pop.id = 'refpop';
  pop.className = 'menu refpop';
  pop.innerHTML = `<div class="mhead">이 커밋의 브랜치 · 태그 ${labels.length}개</div>` + labels.map((l) => {
    const wt = l.type === 'branch' ? otherWorktree(l.name) : null;
    const kind = l.type === 'tag' ? '태그' : l.type === 'remote' ? '원격' : l.name === S.info?.branch ? '현재' : l.remotes?.length ? '로컬 + 원격' : '로컬';
    return `<div class="rp-it" data-ref="${esc(l.type)}:${esc(l.name)}">${pillHTML(l, col)}<span class="rp-kind">${kind}${wt ? ' · 워크트리 ' + esc(wt.path.split(/[\\/]/).pop()) : ''}</span></div>`;
  }).join('') + '<div class="rp-foot">더블클릭 전환 · 우클릭 작업</div>';
  document.body.append(pop);
  const r = rowEl.querySelector('.c-ref').getBoundingClientRect(), pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(r.left + 4, innerWidth - pr.width - 6)) + 'px';
  pop.style.top = (r.bottom + pr.height + 4 > innerHeight ? r.top - pr.height - 2 : r.bottom + 2) + 'px';
  pop.onmouseenter = () => clearTimeout(refPopTimer);
  pop.onmouseleave = () => { refPopTimer = setTimeout(hideRefPop, 180); };
  pop.ondblclick = (e) => {
    const it = e.target.closest('[data-ref]'); if (!it) return;
    const ref = findRef(it.dataset.ref); hideRefPop();
    if (S.info?.worktree && P.worktreeGuard) { if (ref) selectCommit(ref.sha); return; }
    if (ref && ref.type !== 'tag' && !(ref.type === 'branch' && ref.name === S.info?.branch)) run('checkout', { ref: ref.name, kind: ref.type }, { label: `${ref.name} 전환` });
  };
  pop.oncontextmenu = (e) => {
    const it = e.target.closest('[data-ref]'); if (!it) return;
    e.preventDefault();
    let ref = findRef(it.dataset.ref);
    if (ref?.type === 'branch') ref = refLabels(ref.sha).find((l) => l.type === 'branch' && l.name === ref.name) || ref;
    hideRefPop();
    if (ref) showMenu(refMenu(ref), e.clientX, e.clientY);
  };
}

// ================================================================ selection / detail
const cacheKey = (sha) => S.repo + '\0' + sha;
function getCommit(sha) {
  const k = cacheKey(sha);
  if (S.cache.has(k)) { const v = S.cache.get(k); S.cache.delete(k); S.cache.set(k, v); return v; }
  const p = api('commit', { repo: S.repo, sha });
  S.cache.set(k, p);
  p.catch(() => S.cache.delete(k));
  if (S.cache.size > 400) S.cache.delete(S.cache.keys().next().value);
  return p;
}
const loadDetail = debounce(async (sha) => {
  try {
    const d = await getCommit(sha);
    if (S.selected === sha) { S.detail = d; renderDetail(); if (P.openDiffOnSelect && !$('#diff-view').hidden && d.files.length) openDiff(0); }
  } catch (e) { toast(e.message, 'err'); }
}, 40);

async function selectCommit(sha, { scroll = true, force = false } = {}) {
  if (!force && sha === S.selected && S.detail) return;
  if (vIndex(sha) < 0 && !(await ensureLoaded(sha))) { toast('불러온 범위에 없는 커밋입니다'); return; }
  S.selected = sha;
  if (scroll) scrollToRow(vIndex(sha));
  renderRows();
  if (sha === 'WIP') { S.detail = { wip: true }; renderDetail(); return; }
  const k = cacheKey(sha);
  if (S.cache.has(k)) { S.cache.get(k).then((d) => { if (S.selected === sha) { S.detail = d; renderDetail(); } }); }
  else loadDetail(sha);
}
function scrollToRow(v) {
  const sc = $('#graph-scroll'), y = v * ROW;
  if (y < sc.scrollTop + ROW || y > sc.scrollTop + sc.clientHeight - ROW * 2) sc.scrollTop = y - sc.clientHeight / 3;
}

const EXT_KIND = (() => {
  const m = {};
  'png jpg jpeg gif webp bmp ico svg avif apng'.split(' ').forEach((e) => (m[e] = 'image'));
  'pdf'.split(' ').forEach((e) => (m[e] = 'pdf'));
  'mp4 webm mov m4v ogv mkv'.split(' ').forEach((e) => (m[e] = 'video'));
  'mp3 wav ogg m4a flac aac opus'.split(' ').forEach((e) => (m[e] = 'audio'));
  'docx'.split(' ').forEach((e) => (m[e] = 'docx'));
  'xlsx xls xlsm xlsb ods csv tsv numbers'.split(' ').forEach((e) => (m[e] = 'sheet'));
  'md markdown mdx'.split(' ').forEach((e) => (m[e] = 'md'));
  'pptx ppt key hwp hwpx doc pages zip psd ai sketch fig heic tiff tif'.split(' ').forEach((e) => (m[e] = 'external'));
  return m;
})();
const kindOf = (p) => EXT_KIND[(p.split('.').pop() || '').toLowerCase()] || 'text';
const KIND_LABEL = { image: '이미지', pdf: 'PDF', video: '영상', audio: '오디오', docx: 'Word', sheet: '시트', external: '문서' };

function fileListHTML(files, startIdx = 0) {
  const sym = { A: '+', D: '−', M: '•', R: '→', C: '⧉', U: '!', T: '•', '?': '+' };
  const one = (f, i, short) => {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const base = f.path.slice(dir.length);
    const k = kindOf(f.path);
    const n = f.add != null ? `<span class="n"><span class="a">+${f.add}</span> <span class="d">−${f.del}</span></span>` : KIND_LABEL[k] ? `<span class="kind">${KIND_LABEL[k]}</span>` : '';
    const p = short ? `<bdi>${escN(base)}</bdi>` : `<bdi><span class="dir">${escN(dir)}</span>${escN(base)}</bdi>`;
    const [fic, fcol] = fileIcon(f.path);
    return `<div class="file" data-fi="${i + startIdx}" title="${esc(f.oldPath ? f.oldPath + ' → ' + f.path : f.path)}"><span class="st st-${esc(f.status)}">${sym[f.status] || f.status}</span><span class="fic" style="color:${fcol}">${icon(fic)}</span><span class="p">${p}</span>${n}</div>`;
  };
  if (S.fileView === 'tree') {
    const groups = new Map();
    files.forEach((f, i) => { const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.'; if (!groups.has(d)) groups.set(d, []); groups.get(d).push([f, i]); });
    return `<div class="files tree">${[...groups.keys()].sort().map((d) => `<div class="dir-h">${esc(d)}/</div>` + groups.get(d).map(([f, i]) => one(f, i, true)).join('')).join('')}</div>`;
  }
  return `<div class="files">${files.map((f, i) => one(f, i, false)).join('')}</div>`;
}
function statsHTML(files) {
  const c = { M: 0, A: 0, D: 0, R: 0 };
  for (const f of files) { const s = f.status === '?' || f.status === 'C' ? 'A' : f.status === 'U' || f.status === 'T' ? 'M' : f.status; c[s] = (c[s] || 0) + 1; }
  return `<div class="d-stats">${c.M ? `<span class="m">수정 ${c.M}</span>` : ''}${c.A ? `<span class="a">추가 ${c.A}</span>` : ''}${c.D ? `<span class="d">삭제 ${c.D}</span>` : ''}${c.R ? `<span class="r">이동 ${c.R}</span>` : ''}
    <div class="seg"><button data-fv="path" class="${S.fileView === 'path' ? 'on' : ''}">경로</button><button data-fv="tree" class="${S.fileView === 'tree' ? 'on' : ''}">폴더</button></div></div>`;
}
function renderDetail() {
  const el = $('#detail'), d = S.detail;
  if (!d) { el.innerHTML = `<div class="placeholder">커밋을 선택하세요<br><br><kbd>↑</kbd> <kbd>↓</kbd> 로 이동 · 우클릭으로 작업</div>`; return; }
  if (d.wip) {
    const staged = S.status.filter((f) => f.staged), rest = S.status.filter((f) => !f.staged);
    S.detailFiles = [...staged, ...rest];
    el.innerHTML = `<div class="d-head"><div class="d-meta"><span class="badge">작업 중</span>${esc(S.info?.branch || 'detached')}</div><h2 class="d-subject">커밋 안 한 변경사항</h2></div>
      ${statsHTML(S.status)}
      ${staged.length ? `<div class="wip-sec" title="git add 된 파일 — 다음 커밋에 들어갑니다">스테이징됨 · ${staged.length}</div>${fileListHTML(staged, 0)}` : ''}
      ${rest.length ? `<div class="wip-sec" title="아직 git add 하지 않은 변경 / 새 파일">스테이징 안 됨 · ${rest.length}</div>${fileListHTML(rest, staged.length)}` : ''}`;
    return;
  }
  S.detailFiles = d.files;
  const [subject, ...bl] = d.message.split('\n');
  const body = bl.join('\n').trim();
  const labels = refLabels(d.sha);
  const col = laneColor(S.L.rows[S.index.get(d.sha)]?.col || 0);
  el.innerHTML = `
    <div class="d-head">
      <div class="d-meta"><span class="sha" data-copy="${d.sha}" title="클릭하면 전체 SHA 복사">${d.sha.slice(0, 7)}</span>${d.parents.length > 1 ? '<span class="badge">머지</span>' : ''}<span>${relDate(d.time)}</span></div>
      <h2 class="d-subject">${esc(subject)}</h2>${body ? `<div class="d-body">${esc(body)}</div>` : ''}
      ${labels.length ? `<div class="d-refs">${labels.map((l) => pillHTML(l, col)).join('')}</div>` : ''}
    </div>
    <div class="d-author">
      <div class="av" style="background:${avColor(d.email)}">${esc(initials(d.author))}${P.avatarPhotos ? `<img src="${avatarURL(d.email, d.sha, d.author)}" onerror="this.remove()">` : ''}</div>
      <div class="who"><div class="nm">${esc(d.author)}</div><div class="sub" title="${esc(d.email)}">${fmtDate(d.time)}${d.committer !== d.author ? ` · 커밋 ${esc(d.committer)}` : ''}</div></div>
      <div class="par">${d.parents.length ? '부모' : '최초 커밋'}${d.parents.map((p) => `<a data-goto="${p}">${p.slice(0, 7)}</a>`).join('')}</div>
    </div>
    ${statsHTML(d.files)}
    ${d.files.length ? fileListHTML(d.files) : '<div class="placeholder">변경된 파일 없음</div>'}`;
}

// ================================================================ diff + rich preview
function blobURL(side, f) {
  const d = S.detail;
  const p = { repo: S.repo, path: side === 'old' ? f.oldPath || f.path : f.path };
  if (d.wip) p.sha = side === 'old' ? 'HEAD' : 'WIP';
  else p.sha = side === 'old' ? d.parents[0] : d.sha;
  return `/api/blob?${new URLSearchParams(p)}`;
}
async function openDiff(fi) {
  const f = S.detailFiles?.[fi];
  if (!f) return;
  S.diffFile = f; S.diffPatch = null;
  document.querySelectorAll('#detail .file').forEach((e) => e.classList.toggle('selected', +e.dataset.fi === fi));
  $('#diff-view').hidden = false;
  const k = kindOf(f.path);
  const textish = ['text', 'md'].includes(k) || /\.(svg|csv|tsv)$/i.test(f.path);
  const canPreview = k !== 'text';
  const mode = textish ? P.diffMode : 'preview';
  renderDiffHead(f, textish, canPreview, mode);
  showMode(mode);
}
function renderDiffHead(f, textish, canPreview, mode) {
  const h = $('#diff-head');
  const [fic, fcol] = fileIcon(f.path);
  const modes = [...(textish ? [['unified', '변경', '바뀐 줄만 한 단으로 (diff)'], ['split', '좌우 비교', '왼쪽 이전 · 오른쪽 이후'], ['full', '파일 전체', '이 커밋 시점의 파일 전체 (바뀐 줄 표시)']] : []), ...(canPreview ? [['preview', '미리보기', '렌더링된 모습']] : [])];
  h.innerHTML = `<button id="diff-close" class="ib" title="닫기 (Esc)">${icon('x')}</button><span class="fic" style="color:${fcol}">${icon(fic)}</span><span id="diff-title">${escN((f.oldPath ? f.oldPath + ' → ' : '') + f.path)}</span><span class="grow"></span>
    ${modes.length > 1 ? `<div class="seg" style="margin:0">${modes.map(([m, l, t]) => `<button data-mode="${m}" title="${t}" class="${mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
    ${textish ? '<label class="chk" title="긴 줄을 화면 폭에 맞춰 줄바꿈"><input type="checkbox" id="diff-wrap"> 줄바꿈</label>' : ''}
    <button class="ib" id="diff-open" title="기본 앱으로 열기">${icon('external')}</button>`;
  $('#diff-close').onclick = closeDiff;
  $('#diff-open').onclick = () => openExternal(S.diffFile);
  h.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    h.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
    if (b.dataset.mode !== 'preview') setPref('diffMode', b.dataset.mode);
    showMode(b.dataset.mode);
  }));
  const wrap = $('#diff-wrap');
  if (wrap) { wrap.checked = LS.get('wrap', false); $('#diff-body').classList.toggle('wrap', wrap.checked); wrap.onchange = () => { LS.set('wrap', wrap.checked); $('#diff-body').classList.toggle('wrap', wrap.checked); }; }
}
async function openExternal(f) {
  const d = S.detail;
  try { await post('openfile', { repo: S.repo }, { sha: d.wip ? 'WIP' : d.sha, path: f.path }); }
  catch (e) { toast(e.message, 'err'); }
}
async function getPatch(f) {
  if (S.diffPatch?.f === f) return S.diffPatch.r;
  const d = S.detail;
  const params = { repo: S.repo, path: f.path };
  if (f.oldPath) params.oldPath = f.oldPath;
  if (d.wip) { params.sha = 'WIP'; if (f.status === '?') params.untracked = '1'; }
  else { params.sha = d.sha; if (d.parents[0]) params.parent = d.parents[0]; }
  const r = await api('diff', params);
  S.diffPatch = { f, r };
  return r;
}
async function showMode(mode) {
  const f = S.diffFile, body = $('#diff-body');
  body.className = LS.get('wrap', false) && mode !== 'preview' ? 'wrap' : '';
  body.innerHTML = '<div class="diff-note">불러오는 중…</div>';
  try {
    if (mode === 'unified' || mode === 'split') {
      const [r] = await Promise.all([getPatch(f), ensureHljs()]);
      if (S.diffFile !== f) return;
      if (mode === 'split') renderSplit(r.patch, r.truncated, f); else renderDiff(r.patch, r.truncated, f);
      return;
    }
    if (mode === 'full') {
      const side = f.status === 'D' ? 'old' : 'new';
      const [r, txt] = await Promise.all([getPatch(f).catch(() => ({ patch: '' })), fetch(blobURL(side, f) + '&text=1').then((x) => (x.ok ? x.text() : Promise.reject(new Error('파일을 읽을 수 없어요')))), ensureHljs()]);
      if (S.diffFile !== f) return;
      renderFull(txt, r.patch, f, side);
      return;
    }
  } catch (e) { body.innerHTML = `<div class="diff-note">${esc(e.message)}</div>`; return; }
  const hasOld = f.status !== 'A' && f.status !== '?' && !(S.detail.parents?.length === 0 && !S.detail.wip);
  const hasNew = f.status !== 'D';
  const sides = [hasOld && 'old', hasNew && 'new'].filter(Boolean);
  body.innerHTML = `<div class="pv">${sides.map((s) => `<div class="pv-side"><div class="pv-label">${s === 'old' ? '<span class="tag-old">● 이전</span>' : '<span class="tag-new">● 이후</span>'}<span class="pv-meta" data-meta="${s}"></span></div><div class="pv-frame" data-side="${s}"></div></div>`).join('')}</div>`;
  for (const s of sides) renderPreview(body.querySelector(`[data-side="${s}"]`), blobURL(s, f), f, s);
}

// ---- syntax highlighting (highlight.js, loaded on first use)
const ensureHljs = () => loadScript('hljs.js').catch(() => {});
const LANG_ALIAS = { mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', htm: 'xml', html: 'xml', vue: 'xml', svelte: 'xml', svg: 'xml', plist: 'xml', yml: 'yaml', zsh: 'bash', sh: 'bash', fish: 'bash', h: 'c', hpp: 'cpp', cc: 'cpp', mm: 'objectivec', m: 'objectivec', kts: 'kotlin', gradle: 'groovy', toml: 'ini', env: 'ini', conf: 'ini', mdx: 'markdown', jsonc: 'json', json5: 'json', dockerfile: 'dockerfile', gql: 'graphql', prisma: 'graphql' };
function langOf(p) {
  const base = p.split('/').pop().toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : base;
  const l = LANG_ALIAS[ext] || ext;
  return window.hljs?.getLanguage(l) ? l : null;
}
function hlLine(text, lang) {
  if (!lang || text.length > 2000) return esc(text);
  try { return window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return esc(text); }
}
// highlight a whole file, then cut it into lines while keeping <span>s balanced on each line
function hlLines(text, lang) {
  if (!lang || text.length > 400000) return text.split('\n').map(esc);
  let html;
  try { html = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return text.split('\n').map(esc); }
  const out = [];
  let open = [];
  for (const raw of html.split('\n')) {
    const stack = [...open];
    const re = /<span[^>]*>|<\/span>/g;
    let m;
    while ((m = re.exec(raw))) { if (m[0] === '</span>') stack.pop(); else stack.push(m[0]); }
    out.push(open.join('') + raw + '</span>'.repeat(stack.length));
    open = stack;
  }
  return out;
}
// patch → [{type:'hunk'|'ctx'|'add'|'del'|'meta', text, o, n}]
function parsePatch(patch) {
  const rows = [];
  let o = 0, n = 0, inHunk = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { o = +m[1]; n = +m[2]; }
      inHunk = true;
      rows.push({ type: 'hunk', text: l });
    } else if (!inHunk || l.startsWith('diff --git')) {
      inHunk = false;
      if (/^(diff --git|index |--- |\+\+\+ )/.test(l) || !l) continue;
      rows.push({ type: 'meta', text: l });
    } else if (l[0] === '+') rows.push({ type: 'add', text: l.slice(1), n: n++ });
    else if (l[0] === '-') rows.push({ type: 'del', text: l.slice(1), o: o++ });
    else if (l[0] === '\\') rows.push({ type: 'meta', text: l });
    else if (l !== '') rows.push({ type: 'ctx', text: l.slice(1), o: o++, n: n++ });
  }
  return rows;
}
function binaryNote(patch) {
  const body = $('#diff-body');
  if (!patch.trim()) { body.innerHTML = '<div class="diff-note">표시할 텍스트 변경이 없어요 (바이너리 / 권한 변경)</div>'; return true; }
  if (/^Binary files /m.test(patch) && !/^@@/m.test(patch)) {
    body.innerHTML = `<div class="diff-note">바이너리 파일이에요.<br><br><button class="btn" data-ext>${icon('external')} 기본 앱으로 열기</button></div>`;
    body.querySelector('[data-ext]').onclick = () => openExternal(S.diffFile);
    return true;
  }
  return false;
}
function renderDiff(patch, truncated, f) {
  if (binaryNote(patch)) return;
  const rows = parsePatch(patch);
  const lang = rows.length < 6000 ? langOf(f.path) : null;
  const out = rows.map((r) => {
    if (r.type === 'hunk') return `<div class="dl hunk"><span class="ln"></span><span class="ln"></span><span class="tx">${esc(r.text)}</span></div>`;
    if (r.type === 'meta') return `<div class="dl meta"><span class="ln"></span><span class="ln"></span><span class="tx">${esc(r.text)}</span></div>`;
    const mk = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
    return `<div class="dl ${r.type}"><span class="ln">${r.o ?? ''}</span><span class="ln">${r.n ?? ''}</span><span class="tx"><span class="mk">${mk}</span>${hlLine(r.text, lang)}</span></div>`;
  });
  if (truncated) out.push('<div class="diff-note">diff 가 너무 커서 일부만 표시합니다</div>');
  $('#diff-body').innerHTML = out.join('');
  $('#diff-body').scrollTop = 0;
}
function renderSplit(patch, truncated, f) {
  if (binaryNote(patch)) return;
  const rows = parsePatch(patch);
  const lang = rows.length < 6000 ? langOf(f.path) : null;
  const out = [];
  const cell = (r, side) => (r ? `<span class="ln">${side === 'l' ? r.o ?? '' : r.n ?? ''}</span><span class="tx ${r.type}">${hlLine(r.text, lang)}</span>` : '<span class="ln"></span><span class="tx none"></span>');
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.type === 'hunk' || r.type === 'meta') { out.push(`<div class="sl ${r.type}"><span class="full">${esc(r.text)}</span></div>`); i++; continue; }
    if (r.type === 'ctx') { out.push(`<div class="sl">${cell(r, 'l')}${cell(r, 'r')}</div>`); i++; continue; }
    const dels = [], adds = [];
    while (rows[i]?.type === 'del') dels.push(rows[i++]);
    while (rows[i]?.type === 'add') adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push(`<div class="sl">${cell(dels[k], 'l')}${cell(adds[k], 'r')}</div>`);
  }
  if (truncated) out.push('<div class="diff-note">diff 가 너무 커서 일부만 표시합니다</div>');
  $('#diff-body').innerHTML = `<div class="split-head"><span>이전</span><span>이후</span></div>` + out.join('');
  $('#diff-body').scrollTop = 0;
}
function renderFull(text, patch, f, side) {
  const changed = new Set(parsePatch(patch || '').filter((r) => (side === 'new' ? r.type === 'add' : r.type === 'del')).map((r) => (side === 'new' ? r.n : r.o)));
  const lines = hlLines(text.replace(/\n$/, ''), langOf(f.path));
  const MAX = 20000;
  const cls = side === 'new' ? 'add' : 'del';
  const body = $('#diff-body');
  body.innerHTML = lines.slice(0, MAX).map((l, i) => `<div class="fl${changed.has(i + 1) ? ' ' + cls : ''}" ${changed.has(i + 1) ? 'data-chg' : ''}><span class="ln">${i + 1}</span><span class="tx">${l || ' '}</span></div>`).join('')
    + (lines.length > MAX ? `<div class="diff-note">${lines.length.toLocaleString()}줄 중 ${MAX.toLocaleString()}줄까지 표시</div>` : '');
  // jump to the first changed line
  const first = body.querySelector('[data-chg]');
  body.scrollTop = first ? Math.max(0, first.offsetTop - 80) : 0;
}

const vendorLoaded = {};
function loadScript(name) {
  return (vendorLoaded[name] ||= new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = '/vendor/' + name; el.onload = res; el.onerror = () => rej(new Error(name + ' 로드 실패'));
    document.head.append(el);
  }));
}
async function renderPreview(box, url, f, side) {
  const k = kindOf(f.path);
  const meta = $(`[data-meta="${side}"]`);
  try {
    if (k === 'image') {
      box.classList.add('checker');
      box.innerHTML = `<img src="${url}" alt="">`;
      const img = box.querySelector('img');
      img.onload = () => { if (meta) meta.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; };
      img.onerror = () => (box.innerHTML = '<div class="diff-note">이미지를 표시할 수 없어요</div>');
    } else if (k === 'pdf') {
      box.innerHTML = `<iframe src="${url}#view=FitH"></iframe>`;
    } else if (k === 'video') {
      box.innerHTML = `<video src="${url}" controls preload="metadata"></video>`;
    } else if (k === 'audio') {
      box.innerHTML = `<audio src="${url}" controls preload="metadata" style="width:90%"></audio>`;
    } else if (k === 'docx') {
      await loadScript('jszip.js'); await loadScript('docx-preview.js');
      const buf = await (await fetch(url)).arrayBuffer();
      box.classList.add('doc'); box.innerHTML = '';
      await window.docx.renderAsync(buf, box, null, { inWrapper: true, ignoreLastRenderedPageBreak: true, breakPages: true });
    } else if (k === 'sheet') {
      await loadScript('xlsx.js');
      const isText = /\.(csv|tsv)$/i.test(f.path);
      const wb = isText
        ? window.XLSX.read(await (await fetch(url + '&text=1')).text(), { type: 'string', dense: true, raw: true })
        : window.XLSX.read(await (await fetch(url)).arrayBuffer(), { type: 'array', dense: true, cellDates: true });
      box.classList.add('sheet');
      const show = (name) => {
        const ws = wb.Sheets[name];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });
        const MAXR = 2000, MAXC = 60;
        const cols = Math.min(MAXC, rows.reduce((m, r) => Math.max(m, r.length), 0));
        const colName = (i) => { let s = ''; i++; while (i) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };
        let html = `<div class="pv-tabs">${wb.SheetNames.map((n) => `<button data-sheet="${esc(n)}" class="${n === name ? 'on' : ''}">${esc(n)}</button>`).join('')}</div><table class="sheet-tbl"><tr><th></th>${Array.from({ length: cols }, (_, i) => `<th>${colName(i)}</th>`).join('')}</tr>`;
        rows.slice(0, MAXR).forEach((r, i) => { html += `<tr><td class="rh">${i + 1}</td>${Array.from({ length: cols }, (_, j) => `<td>${esc(r[j] ?? '')}</td>`).join('')}</tr>`; });
        html += '</table>' + (rows.length > MAXR ? `<div class="diff-note">${rows.length}행 중 ${MAXR}행까지 표시</div>` : '');
        box.innerHTML = html;
        box.querySelectorAll('[data-sheet]').forEach((b) => (b.onclick = () => show(b.dataset.sheet)));
        if (meta) meta.textContent = `${wb.SheetNames.length}개 시트 · ${rows.length}행`;
      };
      show(wb.SheetNames[0]);
    } else if (k === 'md') {
      await loadScript('marked.js');
      const txt = await (await fetch(url + '&text=1')).text();
      box.style.alignItems = 'flex-start';
      box.innerHTML = `<div class="md-body">${window.marked.parse(txt.replace(/<script[\s\S]*?<\/script>/gi, ''))}</div>`;
      box.querySelectorAll('.md-body script, .md-body iframe').forEach((x) => x.remove());
    } else {
      box.innerHTML = `<div class="diff-note">${icon('file')}<br>이 형식은 앱 안에서 미리볼 수 없어요.<br><br><button class="btn primary" data-ext>${icon('external')} 기본 앱으로 열기</button></div>`;
      box.querySelector('[data-ext]').onclick = () => openExternal(f);
    }
  } catch (e) {
    box.innerHTML = `<div class="diff-note">미리보기 실패: ${esc(e.message)}<br><br><button class="btn" data-ext>${icon('external')} 기본 앱으로 열기</button></div>`;
    box.querySelector('[data-ext]').onclick = () => openExternal(f);
  }
}

function closeDiff() {
  $('#diff-view').hidden = true;
  $('#diff-body').innerHTML = '';
  document.querySelectorAll('#detail .file.selected').forEach((e) => e.classList.remove('selected'));
}

// ================================================================ sidebar
function buildTree(items, nameOf) {
  const root = { dirs: new Map(), leaves: [] };
  for (const it of items) {
    const parts = nameOf(it).split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) { if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), leaves: [] }); node = node.dirs.get(p); }
    node.leaves.push({ it, label: parts[parts.length - 1] });
  }
  return root;
}
function trackHTML(t) {
  if (!t) return '';
  const a = t.match(/ahead (\d+)/), b = t.match(/behind (\d+)/);
  if (!a && !b) return '';
  return `<span class="ab" title="원격보다 ${a ? a[1] + '개 앞섬 ' : ''}${b ? b[1] + '개 뒤처짐' : ''}">${a ? `<span class="a">↑${a[1]}</span>` : ''}${b ? `<span class="b">↓${b[1]}</span>` : ''}</span>`;
}
function renderSidebar() {
  const q = $('#sb-filter').value.trim().toLowerCase();
  const head = S.info?.branch;
  const local = S.refs.filter((r) => r.type === 'branch');
  const remote = S.refs.filter((r) => r.type === 'remote');
  const tags = S.refs.filter((r) => r.type === 'tag').sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  const match = (r) => !q || r.name.toLowerCase().includes(q);
  const pad = (d) => `padding-left:${8 + d * 13}px`;
  const leaf = (r, label, d) => {
    const isHead = r.type === 'branch' && r.name === head;
    const wt = r.type === 'branch' && !isHead ? otherWorktree(r.name) : null;
    const ic = r.type === 'tag' ? 'tag' : isHead ? 'check' : wt ? 'layers' : 'branch';
    return `<div class="it${isHead ? ' head' : ''}${wt ? ' in-wt' : ''}${S.selected === r.sha ? ' selected' : ''}" style="${pad(d)}" data-ref="${esc(r.type)}:${esc(r.name)}" title="${esc(r.name)}${wt ? '\n다른 워크트리에서 사용 중: ' + esc(tilde(wt.path)) : ''}">${icon(ic)}<span class="nm">${escN(label)}</span>${wt ? `<span class="wt-tag">${esc(wt.path.split(/[\\/]/).pop())}</span>` : ''}${r.type === 'branch' ? trackHTML(r.track) : ''}</div>`;
  };
  const tree = (node, d, kp) => {
    let h = '';
    for (const [name, sub] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const key = kp + '/' + name, col = S.collapsed.has(key);
      h += `<div class="it folder${col ? ' collapsed' : ''}" style="${pad(d)}" data-fold="${esc(key)}"><span class="chev">${icon('chev-down')}</span><span class="nm">${esc(name)}</span></div>`;
      if (!col) h += tree(sub, d + 1, key);
    }
    for (const { it, label } of node.leaves.sort((a, b) => a.label.localeCompare(b.label))) h += leaf(it, label, d + 0.4);
    return h;
  };
  const sec = (key, title, ic, count, body) => {
    const col = S.collapsed.has('sec:' + key) && !q;
    return `<div class="sec${col ? ' collapsed' : ''}" data-fold="sec:${key}"><span class="chev">${icon('chev-down')}</span>${icon(ic)}${title}<span class="cnt">${count}</span></div>${col ? '' : body || '<div class="empty-it">없음</div>'}`;
  };
  let h = '';
  const ll = local.filter(match);
  h += sec('local', '로컬 브랜치', 'laptop', local.length, q ? ll.map((r) => leaf(r, r.name, 0.4)).join('') : tree(buildTree(ll, (r) => r.name), 0, 'local'));
  const byRemote = new Map();
  for (const r of remote.filter(match)) { const rn = r.name.split('/')[0]; if (!byRemote.has(rn)) byRemote.set(rn, []); byRemote.get(rn).push(r); }
  let rb = '';
  for (const [rn, list] of byRemote) {
    const key = 'remote/' + rn, col = S.collapsed.has(key) && !q;
    rb += `<div class="it folder${col ? ' collapsed' : ''}" style="${pad(0)}" data-fold="${esc(key)}"><span class="chev">${icon('chev-down')}</span>${icon('cloud')}<span class="nm" style="color:var(--text2)">${esc(rn)}</span></div>`;
    if (!col) rb += q ? list.map((r) => leaf(r, r.name.slice(rn.length + 1), 1.4)).join('') : tree(buildTree(list, (r) => r.name.slice(rn.length + 1)), 1, key);
  }
  h += sec('remote', '원격 브랜치', 'cloud', remote.length, rb);
  h += sec('tags', '태그', 'tag', tags.length, tags.filter(match).map((r) => leaf(r, r.name, 0.4)).join(''));
  const wts = S.meta.worktrees || [];
  h += sec('wt', '워크트리', 'layers', wts.length, wts.map((w) => `<div class="it" style="${pad(0.4)}" data-wt="${esc(w.path)}" title="${esc(w.path)}\n클릭: 이 워크트리를 탭으로 열기">${icon('layers')}<span class="nm">${esc(w.branch || w.path.split(/[\\/]/).pop())}</span><span class="ab">${esc(w.path.split(/[\\/]/).pop())}</span></div>`).join(''));
  h += `<div class="sec" title="git stash list"><span class="chev"></span>${icon('archive')}스태시<span class="cnt">${S.stashes}</span></div>`;
  $('#sb-body').innerHTML = h;

  // header
  $('#sb-repo-name').textContent = S.info?.name || '—';
  $('#sb-repo-path').innerHTML = S.info ? (S.info.worktree ? `<span class="wt-chip" title="${esc(tilde(S.info.main || ''))} 의 워크트리 — 브랜치를 둘러봐도 이 워크트리의 체크아웃은 바뀌지 않아요">${icon('layers')}워크트리</span>` : '') + esc(tilde(S.info.path)) : '';
  if (S.info && $('#sb-repo .repo-ic')?.dataset.repo !== S.info.path + P.repoLogos) { $('#sb-repo .repo-ic').outerHTML = logoHTML(S.info.path); $('#sb-repo .repo-ic').dataset.repo = S.info.path + P.repoLogos; }
  const cur = local.find((r) => r.name === head);
  $('#sb-branch').innerHTML = `${icon('branch')}<span class="nm">${esc(head || (S.info?.head ? 'detached ' + S.info.head.slice(0, 7) : '—'))}</span>${cur ? trackHTML(cur.track) : ''}${icon('chev-down')}`;
}
const findRef = (key) => { const i = key.indexOf(':'); const t = key.slice(0, i), n = key.slice(i + 1); return S.refs.find((r) => r.type === t && r.name === n); };

// ================================================================ tabs / bars
function saveTabs() { LS.set('tabs', S.tabs); LS.set('active', S.repo); }
function renderTabs() {
  $('#tab-list').innerHTML = S.tabs.map((t) => `<div class="tab${t === S.repo ? ' active' : ''}" data-tab="${esc(t)}" title="${esc(tilde(t))}">${logoHTML(t, 'repo-ic tab-ic')}<span>${escN(t.split(/[\\/]/).pop())}</span><span class="x" data-close="${esc(t)}">${icon('x')}</span></div>`).join('');
  document.title = S.info ? `${S.info.name} — Git Rising` : 'Git Rising';
}
function renderActions() {
  const cur = S.refs.find((r) => r.type === 'branch' && r.name === S.info?.branch);
  $('#tb-status').innerHTML = S.info ? `${icon('branch')} ${escN(S.info.branch || 'detached')}${cur ? ' ' + trackHTML(cur.track) : ''}${S.status.length ? ` · 변경 ${S.status.length}` : ''}` : '';
  $('[data-act=pop]').disabled = !S.stashes;
  $('[data-act=stash]').disabled = !S.status.length;
}
function renderBanner() {
  const b = $('#banner'), op = S.meta.op;
  if (!op) { b.hidden = true; return; }
  b.hidden = false;
  const name = { merge: '머지', rebase: '리베이스', 'cherry-pick': '체리픽', revert: '되돌리기' }[op] || op;
  const conflicts = S.status.filter((f) => f.status === 'U').length;
  b.innerHTML = `<b>${name} 진행 중</b>${conflicts ? `<span>충돌 파일 ${conflicts}개 — 해결하고 git add 한 뒤 [계속]</span>` : ''}<span class="grow"></span>
    ${op !== 'merge' ? `<button class="btn sm primary" data-banner="cont">계속</button>` : ''}<button class="btn sm" data-banner="abort">중단</button>`;
}
function renderStatusbar() {
  const live = $('#sb-live');
  live.classList.toggle('on', S.live);
  $('#sb-live-tx').textContent = S.live ? '실시간' : document.hidden ? '일시정지' : '연결 중';
  $('#sb-path').textContent = S.info ? tilde(S.info.path) : '';
  $('#sb-count').innerHTML = (S.solo ? `<button class="badge" id="solo-chip" title="클릭하면 필터 해제">${icon('branch')} ${esc(S.solo)} 만 보기 ✕</button> ` : '') + (S.commits.length ? `커밋 ${S.commits.length.toLocaleString()}${S.hasMore ? '+' : ''}` : '');
  $('#solo-chip')?.addEventListener('click', () => setSolo(null));
}

async function openTab(repo) {
  if (!S.tabs.includes(repo)) S.tabs.push(repo);
  S.repo = null;
  await loadRepo(repo, { open: true });
  if (S.repo && !S.tabs.includes(S.repo)) S.tabs.push(S.repo);
  saveTabs(); renderTabs();
}
function closeTab(repo) {
  termCloseRepo(repo);
  const i = S.tabs.indexOf(repo);
  S.tabs = S.tabs.filter((t) => t !== repo);
  if (repo === S.repo) {
    const next = S.tabs[Math.min(i, S.tabs.length - 1)];
    S.repo = null; S.es?.close(); S.es = null;
    if (next) loadRepo(next);
    else {
      S.info = null; S.commits = []; S.status = []; S.refs = []; S.refsBySha = new Map(); S.labelCache = new Map(); S.off = 0; S.L = new Layout(); S.detail = null;
      relayout(); renderSidebar(); renderDetail(); showEmpty(); S.live = false; renderStatusbar();
    }
  }
  saveTabs(); renderTabs();
}
async function pickRepo() { try { const r = await post('pick', {}, {}); if (r.path) openTab(r.path); } catch (e) { toast(e.message, 'err'); } }

// ================================================================ actions
const AUTH_RE = /permission denied \(publickey\)|authentication failed|could not read (username|password)|host key verification failed|terminal prompts disabled|repository not found|could not read from remote/i;
// Clicked origin/x while local x has commits of its own: don't guess — ask where to land.
function divergedChoice(d, args, label) {
  closeModal();
  const L = $('#modal-layer');
  L.hidden = false;
  L.innerHTML = `<div class="modal"><h3>${icon('alert')} ${d.behind ? `${esc(d.local)} 와 ${esc(d.remote)} 가 갈라져 있어요` : `로컬 ${esc(d.local)} 가 ${esc(d.remote)} 보다 앞서 있어요`}</h3>
    <p>로컬 ${esc(d.local)} 에만 있는 커밋 ${d.ahead}개 · ${esc(d.remote)} 에만 있는 커밋 ${d.behind}개\n어디로 갈까요?</p>
    <div class="choices">
      <button class="choice" data-c="detach">${icon('eye')}<span><b>${esc(d.remote)} 위치로 이동 (보기만)</b><small>브랜치는 건드리지 않고 그 커밋을 꺼냅니다 (detached)</small></span></button>
      <button class="choice" data-c="local">${icon('checkout')}<span><b>로컬 ${esc(d.local)} 로 전환</b><small>로컬 브랜치 위치 그대로 — 이후 풀/리베이스로 맞출 수 있어요</small></span></button>
      <button class="choice danger" data-c="reset">${icon('rotate')}<span><b>로컬 ${esc(d.local)} 을 ${esc(d.remote)} 과 똑같이</b><small>reset --hard — 로컬에만 있는 커밋 ${d.ahead}개가 사라집니다</small></span></button>
    </div><div class="btns"><button class="btn" id="m-cancel">취소</button></div></div>`;
  modalResolve = () => {};
  L.onmousedown = (e) => { if (e.target === L) closeModal(); };
  L.onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  $('#m-cancel').onclick = () => closeModal();
  L.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { closeModal(); run('checkout', { ...args, mode: b.dataset.c }, { label, force: true }); }));
  L.querySelector('[data-c]')?.focus();
}

// A branch can only be checked out in one worktree at a time (git rule).
const otherWorktree = (branch) => (S.meta.worktrees || []).find((w) => w.branch === branch && w.path !== S.info?.path);
async function worktreeChoice(branch, wtPath) {
  const sha = S.refs.find((r) => r.type === 'branch' && r.name === branch)?.sha;
  closeModal();
  const L = $('#modal-layer');
  L.hidden = false;
  L.innerHTML = `<div class="modal"><h3>${icon('layers')} '${esc(branch)}' 는 다른 워크트리에서 사용 중이에요</h3>
    <p>${esc(tilde(wtPath))}\n\ngit 은 같은 브랜치를 두 워크트리에서 동시에 체크아웃할 수 없어요. 어떻게 할까요?</p>
    <div class="choices">
      <button class="choice" data-c="open">${icon('external')}<span><b>그 워크트리를 탭으로 열기</b><small>${esc(wtPath.split(/[\\/]/).pop())} 에서 ${esc(branch)} 작업을 이어갑니다</small></span></button>
      ${sha ? `<button class="choice" data-c="detach">${icon('commit')}<span><b>여기서는 그 커밋만 보기 (detached)</b><small>${esc(branch)} 가 가리키는 ${sha.slice(0, 7)} 로 이동 — 브랜치는 그대로 둡니다</small></span></button>
      <button class="choice" data-c="branch">${icon('branch-plus')}<span><b>${esc(branch)} 에서 새 브랜치 만들기</b><small>같은 위치에서 다른 이름으로 작업합니다</small></span></button>` : ''}
    </div><div class="btns"><button class="btn" id="m-cancel">취소</button></div></div>`;
  modalResolve = () => {};
  L.onmousedown = (e) => { if (e.target === L) closeModal(); };
  L.onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  $('#m-cancel').onclick = () => closeModal();
  L.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => {
    closeModal();
    if (b.dataset.c === 'open') openTab(wtPath);
    if (b.dataset.c === 'detach') run('checkout', { ref: sha, kind: 'commit' }, { label: `${branch} 위치로 이동` });
    if (b.dataset.c === 'branch') newBranch(sha);
  }));
  L.querySelector('[data-c]')?.focus();
}

// In a worktree tab, switching branches changes what that worktree folder has checked out.
// A worktree is meant to stay on its branch, so never do it implicitly — ask.
async function worktreeGuard(args, label) {
  const name = args.kind === 'commit' ? args.ref.slice(0, 7) : args.ref;
  const wtName = S.info.path.split(/[\\/]/).pop(), mainName = (S.info.main || '').split(/[\\/]/).pop();
  closeModal();
  const L = $('#modal-layer');
  L.hidden = false;
  L.innerHTML = `<div class="modal"><h3>${icon('layers')} 이 탭은 워크트리예요</h3>
    <p>${esc(tilde(S.info.path))}\n현재 브랜치: ${esc(S.info.branch || 'detached')}\n\n여기서 전환하면 이 워크트리 폴더의 체크아웃이 ${esc(name)} 로 바뀝니다.</p>
    <div class="choices">
      ${S.info.main ? `<button class="choice" data-c="main">${icon('external')}<span><b>원래 저장소(${esc(mainName)})에서 전환</b><small>워크트리는 그대로 두고, 원래 저장소 탭을 열어 거기서 ${esc(name)} 로 전환합니다</small></span></button>` : ''}
      <button class="choice" data-c="view">${icon('eye')}<span><b>전환하지 않고 보기만</b><small>그래프에서 ${esc(name)} 위치로 이동만 합니다</small></span></button>
      <button class="choice" data-c="here">${icon('checkout')}<span><b>이 워크트리(${esc(wtName)})를 ${esc(name)} 로 전환</b><small>워크트리의 브랜치가 바뀝니다</small></span></button>
    </div><div class="btns"><button class="btn" id="m-cancel">취소</button></div></div>`;
  modalResolve = () => {};
  L.onmousedown = (e) => { if (e.target === L) closeModal(); };
  L.onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  $('#m-cancel').onclick = () => closeModal();
  L.querySelectorAll('[data-c]').forEach((b) => (b.onclick = async () => {
    closeModal();
    const c = b.dataset.c;
    if (c === 'here') run('checkout', args, { label, force: true });
    if (c === 'view') { const sha = args.kind === 'commit' ? args.ref : S.refs.find((r) => r.name === args.ref)?.sha; if (sha) selectCommit(sha); }
    if (c === 'main') { await openTab(S.info.main); run('checkout', args, { label, force: true }); }
  }));
  L.querySelector('[data-c]')?.focus();
}

/** @param {string} action @param {Record<string, any>} [args] @param {RunOptions} [opts] @returns {Promise<boolean>} */
async function run(action, args = {}, { label, quiet, noUndo, force } = {}) {
  if (action === 'checkout' && S.info?.worktree && P.worktreeGuard && !force && !quiet) { worktreeGuard(args, label); return false; }
  if (action === 'checkout' && args.kind !== 'commit') {
    const local = args.kind === 'remote' ? args.ref.slice(args.ref.indexOf('/') + 1) : args.ref;
    const wt = otherWorktree(local);
    if (wt) { worktreeChoice(local, wt.path); return false; }
  }
  const btn = document.querySelector(`[data-act="${action}"]`);
  btn?.classList.add('busy');
  const before = snapshotState();
  try {
    const r = await post('action', { repo: S.repo }, { action, args });
    const undo = noUndo ? null : undoFor(action, args, before);
    const warn = /^⚠/.test(r.output || '');
    if (!quiet || warn) toast(warn ? r.output.trim().slice(0, 900) : (label || action) + ' 완료' + (r.output?.trim() ? '\n' + r.output.trim().slice(-500) : ''), warn ? 'err' : 'ok',
      undo ? [{ label: '되돌리기 (⌘Z)', run: undo }] : []);
    S.lastUndo = undo ? { fn: undo, label: label || action, at: Date.now() } : S.lastUndo;
    return true;
  } catch (e) {
    const auth = AUTH_RE.test(e.message);
    if (e.message.startsWith('DIVERGED ')) { divergedChoice(JSON.parse(e.message.slice(9)), args, label); return false; }
    const wtm = e.message.match(/'([^']+)' is already (?:used by|checked out at) worktree at '([^']+)'/) || e.message.match(/'([^']+)' is already checked out at '([^']+)'/);
    if (wtm) { worktreeChoice(wtm[1], wtm[2]); return false; }
    const hint = /repository not found/i.test(e.message) ? '\n\n→ 원격 주소가 바뀌었거나, 이 저장소에 권한이 없는 계정/키로 접속했을 수 있어요.' : '';
    toast((label || action) + ' 실패\n' + e.message.slice(0, 900) + hint, 'err', auth ? [{ label: '원격 · 연결 설정', primary: true, run: () => openSettings('remote') }] : []);
    return false;
  } finally {
    btn?.classList.remove('busy');
    if (S.repo) loadRepo(S.repo, { keep: true });
  }
}

let modalResolve = null;
function closeModal(v = null) {
  const L = $('#modal-layer');
  if (L.hidden) return;
  L.hidden = true; L.innerHTML = ''; S.askId = null;
  const r = modalResolve; modalResolve = null; r?.(v);
}
/** @param {ModalOptions} opts @returns {Promise<null | { value?: string, raw?: string, text?: string, checked?: boolean }>} */
function modal({ title, text, input, inputType = 'text', inputValue = '', textarea, textareaValue = '', checkbox, ok = '확인', danger, wide, html }) {
  closeModal();
  return new Promise((resolve) => {
    modalResolve = resolve;
    const L = $('#modal-layer');
    L.hidden = false;
    L.innerHTML = `<div class="modal${wide ? ' wide' : ''}"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${html || ''}
      ${input ? `<input class="field" type="${inputType}" id="m-in" placeholder="${esc(input)}" value="${esc(inputValue)}" spellcheck="false" autocomplete="off">` : ''}
      ${textarea ? `<textarea class="field" id="m-ta" placeholder="${esc(textarea)}">${esc(textareaValue)}</textarea>` : ''}
      ${checkbox ? `<label class="chk"><input type="checkbox" id="m-cb" ${checkbox.checked ? 'checked' : ''}> ${esc(checkbox.label)}</label>` : ''}
      <div class="btns">${ok ? `<button class="btn" id="m-cancel">취소</button><button class="btn ${danger ? 'danger' : 'primary'}" id="m-ok">${esc(ok)}</button>` : '<button class="btn" id="m-cancel">닫기</button>'}</div></div>`;
    const submit = () => {
      const v = { value: $('#m-in')?.value.trim(), raw: $('#m-in')?.value, text: $('#m-ta')?.value.trim(), checked: $('#m-cb')?.checked };
      if (input && inputType !== 'password' && !v.value) return $('#m-in').focus();
      closeModal(v);
    };
    $('#m-cancel').onclick = () => closeModal(null);
    if ($('#m-ok')) $('#m-ok').onclick = submit;
    L.onmousedown = (e) => { if (e.target === L) closeModal(null); };
    L.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeModal(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && ok) { e.preventDefault(); submit(); }
    };
    setTimeout(() => ($('#m-in') || $('#m-ok') || $('#m-cancel')).focus(), 0);
  });
}

async function askpass(ev) {
  const p = ev.prompt;
  const isPass = /passphrase/i.test(p);
  const isYesNo = /\(yes\/no/i.test(p);
  const isUser = /^username/i.test(p.trim());
  const title = isPass ? 'SSH 키 암호' : isYesNo ? '처음 접속하는 서버예요' : isUser ? '사용자 이름' : '비밀번호 / 토큰';
  const r = await modal({
    title, text: p + (isYesNo ? '\n\n믿을 수 있는 서버면 yes 를 입력하세요.' : ''),
    input: isYesNo ? 'yes' : isUser ? 'username' : '••••••', inputType: isYesNo || isUser ? 'text' : 'password', inputValue: isYesNo ? 'yes' : '',
    checkbox: isPass && S.platform === 'darwin' ? { label: '키체인에 저장 — 다음부터 자동으로 입력', checked: true } : null, ok: '확인',
  });
  S.askId = ev.id;
  try {
    const res = await post('askpass/answer', {}, r ? { id: ev.id, value: r.raw ?? '', save: !!r.checked } : { id: ev.id, cancel: true });
    if (res.saved) toast('키체인에 저장했어요. 다음부터는 묻지 않아요.', 'ok');
  } catch {}
}

async function newBranch(sha) {
  const r = await modal({ title: '새 브랜치', text: `${sha === 'HEAD' ? '현재 위치' : sha.slice(0, 7)} 에서 브랜치를 만듭니다`, input: 'feature/my-branch', checkbox: { label: '만든 뒤 바로 전환', checked: true }, ok: '만들기' });
  if (r) run('branch', { name: r.value, sha, checkout: r.checked }, { label: `브랜치 ${r.value}` });
}
async function newTag(sha, annotated) {
  const r = await modal({ title: annotated ? '설명 있는 태그' : '태그', text: `${sha.slice(0, 7)} 에 태그를 답니다 (원격에 올리려면 git push --tags)`, input: 'v1.0.0', textarea: annotated ? '태그 메시지' : null, ok: '만들기' });
  if (r) run('tag', { name: r.value, sha, message: annotated ? r.text || r.value : undefined }, { label: `태그 ${r.value}` });
}
async function confirmRun(title, text, action, args, label, danger = true) {
  const r = await modal({ title, text, ok: '실행', danger });
  if (r) run(action, args, { label });
}
function resetTo(target, label, mode) {
  const cur = S.info?.branch || 'HEAD';
  const dirty = S.status.length ? `\n\n⚠ 지금 커밋 안 한 변경 ${S.status.length}개가 있어요.` : '';
  const desc = { soft: '이후 커밋의 변경은 스테이징 상태로 남습니다.', mixed: '이후 커밋의 변경은 작업 폴더에 남습니다.', hard: '이후 커밋과 커밋 안 한 변경이 모두 사라집니다. 되돌리기 어려워요.' }[mode];
  confirmRun(`${cur} → ${label} 리셋 (${mode})`, `git reset --${mode} ${label}\n${desc}${mode === 'hard' ? dirty : ''}`, 'reset', { sha: target, mode }, `리셋 ${mode}`, mode === 'hard');
}
function syncUpstream() {
  const cur = S.refs.find((r) => r.type === 'branch' && r.name === S.info?.branch);
  if (!cur?.upstream) return toast('현재 브랜치에 연결된 원격 브랜치가 없어요');
  confirmRun('원격과 똑같이 맞추기', `${cur.name} 를 ${cur.upstream} 와 완전히 같게 만듭니다.\ngit fetch && git reset --hard ${cur.upstream}\n\n로컬에만 있는 커밋과 커밋 안 한 변경이 사라져요.`, 'syncUpstream', {}, '원격과 맞추기');
}

const ACT = {
  fetch: () => run('fetch', { prune: P.fetchPrune }, { label: '가져오기' }),
  pull: () => run('pull', { mode: P.pullMode }, { label: '풀' }),
  push: async () => { if (P.confirmPush && !(await modal({ title: '푸시', text: `${S.info?.branch} 를 원격에 올릴까요?`, ok: '푸시' }))) return; run('push', {}, { label: '푸시' }); },
  newbranch: () => newBranch('HEAD'),
  stash: () => run('stash', { untracked: P.stashUntracked }, { label: '스태시' }),
  pop: () => run('pop', {}, { label: '스태시 꺼내기' }),
  terminal: () => termToggle(),
  extTerminal: () => run('terminal', {}, { quiet: true }),
  reveal: () => run('reveal', {}, { quiet: true }),
};

// ================================================================ context menus
function closeMenus() { $('#menu-layer').innerHTML = ''; }
/** @param {MenuItem[]} items @param {number} x @param {number} y */
function showMenu(items, x, y) {
  closeMenus();
  const build = (items, px, py, parent) => {
    const m = document.createElement('div');
    m.className = 'menu';
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { m.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); continue; }
      if (it.head) { m.insertAdjacentHTML('beforeend', `<div class="mhead">${esc(it.head)}</div>`); continue; }
      const el = document.createElement('div');
      el.className = 'mi' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
      const ic = it.icon || menuIcon(it);
      el.innerHTML = `${ic ? icon(ic) : '<span class="mi-pad"></span>'}<span>${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}${it.sub ? `<span class="sub-caret">${icon('chev-right')}</span>` : ''}`;
      if (it.tip) el.title = it.tip;
      el.onmouseenter = () => {
        m.querySelectorAll('.mi.open').forEach((o) => o.classList.remove('open'));
        m._sub?.remove(); m._sub = null;
        if (it.sub) { el.classList.add('open'); const r = el.getBoundingClientRect(); m._sub = build(it.sub, r.right + 2, r.top - 5, m); }
      };
      if (!it.sub) el.onclick = () => { closeMenus(); it.run(); };
      m.append(el);
    }
    $('#menu-layer').append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(px, innerWidth - r.width - 6)) + 'px';
    m.style.top = Math.max(4, Math.min(py, innerHeight - r.height - 6)) + 'px';
    if (parent && px + r.width > innerWidth) m.style.left = Math.max(4, parent.getBoundingClientRect().left - r.width - 2) + 'px';
    return m;
  };
  build(items, x, y);
}
function resetSub(target, label) {
  return [
    { label: 'Soft — 변경은 스테이징에 남김', hint: '--soft', run: () => resetTo(target, label, 'soft') },
    { label: 'Mixed — 변경은 작업 폴더에 남김', hint: '--mixed', run: () => resetTo(target, label, 'mixed') },
    { label: 'Hard — 변경까지 전부 버림', hint: '--hard', danger: true, run: () => resetTo(target, label, 'hard') },
  ];
}
function moveSub(sha) {
  const cur = S.info?.branch;
  const locals = S.refs.filter((r) => r.type === 'branch' && r.name !== cur && r.sha !== sha);
  if (!locals.length) return null;
  return {
    label: '다른 브랜치를 여기로 옮기기', hint: 'branch -f', tip: '체크아웃하지 않고 브랜치 포인터만 이 커밋으로 옮깁니다.',
    sub: locals.slice(0, 40).map((b) => ({ label: b.name, run: () => confirmRun('브랜치 옮기기', `${b.name} 를 ${sha.slice(0, 7)} 로 강제로 옮깁니다.\ngit branch -f ${b.name} ${sha.slice(0, 7)}`, 'moveBranch', { name: b.name, sha }, `${b.name} 이동`) })),
  };
}
function branchItems(ref) {
  const cur = S.info?.branch, name = ref.name;
  const isCur = ref.type === 'branch' && name === cur;
  /** @type {MenuItem[]} */
  const items = [];
  if (!isCur && cur && ref.type !== 'tag') {
    items.push({ label: `${cur} 를 ${name} 까지 빨리감기`, hint: 'merge --ff-only', tip: '갈라진 커밋이 있으면 실패 (안전)', run: () => run('ff', { ref: name }, { label: '빨리감기' }) });
    items.push({ label: `${name} 를 ${cur} 에 머지`, hint: 'merge', run: () => confirmRun('머지', `${name} → ${cur}`, 'merge', { ref: name }, '머지', false) });
    items.push({ label: `${cur} 를 ${name} 위로 리베이스`, hint: 'rebase', run: () => confirmRun('리베이스', `${cur} 의 커밋들을 ${name} 위로 옮깁니다. 이미 푸시했다면 강제 푸시가 필요해요.`, 'rebase', { ref: name }, '리베이스', false) });
  }
  if (!isCur && cur) items.push({ label: `${cur} 를 ${name} 로 리셋`, hint: 'reset', sub: resetSub(ref.type === 'tag' ? ref.sha : name, name) });
  if (items.length) items.push('-');
  if (!isCur) {
    const wt = ref.type === 'branch' ? otherWorktree(name) : null;
    if (wt) items.push({ label: `워크트리 열기 (${wt.path.split(/[\\/]/).pop()})`, icon: 'layers', tip: `${name} 는 이 워크트리에서 사용 중이에요: ${tilde(wt.path)}`, run: () => openTab(wt.path) });
    if (ref.type === 'branch') items.push({ label: `${name} 로 전환`, hint: 'checkout', run: () => run('checkout', { ref: name, kind: 'branch' }, { label: `${name} 전환` }) });
    else if (ref.type === 'remote') items.push({ label: `${name} 위치로 전환`, hint: 'checkout', tip: '같은 이름의 로컬 브랜치가 없으면 만들고, 뒤처져 있으면 원격 위치까지 빨리감기합니다. 갈라져 있으면 먼저 물어봐요.', run: () => run('checkout', { ref: name, kind: 'remote' }, { label: `${name} 전환` }) });
    else items.push({ label: `태그 ${name} 로 이동 (detached)`, hint: 'checkout', run: () => run('checkout', { ref: ref.sha, kind: 'commit' }, { label: '이동' }) });
  } else if (ref.upstream) items.push({ label: `원격과 똑같이 맞추기 (${ref.upstream})`, hint: 'reset --hard @{u}', danger: true, run: syncUpstream });
  items.push({ label: S.solo === name ? '모든 브랜치 보기' : '이 브랜치만 보기', hint: 'solo', tip: '그래프에 이 브랜치의 기록만 표시합니다', run: () => setSolo(S.solo === name ? null : name) });
  return items;
}
function deleteItems(ref) {
  const cur = S.info?.branch;
  if (ref.type === 'branch' && ref.name !== cur) return [{ label: `브랜치 ${ref.name} 삭제`, hint: 'branch -d', danger: true, run: async () => {
    const r = await modal({ title: `브랜치 삭제 · ${ref.name}`, text: '로컬 브랜치만 삭제합니다 (원격은 그대로).', checkbox: { label: '머지 안 된 커밋이 있어도 강제 삭제 (-D)', checked: false }, ok: '삭제', danger: true });
    if (r) run('deleteBranch', { name: ref.name, force: r.checked }, { label: `${ref.name} 삭제` });
  } }];
  if (ref.type === 'remote') return [{ label: `원격 브랜치 ${ref.name} 삭제`, hint: 'push --delete', danger: true, run: () => confirmRun('원격 브랜치 삭제', `원격에서 브랜치를 지웁니다 (다른 사람에게도 영향).\ngit push ${ref.name.split('/')[0]} --delete ${ref.name.slice(ref.name.indexOf('/') + 1)}`, 'deleteRemoteBranch', { ref: ref.name }, '원격 브랜치 삭제') }];
  if (ref.type === 'tag') return [{ label: `태그 ${ref.name} 삭제`, hint: 'tag -d', danger: true, run: () => confirmRun('태그 삭제', ref.name, 'deleteTag', { name: ref.name }, '태그 삭제') }];
  return [];
}
function commitMenu(c, ref) {
  const cur = S.info?.branch || 'HEAD', sha = c.sha, short = sha.slice(0, 7);
  const isHead = sha === S.info?.head;
  if (!ref) ref = refLabels(sha).find((r) => r.type !== 'tag') || null;
  /** @type {MenuItem[]} */
  const items = [{ head: `${short} · ${c.subject.slice(0, 48)}` }];
  if (ref) items.push(...branchItems(ref));
  if (!ref || ref.name === S.info?.branch) items.push({ label: `${cur} 를 이 커밋으로 리셋`, hint: 'reset', sub: resetSub(sha, short) });
  items.push({ label: '이 커밋으로 이동 (detached)', hint: 'checkout', disabled: isHead && !S.info?.branch, run: () => run('checkout', { ref: sha, kind: 'commit' }, { label: '이동' }) });
  items.push('-');
  items.push({ label: '여기서 새 브랜치', hint: 'branch', run: () => newBranch(sha) });
  items.push(moveSub(sha));
  items.push({ label: `${cur} 에 이 커밋 복사 (체리픽)`, hint: 'cherry-pick', disabled: isHead, run: () => confirmRun('체리픽', `${short} 의 변경을 ${cur} 에 새 커밋으로 적용합니다.`, 'cherrypick', { sha }, '체리픽', false) });
  items.push({ label: '이 커밋 취소하는 커밋 만들기', hint: 'revert', tip: '기록은 그대로, 반대 변경 커밋을 만듭니다 (푸시한 커밋에 안전)', run: () => confirmRun('되돌리기', `${short} 의 변경을 반대로 적용하는 새 커밋을 만듭니다.`, 'revert', { sha }, '되돌리기', false) });
  if (ref) { const del = deleteItems(ref); if (del.length) items.push('-', ...del); }
  items.push('-');
  if (ref) items.push({ label: '브랜치 이름 복사', run: () => copy(ref.name) });
  items.push({ label: 'SHA 복사', run: () => copy(sha) });
  const rn = (ref?.remotes?.[0] || ref?.name || '').split('/')[0];
  const web = S.meta.remotes?.[S.meta.remotes?.[rn] ? rn : 'origin'] || Object.values(S.meta.remotes || {})[0];
  if (web) {
    const rr = ref?.type === 'remote' ? ref.name : ref?.remotes?.[0];
    if (rr) items.push({ label: '브랜치 링크 복사', run: () => copy(`${web}/tree/${rr.slice(rr.indexOf('/') + 1)}`) });
    items.push({ label: '커밋 링크 복사', run: () => copy(`${web}/commit/${sha}`) });
  }
  items.push('-');
  items.push({ label: '여기에 태그', hint: 'tag', run: () => newTag(sha, false) });
  items.push({ label: '여기에 설명 있는 태그', hint: 'tag -a', run: () => newTag(sha, true) });
  return items;
}
function refMenu(ref) {
  const v = vIndex(ref.sha);
  if (v >= 0) return commitMenu(rowAt(v), ref);
  /** @type {MenuItem[]} */
  const items = [{ head: ref.name }, ...branchItems(ref)];
  const del = deleteItems(ref);
  if (del.length) items.push('-', ...del);
  items.push('-', { label: '브랜치 이름 복사', run: () => copy(ref.name) }, { label: 'SHA 복사', run: () => copy(ref.sha) });
  return items;
}
function branchChipMenu(x, y) {
  const cur = S.refs.find((r) => r.type === 'branch' && r.name === S.info?.branch);
  const locals = S.refs.filter((r) => r.type === 'branch' && r.name !== S.info?.branch);
  showMenu([
    { head: '현재 브랜치' },
    { label: '새 브랜치 만들기…', hint: 'checkout -b', run: () => newBranch('HEAD') },
    cur?.upstream ? { label: `원격과 똑같이 맞추기 (${cur.upstream})`, hint: 'reset --hard @{u}', danger: true, run: syncUpstream } : null,
    locals.length ? { label: '다른 브랜치로 리셋', hint: 'reset', sub: locals.slice(0, 40).map((b) => ({ label: b.name, sub: resetSub(b.name, b.name) })) } : null,
    '-',
    { head: '브랜치 전환' },
    ...locals.slice(0, 30).map((b) => ({ label: b.name, run: () => run('checkout', { ref: b.name, kind: 'branch' }, { label: `${b.name} 전환` }) })),
    locals.length > 30 ? { label: '더 보기… (⌘K)', run: () => openPalette('branches') } : null,
  ], x, y);
}

// ================================================================ find (full-history search)
function openFind() { $('#findbar').hidden = false; $('#find').focus(); $('#find').select(); }
function closeFind() { $('#find').placeholder = '메시지 · 작성자 · SHA (전체 히스토리)'; $('#findbar').hidden = true; if (S.find) { $('#find').value = ''; S.find = ''; S.findShas = []; S.findSet = new Set(); renderRows(); } $('#find-count').textContent = ''; }
const runFind = debounce(async () => {
  const q = $('#find').value.trim();
  S.find = q; S.findPos = -1;
  if (!q) { S.findShas = []; S.findSet = new Set(); $('#find-count').textContent = ''; renderRows(); return; }
  const lq = q.toLowerCase();
  const local = S.commits.filter((c) => c.subject.toLowerCase().includes(lq) || c.author.toLowerCase().includes(lq) || c.sha.startsWith(lq)).map((c) => c.sha);
  S.findShas = local; S.findSet = new Set(local);
  $('#find-count').textContent = `${local.length}…`;
  renderRows();
  try {
    const { shas } = await api('search', { repo: S.repo, q });
    if (S.find !== q) return;
    const order = (s) => (S.index.has(s) ? S.index.get(s) : 1e9);
    S.findShas = [...new Set([...local, ...shas])].sort((a, b) => order(a) - order(b));
    S.findSet = new Set(S.findShas);
    $('#find-count').textContent = S.findShas.length ? `0/${S.findShas.length}` : '없음';
    renderRows();
  } catch {}
}, 160);
async function findStep(dir) {
  if (!S.findShas.length) return;
  S.findPos = (S.findPos + dir + S.findShas.length) % S.findShas.length;
  $('#find-count').textContent = `${S.findPos + 1}/${S.findShas.length}`;
  await selectCommit(S.findShas[S.findPos]);
}

// ================================================================ command palette + repo finder
function fuzzy(q, s) {
  if (!q) return 0;
  q = q.toLowerCase(); const t = s.toLowerCase();
  const i0 = t.indexOf(q);
  if (i0 !== -1) return 100 - i0 + (i0 === 0 || /[\s/_.-]/.test(t[i0 - 1]) ? 50 : 0) - t.length * 0.05;
  let i = 0, score = 0, last = -2;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) { score += last === j - 1 ? 4 : 1; last = j; i++; }
  return i === q.length ? score - t.length * 0.05 : -1;
}
function hl(text, q) {
  text = nfc(text);
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i === -1 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
async function loadRepos(refresh) {
  try { S.repos = await api('repos', refresh ? { refresh: 1 } : {}); if (S.palette?.mode === 'repos' || S.palette?.mode === 'all') renderPalette(); }
  catch (e) { toast(e.message, 'err'); }
}
function actionItems() {
  const cur = S.refs.find((r) => r.type === 'branch' && r.name === S.info?.branch);
  const A = (title, ic, run, sub) => ({ title, icon: ic, run, sub });
  return [
    S.repo && A('가져오기', 'refresh', ACT.fetch, 'git fetch --all --prune'),
    S.repo && A('풀', 'down', ACT.pull, 'git pull'),
    S.repo && A('푸시', 'up', ACT.push, 'git push'),
    S.repo && A('새 브랜치', 'branch', ACT.newbranch, 'git checkout -b'),
    S.repo && cur?.upstream && A(`원격과 똑같이 맞추기 (${cur.upstream})`, 'rotate', syncUpstream, 'git reset --hard @{u}'),
    S.repo && A('스태시', 'archive', ACT.stash, 'git stash push -u'),
    S.repo && A('스태시 꺼내기', 'unarchive', ACT.pop, 'git stash pop'),
    S.repo && A('커밋 검색', 'search', openFind, '⌘F'),
    S.repo && A('내장 터미널 열기/닫기', 'terminal', ACT.terminal, '⌃`'),
    S.repo && A('외부 터미널 앱으로 열기', 'external', ACT.extTerminal),
    A('터미널 도우미 (oh-my-zsh 자동 업데이트 · 입력 예측)', 'terminal', () => openSettings('term')),
    S.repo && A('HEAD 로 이동', 'commit', () => S.info?.head && selectCommit(S.info.head), 'Shift+H'),
    S.lastUndo && A(`되돌리기: ${S.lastUndo.label}`, 'rotate', () => { const u = S.lastUndo; S.lastUndo = null; u.fn(); }, '⌘Z'),
    S.solo && A('모든 브랜치 보기 (필터 해제)', 'branch', () => setSolo(null)),
    A('단축키 보기', 'zap', showShortcuts, '?'),
    A('폴더 선택해서 열기…', 'folder', pickRepo),
    A('저장소 복제 (clone) — HTTPS / SSH 주소', 'cloud-down', cloneRepo),
    S.repo && A('원격 저장소 관리 (추가 · 주소 변경 · HTTPS↔SSH)', 'cloud', () => openSettings('remote')),
    A('저장소 다시 찾기', 'refresh', () => { loadRepos(true); openPalette('repos'); }, '홈 폴더를 다시 스캔'),
    A('SSH 설정 / 연결 확인', 'key', () => openSettings('ssh')),
    A('Claude 연결 (MCP)', 'bot', () => openSettings('mcp')),
    A('테마 전환 (라이트 / 다크)', S.themeName === 'dark' ? 'sun' : 'moon', toggleTheme),
    A('업데이트 확인', 'zap', () => post('update', {}, { action: 'check' }).catch(() => {})),
    A('설정', 'settings', () => openSettings()),
    A('설정 · 화면 (테마, 강조 색, 글자 크기)', 'monitor', () => openSettings('look')),
    A('설정 · 그래프 (아바타, 원격 브랜치, 컬럼)', 'graph', () => openSettings('graph')),
    A('설정 · Git 동작 (자동 가져오기, 풀 방식)', 'branch', () => openSettings('git')),
  ].filter(Boolean);
}
function openPalette(mode = 'all', q = '') {
  S.palette = { mode, sel: 0, items: [] };
  $('#palette-layer').hidden = false;
  const inp = $('#pl-input');
  inp.value = q;
  inp.placeholder = mode === 'repos' ? '저장소 이름이나 경로로 찾기…' : mode === 'branches' ? '전환할 브랜치…' : '저장소 · 브랜치 · 명령 찾기…';
  inp.focus();
  if (!S.repos) loadRepos(false);
  renderPalette();
}
function closePalette() { $('#palette-layer').hidden = true; S.palette = null; }
function renderPalette() {
  const P = S.palette; if (!P) return;
  const q = $('#pl-input').value.trim();
  const groups = [];
  const open = new Set(S.tabs);
  if (P.mode !== 'branches') {
    const repos = (S.repos?.repos || []).map((r) => ({ r, s: Math.max(fuzzy(q, r.name) * 2, fuzzy(q, r.path), ...(r.worktrees || []).map((w) => Math.max(fuzzy(q, w.name), fuzzy(q, w.branch || '')))) })).filter((x) => !q || x.s > 0);
    if (q) repos.sort((a, b) => b.s - a.s);
    const lim = P.mode === 'repos' ? 80 : q ? 8 : 5;
    groups.push({ title: P.mode === 'repos' ? `저장소 ${S.repos ? S.repos.repos.length + '개' : ''} · 최근 작업 순` : '저장소', items: repos.slice(0, lim).map(({ r }) => ({
      icon: 'folder', logo: r.path, html: hl(r.name, q), sub: tilde(r.path),
      right: `${r.worktrees?.length ? `<span class="badge" title="${esc(r.worktrees.map((w) => w.name + ' · ' + w.branch).join('\n'))}">워크트리 ${r.worktrees.length}</span>` : ''}${r.branch ? `<span class="br">${esc(r.branch)}</span>` : ''}${open.has(r.path) ? '<span class="open">● 열림</span>' : ''}<span>${r.activity ? relDate(r.activity / 1000) : ''}</span>`,
      run: () => openTab(r.path),
    })) });
  }
  if (P.mode !== 'repos' && S.repo) {
    const bs = S.refs.filter((r) => r.type === 'branch' || r.type === 'remote').map((r) => ({ r, s: fuzzy(q, r.name) })).filter((x) => !q || x.s > 0);
    if (q) bs.sort((a, b) => b.s - a.s);
    groups.push({ title: '브랜치로 전환', small: true, items: bs.slice(0, P.mode === 'branches' ? 100 : q ? 8 : 0).map(({ r }) => ({
      icon: r.type === 'remote' ? 'cloud' : 'branch', html: hl(r.name, q), right: r.name === S.info?.branch ? '<span class="open">현재</span>' : '',
      run: () => r.name !== S.info?.branch && run('checkout', { ref: r.name, kind: r.type }, { label: `${r.name} 전환` }),
    })) });
  }
  if (P.mode === 'all') {
    const acts = actionItems().map((a) => ({ a, s: fuzzy(q, a.title + ' ' + (a.sub || '')) })).filter((x) => !q || x.s > 0);
    if (q) acts.sort((a, b) => b.s - a.s);
    groups.push({ title: '명령', small: true, items: acts.slice(0, 30).map(({ a }) => ({ icon: a.icon, html: hl(a.title, q), right: a.sub ? `<span>${esc(a.sub)}</span>` : '', run: a.run })) });
  }
  P.items = groups.flatMap((g) => g.items);
  P.sel = Math.min(P.sel, Math.max(0, P.items.length - 1));
  let k = 0;
  const html = groups.filter((g) => g.items.length).map((g) => `<div class="pl-g">${esc(g.title)}</div>` + g.items.map((it) => {
    const i = k++;
    return `<div class="pl-it${g.small ? ' sm' : ''}${i === P.sel ? ' on' : ''}" data-pi="${i}">${it.logo ? logoHTML(it.logo, 'repo-ic pl-ic') : icon(it.icon)}<div class="tx"><span class="tt">${it.html}</span>${it.sub ? `<span class="ss">${esc(it.sub)}</span>` : ''}</div><div class="rt">${it.right || ''}</div></div>`;
  }).join('')).join('');
  $('#pl-list').innerHTML = html || `<div class="pl-empty">${S.repos ? '찾는 항목이 없어요' : '저장소를 찾는 중…'}</div>`;
  const R = S.repos;
  $('#pl-foot').innerHTML = P.mode === 'branches' ? '' : `${R ? `<span>${R.config.scanRoots.map(tilde).join(', ')} · 깊이 ${R.config.maxDepth} · ${R.scanning ? '찾는 중…' : relDate(R.scannedAt / 1000) + ' 스캔'}</span>` : '<span>저장소 찾는 중…</span>'}<span class="grow"></span><button data-pf="rescan">다시 찾기</button><button data-pf="roots">검색 위치 변경</button><button data-pf="pick">폴더 직접 선택</button>`;
}
function palMove(d) { const P = S.palette; if (!P?.items.length) return; P.sel = (P.sel + d + P.items.length) % P.items.length; $('#pl-list').querySelectorAll('.pl-it').forEach((el) => el.classList.toggle('on', +el.dataset.pi === P.sel)); $(`[data-pi="${P.sel}"]`)?.scrollIntoView({ block: 'nearest' }); }
function palRun(i) { const it = S.palette?.items[i]; if (!it) return; closePalette(); it.run(); }
async function cloneRepo() {
  const r = await modal({ title: '저장소 복제 (clone)', text: 'HTTPS / SSH 주소 모두 됩니다. 받을 위치는 다음 단계에서 고릅니다.', input: 'https://github.com/owner/repo.git  또는  git@github.com:owner/repo.git', ok: '위치 선택…' });
  if (!r) return;
  const pick = await post('pick', {}, {}).catch(() => ({}));
  if (!pick.path) return;
  toast(`복제 중…  ${r.value}\n→ ${tilde(pick.path)}`);
  try { const res = await post('clone', {}, { url: r.value, parent: pick.path }); toast('복제 완료', 'ok'); openTab(res.path); }
  catch (e) { toast('복제 실패\n' + e.message.slice(0, 800), 'err', AUTH_RE.test(e.message) ? [{ label: 'SSH · 원격 설정', primary: true, run: () => openSettings('ssh') }] : []); }
}
async function editRoots() {
  const cfg = S.repos?.config || { scanRoots: ['~'], maxDepth: 5 };
  const r = await modal({ title: '저장소 검색 위치', text: '한 줄에 하나씩. 이 폴더들 아래에서 git 저장소를 자동으로 찾아요.\n(node_modules, Library 같은 무거운 폴더는 건너뜁니다)', textarea: '~/Desktop', textareaValue: cfg.scanRoots.map(tilde).join('\n'), input: '깊이 (1-8)', inputValue: String(cfg.maxDepth), ok: '저장하고 다시 찾기' });
  if (!r) return;
  const roots = r.text.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^~/, home()));
  try { S.repos = await post('config', {}, { scanRoots: roots, maxDepth: +r.value || 5 }); toast(`저장소 ${S.repos.repos.length}개를 찾았어요`, 'ok'); openPalette('repos'); }
  catch (e) { toast(e.message, 'err'); }
}

// ================================================================ settings (SSH / MCP / update / theme)

function setPref(k, v) {
  P[k] = v; LS.set('prefs', P);
  if (['theme', 'accent', 'fontSize'].includes(k)) applyTheme();
  if (k === 'density' || k === 'avatars') { applyGeometry(); relayout(); }
  if (k === 'avatarPhotos' || k === 'gravatar') { AV.clear(); S.ver++; renderRows(); renderDetail(); }
  if (k === 'repoLogos') { renderTabs(); renderSidebar(); }
  if (k === 'aiUsage') startAi();
  if (['showRemotes', 'order'].includes(k) && S.repo) { S.labelCache = new Map(); setSolo(S.solo); }
  if (k === 'showTags') { S.labelCache = new Map(); S.ver++; renderRows(); }
  if (['colAuthor', 'colDate', 'colSha'].includes(k)) { applyCols(); S.ver++; renderRows(); }
  if (k === 'dateMode') { S.ver++; renderRows(); }
  if (k === 'termFont') for (const [, r] of T.byRepo) for (const t of r.list) { t.xt.options.fontSize = v; try { t.fit.fit(); } catch {} }
}
function applyGeometry() {
  ROW = DENSITY[P.density] || 24;
  LANE = P.avatars ? 24 : 14;
  NODE_R = P.avatars ? Math.min(9, ROW / 2 - 3) : ROW < 23 ? 3.5 : 4;
  document.documentElement.style.setProperty('--row', ROW + 'px');
  pool.forEach((el) => (el._v = -1));
  canvasSize = '';
}

const SET_SECTIONS = [
  ['look', 'monitor', '화면'], ['graph', 'graph', '그래프'], ['git', 'branch', 'Git 동작'], ['term', 'terminal', '터미널'],
  ['remote', 'cloud', '원격 · 연결'], ['ssh', 'key', 'SSH 인증'], ['repos', 'folder', '저장소 찾기'], ['mcp', 'bot', 'Claude 연결'], ['update', 'download', '업데이트'], ['keys', 'keyboard', '단축키'],
];
const optSeg = (k, opts) => `<div class="seg" data-seg="${k}">${opts.map(([v, l]) => `<button data-val="${esc(v)}" class="${String(P[k]) === String(v) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
const optToggle = (k) => `<button class="switch${P[k] ? ' on' : ''}" data-toggle="${k}" role="switch" aria-checked="${!!P[k]}"><span></span></button>`;
const optRow = (title, desc, control) => `<div class="opt"><div class="opt-tx"><div class="opt-t">${title}</div>${desc ? `<div class="opt-d">${desc}</div>` : ''}</div><div class="opt-c">${control}</div></div>`;

async function settingsBody(sec) {
  if (sec === 'look') return `
    ${optRow('테마', '시스템 설정을 따르거나 직접 고르세요', optSeg('theme', [['system', '시스템'], ['light', '라이트'], ['dark', '다크']]))}
    ${optRow('강조 색', '선택 · 버튼 · 링크 색', `<div class="swatches">${Object.entries(ACCENTS).map(([k, [d]]) => `<button class="sw${P.accent === k ? ' on' : ''}" data-accent="${k}" style="--c:${d}" title="${k}"></button>`).join('')}</div>`)}
    ${optRow('글자 크기', '', optSeg('fontSize', [[12, '작게'], [13, '보통'], [14, '크게'], [15, '아주 크게']]))}
    ${optRow('줄 간격', '커밋 목록 한 줄 높이', optSeg('density', [['compact', '촘촘'], ['normal', '보통'], ['comfy', '넉넉']]))}
    ${optRow('날짜 표시', '', optSeg('dateMode', [['relative', '3시간 전'], ['absolute', '26-11-13 10:58']]))}
    ${optRow('시작할 때 탭 복원', '지난번에 열어둔 저장소 탭을 다시 엽니다', optToggle('restoreTabs'))}`;
  if (sec === 'graph') return `
    ${optRow('작성자 아바타', '그래프의 점 대신 작성자 얼굴/이니셜을 표시', optToggle('avatars'))}
    ${optRow('프로필 사진 가져오기', 'GitHub 에서 커밋 작성자의 프로필 사진을 받아 캐시합니다 (gh 로그인 사용)', optToggle('avatarPhotos'))}
    ${optRow('Gravatar 도 사용', 'GitHub 에서 못 찾은 이메일은 Gravatar 에 물어봅니다 (이메일 해시가 전송돼요)', optToggle('gravatar'))}
    ${optRow('저장소 로고', '저장소 안의 로고 파일 → 없으면 GitHub 조직/소유자 이미지', optToggle('repoLogos'))}
    ${optRow('원격 브랜치 표시', '끄면 origin/* 은 그래프에서 숨김 (사이드바엔 그대로)', optToggle('showRemotes'))}
    ${optRow('태그 표시', '', optToggle('showTags'))}
    ${optRow('커밋 순서', '위상 순서는 브랜치가 덜 엉켜 보여요', optSeg('order', [['topo', '위상 순서'], ['date', '날짜 순서']]))}
    ${optRow('작성자 컬럼', '', optToggle('colAuthor'))}
    ${optRow('날짜 컬럼', '', optToggle('colDate'))}
    ${optRow('SHA 컬럼', '', optToggle('colSha'))}
    ${optRow('컬럼 너비 초기화', '헤더 경계를 드래그해 바꾼 너비를 되돌립니다', '<button class="btn sm" id="set-cols">초기화</button>')}`;
  if (sec === 'git') return `
    ${optRow('자동 가져오기', '주기적으로 fetch 해서 ↑↓ 를 최신으로 유지', optSeg('autoFetch', [[0, '끔'], [5, '5분'], [15, '15분'], [30, '30분']]))}
    ${optRow('가져올 때 정리 (prune)', '원격에서 지워진 브랜치를 로컬 목록에서도 지움', optToggle('fetchPrune'))}
    ${optRow('풀 방식', 'git 설정 기본값 / 머지 / 리베이스 / 빨리감기만', optSeg('pullMode', [['default', '기본'], ['merge', '머지'], ['rebase', '리베이스'], ['ff-only', 'FF만']]))}
    ${optRow('워크트리 보호', '워크트리 탭에서는 더블클릭으로 브랜치가 바뀌지 않고, 전환할 땐 먼저 물어봅니다', optToggle('worktreeGuard'))}
    ${optRow('스태시에 새 파일 포함', 'git stash -u', optToggle('stashUntracked'))}
    ${optRow('푸시 전에 확인', '', optToggle('confirmPush'))}
    <p class="opt-note">머지·리베이스·리셋·삭제는 항상 확인 창이 뜨고, 실행 후 토스트의 <b>되돌리기</b> 또는 <kbd>⌘Z</kbd> 로 취소할 수 있어요.</p>`;
  if (sec === 'term') {
    const st = await api('shelltools').catch(() => null);
    let tools = '';
    if (st?.shell === 'powershell') {
      tools = `<h4 class="set-h4">셸 도우미</h4>${optRow('예측 입력', '입력하는 동안 이전 명령을 흐리게 미리 보여줍니다 (PSReadLine)', st.prediction ? '<span class="badge ok">켜짐</span>' : '<button class="btn sm primary" data-sh=\'{"action":"psPrediction"}\'>켜기</button>')}`;
    } else if (st) {
      const plug = (name, title, desc) => { const p = st.plugins[name]; return optRow(title, desc, p.enabled ? '<span class="badge ok">켜짐</span>' : `<button class="btn sm primary" data-sh='{"action":"plugin","name":"${name}"}'>${p.installed ? '켜기' : '설치하고 켜기'}</button>`); };
      tools = `<h4 class="set-h4">셸 도우미 <small>${esc(st.shell)}</small></h4>
        ${st.omz ? optRow('oh-my-zsh 업데이트', '“자동” 으로 두면 터미널을 열 때 묻지 않고 알아서 업데이트합니다', `<div class="seg" id="omz-mode">${[['auto', '자동'], ['prompt', '물어보기'], ['reminder', '알림만'], ['disabled', '끔']].map(([v, l]) => `<button data-omz="${v}" class="${st.omzMode === v ? 'on' : ''}">${l}</button>`).join('')}</div>`) : ''}
        ${st.omz ? optRow('지금 업데이트', 'oh-my-zsh 와 추가 플러그인·테마를 지금 최신으로', '<button class="btn sm" data-sh=\'{"action":"omzUpdate"}\'>업데이트</button>') : ''}
        ${plug('zsh-autosuggestions', '입력 예측 (자동완성 제안)', '입력하는 동안 이전에 쓴 명령·경로를 흐리게 미리 보여줍니다 — → 키로 채택')}
        ${plug('zsh-syntax-highlighting', '명령 색상 표시', '입력 중인 명령이 올바른지 색으로 알려줍니다')}
        <div class="set-out" id="sh-out"></div>
        <p class="opt-note">이 설정들은 <code>~/.zshrc</code> 를 고칩니다. 처음 고칠 때 <code>~/.zshrc.git-rising.bak</code> 으로 원본을 남겨요. 외부 터미널에도 똑같이 적용됩니다.</p>`;
    }
    return `
    ${optRow('셸', '비워두면 기본 셸 ($SHELL / PowerShell)', `<input class="field" id="set-shell" style="width:220px;margin:0" placeholder="${S.platform === 'win32' ? 'C:\\\\...\\\\pwsh.exe' : '/bin/zsh'}" value="${esc(P.termShell)}">`)}
    ${optRow('글자 크기', '', optSeg('termFont', [[11, '11'], [12, '12'], [13, '13'], [14, '14']]))}
    ${optRow('외부 터미널', 'Terminal.app / Windows Terminal 로 열기', '<button class="btn sm" id="set-extterm">열기</button>')}${tools}`;
  }
  if (sec === 'remote') {
    const R = S.repo ? await api('remotes', { repo: S.repo }).catch(() => ({ remotes: [] })) : { remotes: [] };
    const rows = R.remotes.map((r) => `<div class="opt"><div class="opt-tx"><div class="opt-t">${icon('cloud')} ${esc(r.name)} <span class="badge">${r.kind.toUpperCase()}</span></div><div class="opt-d" style="font-family:var(--mono);word-break:break-all">${esc(r.url || '')}</div></div>
      <div class="opt-c">${r.kind === 'https' ? `<button class="btn sm" data-rm-act="remoteToSsh" data-rm="${esc(r.name)}">SSH 로</button>` : r.kind === 'ssh' ? `<button class="btn sm" data-rm-act="remoteToHttps" data-rm="${esc(r.name)}">HTTPS 로</button>` : ''}<button class="btn sm" data-rm-edit="${esc(r.name)}" data-url="${esc(r.url || '')}">주소 변경</button><button class="btn sm" data-rm-del="${esc(r.name)}">삭제</button></div></div>`).join('');
    return `<p class="opt-note"><b>HTTPS</b> 와 <b>SSH</b> 둘 다 그대로 됩니다. HTTPS 는 git 자격증명 도우미(gh, 키체인, Git Credential Manager)가 있으면 자동이고, 없으면 앱 안에 아이디·토큰 입력 창이 떠요. SSH 는 키로 인증합니다.</p>
      ${S.repo ? rows || '<p class="opt-note">이 저장소엔 원격이 없어요.</p>' : '<p class="opt-note">저장소를 열면 원격 목록이 보여요.</p>'}
      ${S.repo ? optRow('원격 추가', 'origin, upstream 등', '<button class="btn sm primary" id="rm-add">추가</button>') : ''}
      ${optRow('저장소 복제 (clone)', 'https:// 또는 git@ 주소로 새로 받아오기', '<button class="btn sm" id="rm-clone">복제…</button>')}
      <div class="set-out" id="rm-out"></div>`;
  }
  if (sec === 'ssh') {
    const ssh = await api('ssh').catch(() => ({ keys: [], agent: '' }));
    const keys = ssh.keys.map((k) => `<div class="opt"><div class="opt-tx"><div class="opt-t">${icon('key')} ${esc(k.name)}</div><div class="opt-d">${esc(k.type)} ${esc(k.comment)}</div></div><div class="opt-c"><button class="btn sm" data-sshadd="${esc(k.path)}">${S.platform === 'darwin' ? '키체인에 등록' : 'agent 에 등록'}</button></div></div>`).join('') || '<p class="opt-note">~/.ssh 에 키가 없어요. 터미널에서 <code>ssh-keygen -t ed25519</code> 로 만들 수 있어요.</p>';
    return `<p class="opt-note">암호가 필요하면 앱 안에 입력 창이 뜨고, 맥은 키체인에 저장해 다음부터 자동으로 인증됩니다.</p>${keys}
      <div class="opt"><div class="opt-tx"><div class="opt-t">에이전트에 등록된 키</div></div></div><div class="set-out">${esc(ssh.agent || '(없음)')}</div>
      ${optRow('연결 확인', 'ssh -T git@호스트', `<input class="field" id="ssh-host" value="github.com" style="width:140px;margin:0"><button class="btn sm primary" id="ssh-test">확인</button>`)}
      ${S.repo ? optRow('origin 을 SSH 주소로', 'https → git@ 형식으로 바꿔 매번 비밀번호 묻지 않게', '<button class="btn sm" id="ssh-convert">바꾸기</button>') : ''}
      <div class="set-out" id="ssh-out"></div>`;
  }
  if (sec === 'repos') {
    const R = S.repos || (await api('repos').catch(() => null));
    return `${optRow('검색 위치', esc((R?.config.scanRoots || ['~']).map(tilde).join(', ')) + ` · 깊이 ${R?.config.maxDepth || 5}`, '<button class="btn sm" id="set-roots">변경</button>')}
      ${optRow('다시 찾기', R ? `${R.repos.length}개 · ${relDate(R.scannedAt / 1000)} 스캔 · ${R.ms}ms` : '', '<button class="btn sm" id="set-rescan">지금 스캔</button>')}
      <p class="opt-note">node_modules, Library, 사진·음악 폴더처럼 무거운 곳은 건너뛰고, 10분이 지나면 백그라운드에서 다시 찾아요.</p>`;
  }
  if (sec === 'mcp') {
    const mcp = await api('mcp').catch(() => null);
    return `${optRow('AI 사용량을 상태바에 표시', 'Claude Code · Codex(GPT) 요금제 한도를 몇 % 썼는지 보여줍니다. 이 컴퓨터에 저장된 CLI 로그인 토큰을 읽어 각 회사 서버에만 물어봐요.', optToggle('aiUsage'))}
      <p class="opt-note">Claude 에게 “docca 레포 열어줘”, “develop 을 master 로 reset --hard 해줘”, “최근 커밋 요약해줘” 처럼 말하면 Git Rising 을 통해 실행해요.</p>
      ${mcp ? `${optRow('Claude Code 에 등록', 'claude mcp add 를 대신 실행합니다', '<button class="btn sm primary" id="mcp-add">등록</button>')}
      <div class="set-out">${esc(mcp.command)}</div>
      ${optRow('수동 설정', 'Claude Desktop 등 다른 MCP 클라이언트용', '<button class="btn sm" id="mcp-copy">명령 복사</button><button class="btn sm" id="mcp-json">JSON 복사</button>')}
      <div class="set-out" id="mcp-out"></div>
      <p class="opt-note">도구: list_repos · open_repo · repo_overview · list_branches · repo_log · show_commit · search_commits · git_action · set_scan_roots</p>` : '<p class="opt-note">설치된 앱(Git Rising.app)에서만 쓸 수 있어요.</p>'}`;
  }
  if (sec === 'update') {
    const st = await api('update').catch(() => ({}));
    return `${optRow('현재 버전', esc(S.version || ''), '<button class="btn sm primary" id="set-upd">업데이트 확인</button>')}
      <div class="set-out" id="upd-out">${esc(updateText(st))}</div>
      <p class="opt-note">앱이 6시간마다 GitHub Releases 를 확인하고, 새 버전이 있으면 아래 상태바에 알려줘요. 누르면 내려받아 바로 교체 후 재시작합니다.</p>`;
  }
  if (sec === 'keys') {
    const rows = [['⌘K', '명령 팔레트'], ['⌘O', '저장소 찾기'], ['⌘F', '커밋 검색'], ['⌘⌥F', '브랜치 필터'], ['↑ ↓ / j k', '커밋 이동'], ['Shift+H', 'HEAD 로'], ['Enter', '첫 파일 diff'], ['⌘Z', '되돌리기'], ['⌃`', '터미널'], ['⌘1–9', '탭 전환'], ['⌘W', '탭 닫기'], ['⌘R', '새로고침'], ['?', '단축키 도움말']];
    return `<div class="keys">${rows.map(([k, d]) => `<kbd>${esc(k)}</kbd><span>${esc(d)}</span>`).join('')}</div>`;
  }
  return '';
}
async function openSettings(section = 'look') {
  const L = $('#modal-layer');
  closeModal();
  L.hidden = false;
  L.innerHTML = `<div class="modal settings"><nav class="set-nav"><div class="set-title">${icon('settings')} 설정</div>${SET_SECTIONS.map(([k, ic, l]) => `<button data-sec="${k}">${icon(ic)}<span>${l}</span></button>`).join('')}<span class="grow"></span><div class="set-ver">Git Rising ${esc(S.version || '')}</div></nav><div class="set-main"><div class="set-head"><h3 id="set-h"></h3><button class="ib" id="set-close" title="닫기 (Esc)">${icon('x')}</button></div><div class="set-body" id="set-body"></div></div></div>`;
  modalResolve = () => {};
  L.onmousedown = (e) => { if (e.target === L) closeModal(); };
  L.onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  $('#set-close').onclick = () => closeModal();
  const show = async (sec) => {
    S.setSec = sec;
    L.querySelectorAll('[data-sec]').forEach((b) => b.classList.toggle('on', b.dataset.sec === sec));
    $('#set-h').textContent = SET_SECTIONS.find((x) => x[0] === sec)[2];
    $('#set-body').innerHTML = await settingsBody(sec);
    wireSettings(sec, show);
  };
  L.querySelectorAll('[data-sec]').forEach((b) => (b.onclick = () => show(b.dataset.sec)));
  show(SET_SECTIONS.some((x) => x[0] === section) ? section : 'look');
}
function wireSettings(sec, show) {
  const body = $('#set-body');
  const out = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  body.querySelectorAll('[data-seg]').forEach((g) => g.querySelectorAll('[data-val]').forEach((b) => (b.onclick = () => {
    const k = g.dataset.seg, raw = b.dataset.val;
    setPref(k, typeof PREF_DEF[k] === 'number' ? +raw : raw);
    g.querySelectorAll('[data-val]').forEach((x) => x.classList.toggle('on', x === b));
  })));
  body.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => { const k = b.dataset.toggle; setPref(k, !P[k]); b.classList.toggle('on', P[k]); }));
  body.querySelectorAll('[data-accent]').forEach((b) => (b.onclick = () => { setPref('accent', b.dataset.accent); body.querySelectorAll('[data-accent]').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#set-cols')?.addEventListener('click', () => { Object.assign(CW, COL_DEF); LS.set('cols', {}); relayout(); toast('컬럼 너비를 초기화했어요', 'ok'); });
  const shRun = async (payload, btn) => {
    const old = btn?.textContent; if (btn) { btn.textContent = '진행 중…'; btn.disabled = true; }
    try { const r = await post('shelltools', {}, payload); toast((r.output || '완료').trim(), 'ok'); await show('term'); }
    catch (e) { out('#sh-out', '✗ ' + e.message); if (btn) { btn.textContent = old; btn.disabled = false; } }
  };
  body.querySelectorAll('[data-sh]').forEach((b) => (b.onclick = () => shRun(JSON.parse(b.dataset.sh), b)));
  body.querySelectorAll('[data-omz]').forEach((b) => (b.onclick = () => shRun({ action: 'omzMode', mode: b.dataset.omz })));
  $('#set-shell')?.addEventListener('change', (e) => setPref('termShell', e.target.value.trim()));
  $('#set-extterm')?.addEventListener('click', () => S.repo && run('terminal', {}, { quiet: true, noUndo: true }));
  $('#ssh-test')?.addEventListener('click', async () => { out('#ssh-out', '연결 중…'); try { const r = await post('action', { repo: S.repo || home() }, { action: 'sshTest', args: { host: $('#ssh-host').value.trim() } }); out('#ssh-out', '✓ ' + r.output); } catch (e) { out('#ssh-out', '✗ ' + e.message); } });
  $('#ssh-convert')?.addEventListener('click', async () => { try { const r = await post('action', { repo: S.repo }, { action: 'remoteToSsh', args: { remote: 'origin' } }); out('#ssh-out', '✓ ' + r.output); } catch (e) { out('#ssh-out', e.message); } });
  body.querySelectorAll('[data-sshadd]').forEach((b) => (b.onclick = async () => { out('#ssh-out', '암호를 입력하세요…'); try { await post('action', { repo: S.repo || home() }, { action: 'sshAdd', args: { key: b.dataset.sshadd } }); out('#ssh-out', '✓ 등록했어요. 이제 자동으로 인증돼요.'); } catch (e) { out('#ssh-out', '✗ ' + e.message); } }));
  $('#set-roots')?.addEventListener('click', editRoots);
  const rmRun = async (action, args) => { try { const r = await post('action', { repo: S.repo }, { action, args }); toast((r.output || '완료').trim(), 'ok'); loadRepo(S.repo, { keep: true }); openSettings('remote'); } catch (e) { out('#rm-out', '✗ ' + e.message); } };
  body.querySelectorAll('[data-rm-act]').forEach((b) => (b.onclick = () => rmRun(b.dataset.rmAct, { remote: b.dataset.rm })));
  body.querySelectorAll('[data-rm-edit]').forEach((b) => (b.onclick = async () => { const r = await modal({ title: `${b.dataset.rmEdit} 주소 변경`, input: 'https://github.com/owner/repo.git', inputValue: b.dataset.url, ok: '변경' }); if (r) await rmRun('remoteSetUrl', { name: b.dataset.rmEdit, url: r.value }); else openSettings('remote'); }));
  body.querySelectorAll('[data-rm-del]').forEach((b) => (b.onclick = async () => { const r = await modal({ title: `원격 ${b.dataset.rmDel} 삭제`, text: '이 저장소의 원격 연결만 지웁니다 (서버의 저장소는 그대로).', ok: '삭제', danger: true }); if (r) await rmRun('remoteRemove', { name: b.dataset.rmDel }); else openSettings('remote'); }));
  $('#rm-add')?.addEventListener('click', async () => { const r = await modal({ title: '원격 추가', text: '첫 줄: 이름 (예: origin) · 아래: 주소 (https:// 또는 git@)', input: 'origin', inputValue: 'origin', textarea: 'https://github.com/owner/repo.git', ok: '추가' }); if (r && r.text) await rmRun('remoteAdd', { name: r.value, url: r.text }); else openSettings('remote'); });
  $('#rm-clone')?.addEventListener('click', cloneRepo);
  $('#set-rescan')?.addEventListener('click', async () => { $('#set-rescan').textContent = '찾는 중…'; await loadRepos(true); show('repos'); });
  $('#set-upd')?.addEventListener('click', async () => { out('#upd-out', '확인 중…'); const st = await post('update', {}, { action: 'check' }).catch((e) => ({ state: 'error', error: e.message })); out('#upd-out', updateText(st)); });
  if (sec === 'mcp' && $('#mcp-add')) {
    api('mcp').then((mcp) => {
      $('#mcp-copy').onclick = () => copy(mcp.command);
      $('#mcp-json').onclick = () => copy(JSON.stringify(mcp.json, null, 2));
    });
    $('#mcp-add').onclick = async () => { out('#mcp-out', '등록 중…'); try { const r = await post('mcp', {}, { action: 'install' }); out('#mcp-out', '✓ ' + r.output); } catch (e) { out('#mcp-out', '✗ ' + e.message); } };
  }
}

// icons for menu items, inferred from the git command hint
const HINT_ICON = { 'merge --ff-only': 'ff', merge: 'merge', rebase: 'rebase', reset: 'rotate', checkout: 'checkout', 'checkout --track': 'cloud-down', branch: 'branch-plus', 'branch -f': 'move', 'cherry-pick': 'cherry', revert: 'undo', 'branch -d': 'trash', 'push --delete': 'trash', 'tag -d': 'trash', tag: 'tag', 'tag -a': 'tag', solo: 'eye', '--soft': 'layers', '--mixed': 'file', '--hard': 'trash', 'reset --hard @{u}': 'cloud-down', 'checkout -b': 'branch-plus', 'log -- 파일': 'history' };
function menuIcon(it) {
  if (it.hint && HINT_ICON[it.hint]) return HINT_ICON[it.hint];
  const l = it.label || '';
  if (/링크/.test(l)) return 'link';
  if (/복사/.test(l)) return 'copy';
  if (/기본 앱/.test(l)) return 'external';
  if (/Finder|탐색기/.test(l)) return 'folder';
  if (/diff|미리보기/.test(l)) return 'eye';
  if (/전환/.test(l)) return 'checkout';
  return null;
}
const FILE_ICON = (() => {
  const m = {};
  const set = (exts, ic, color) => exts.split(' ').forEach((e) => (m[e] = [ic, color]));
  set('js mjs cjs jsx', 'file-code', '#e5c443'); set('ts tsx mts cts', 'file-code', '#4c8dff'); set('py', 'file-code', '#4b8bbe');
  set('go', 'file-code', '#29beb0'); set('rs', 'file-code', '#de7a4b'); set('java kt kts scala', 'file-code', '#e76f51');
  set('swift', 'file-code', '#f05138'); set('rb', 'file-code', '#cc342d'); set('php', 'file-code', '#8892bf');
  set('c h cpp hpp cc m mm', 'file-code', '#5c8dbc'); set('cs', 'file-code', '#9b4f96'); set('dart', 'file-code', '#40c4ff');
  set('html htm', 'file-code', '#e66b3b'); set('css scss sass less', 'file-code', '#7b6cff'); set('vue', 'file-code', '#41b883');
  set('svelte', 'file-code', '#ff3e00'); set('sql prisma graphql gql', 'file-code', '#e38c00');
  set('sh zsh bash fish ps1 bat cmd', 'terminal', '#89e051');
  set('json jsonc json5', 'file-json', '#e5c443'); set('yml yaml toml ini env conf', 'file-json', '#cb6b4b'); set('xml plist', 'file-json', '#8f9aa8');
  set('md mdx markdown rst', 'file-text', '#7fa7ff'); set('txt log', 'file-text', '#8f9aa8');
  set('png jpg jpeg gif webp bmp ico svg avif heic tiff psd ai fig sketch', 'file-image', '#c678dd');
  set('pdf', 'file-text', '#f2626b'); set('doc docx pages hwp hwpx rtf', 'file-text', '#4c8dff'); set('xls xlsx xlsm csv tsv numbers ods', 'file-sheet', '#3ec486');
  set('ppt pptx key', 'file-text', '#ff8a4c'); set('mp4 mov webm mkv avi m4v', 'file-video', '#ff7b5c'); set('mp3 wav ogg flac m4a aac', 'file-audio', '#f2b740');
  set('zip tar gz tgz rar 7z dmg exe pkg', 'file-archive', '#b08a5a'); set('lock', 'file-archive', '#6b7280');
  set('ttf otf woff woff2', 'file-text', '#9aa0aa');
  return m;
})();
function fileIcon(p) {
  const base = p.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('docker-compose')) return ['file-code', '#2496ed'];
  if (base === 'package.json') return ['file-json', '#cb3837'];
  if (base.startsWith('.git')) return ['branch', '#f05033'];
  if (base.startsWith('.env')) return ['key', '#e5c443'];
  return FILE_ICON[base.split('.').pop()] || ['file', 'var(--muted)'];
}

function updateText(s) {
  return { idle: '', checking: '확인 중…', latest: '최신 버전이에요 ✓', dev: '개발 모드에서는 업데이트를 확인하지 않아요', available: `새 버전 ${s.version} 이 있어요`, downloading: `내려받는 중… ${s.progress || 0}%`, ready: '설치 후 다시 시작합니다', error: '확인 실패: ' + (s.error || ''), unsupported: '이 환경에서는 지원하지 않아요' }[s.state] || s.state;
}
function updateState(s) {
  S.update = s;
  const b = $('#sb-update');
  if (s.state === 'available' || s.state === 'downloading' || s.state === 'ready') {
    b.hidden = false;
    b.textContent = s.state === 'available' ? `새 버전 ${s.version}` : s.state === 'downloading' ? `업데이트 ${s.progress || 0}%` : '재시작 중…';
  } else b.hidden = true;
  if ($('#upd-out')) $('#upd-out').textContent = updateText(s);
}

// ================================================================ theme
function applyTheme() {
  const pref = P.theme;
  const dark = pref === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : pref === 'dark';
  S.themeName = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = S.themeName;
  const cs = getComputedStyle(document.documentElement);
  const ac = ACCENTS[P.accent] || ACCENTS.indigo;
  document.documentElement.style.setProperty('--accent', dark ? ac[0] : ac[1]);
  document.documentElement.style.setProperty('--ui-font', P.fontSize + 'px');
  S.theme = { bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() };
  $('#sb-theme').innerHTML = icon(dark ? 'sun' : 'moon');
  for (const [, r] of T.byRepo) for (const t of r.list) t.xt.options.theme = termTheme();
  renderRows();
}
function toggleTheme() { setPref('theme', S.themeName === 'dark' ? 'light' : 'dark'); }

// ================================================================ tooltips (data-tip="설명|git 명령")
function bindTips() {
  const tip = $('#tip');
  let t;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    clearTimeout(t);
    if (!el) { tip.hidden = true; return; }
    t = setTimeout(() => {
      const [a, b] = el.dataset.tip.split('|');
      tip.innerHTML = esc(a) + (b ? `<code>${esc(b)}</code>` : '');
      tip.hidden = false;
      const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
      tip.style.left = Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - 6)) + 'px';
      tip.style.top = r.bottom + 6 + 'px';
    }, 350);
  });
}

// ================================================================ events
function bind() {
  const sc = $('#graph-scroll');
  sc.addEventListener('scroll', renderRows, { passive: true });
  new ResizeObserver(() => { canvasSize = ''; renderRows(); }).observe(sc);
  const rows = $('#rows');
  // hover (or click) the ref cell of a commit with several branches/tags → list them all
  rows.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.c-ref');
    if (!cell || !cell.querySelector('.more')) return;
    clearTimeout(refPopTimer);
    const row = cell.closest('.row');
    if ($('#refpop')?.dataset.v === row.dataset.v) return;
    refPopTimer = setTimeout(() => { showRefPop(row); const p = $('#refpop'); if (p) p.dataset.v = row.dataset.v; }, 280);
  });
  rows.addEventListener('mouseout', (e) => {
    if (!e.target.closest('.c-ref')) return;
    if (e.relatedTarget?.closest?.('#refpop, .c-ref')) return;
    clearTimeout(refPopTimer);
    refPopTimer = setTimeout(hideRefPop, 220);
  });
  rows.addEventListener('click', (e) => {
    const more = e.target.closest('.more'); if (!more) return;
    const row = more.closest('.row');
    showRefPop(row); const p = $('#refpop'); if (p) p.dataset.v = row.dataset.v;
  });
  sc.addEventListener('scroll', hideRefPop, { passive: true });
  rows.addEventListener('mousedown', (e) => { const r = e.target.closest('.row'); if (r && e.button === 0) { selectCommit(rowAt(+r.dataset.v).sha, { scroll: false }); sc.focus(); } });
  rows.addEventListener('dblclick', (e) => {
    const p = e.target.closest('[data-ref]'); if (!p) return;
    const ref = findRef(p.dataset.ref);
    if (S.info?.worktree && P.worktreeGuard) return; // a worktree stays on its branch: double-click only looks
    if (ref && ref.type !== 'tag' && !(ref.type === 'branch' && ref.name === S.info?.branch)) run('checkout', { ref: ref.name, kind: ref.type }, { label: `${ref.name} 전환` });
  });
  rows.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.row'); if (!r) return;
    e.preventDefault();
    const c = rowAt(+r.dataset.v); if (c.wip) return;
    selectCommit(c.sha, { scroll: false });
    const p = e.target.closest('[data-ref]');
    let ref = p ? findRef(p.dataset.ref) : null;
    if (ref?.type === 'branch') ref = refLabels(c.sha).find((l) => l.type === 'branch' && l.name === ref.name) || ref;
    showMenu(commitMenu(c, ref), e.clientX, e.clientY);
  });
  $('#detail').addEventListener('click', (e) => {
    const f = e.target.closest('.file'); if (f) return openDiff(+f.dataset.fi);
    const g = e.target.closest('[data-goto]'); if (g) return selectCommit(g.dataset.goto);
    const cp = e.target.closest('[data-copy]'); if (cp) return copy(cp.dataset.copy);
    const fv = e.target.closest('[data-fv]'); if (fv) { S.fileView = fv.dataset.fv; LS.set('fileView', S.fileView); renderDetail(); }
  });
  $('#detail').addEventListener('contextmenu', (e) => { const p = e.target.closest('[data-ref]'); if (!p) return; e.preventDefault(); const ref = findRef(p.dataset.ref); if (ref) showMenu(refMenu(ref), e.clientX, e.clientY); });
  $('#sb-body').addEventListener('click', (e) => {
    const fold = e.target.closest('[data-fold]');
    if (fold) { const k = fold.dataset.fold; S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k); LS.set('collapsed', [...S.collapsed]); return renderSidebar(); }
    const it = e.target.closest('[data-ref]'); if (it) { const ref = findRef(it.dataset.ref); if (ref) selectCommit(ref.sha); return; }
    const wt = e.target.closest('[data-wt]'); if (wt) openTab(wt.dataset.wt);
  });
  $('#sb-body').addEventListener('dblclick', (e) => {
    const it = e.target.closest('[data-ref]'); if (!it) return;
    const ref = findRef(it.dataset.ref);
    if (!ref || ref.type === 'tag' || (ref.type === 'branch' && ref.name === S.info?.branch)) return;
    if (S.info?.worktree && P.worktreeGuard) return; // already selected by the first click
    run('checkout', { ref: ref.name, kind: ref.type }, { label: `${ref.name} 전환` });
  });
  $('#sb-body').addEventListener('contextmenu', (e) => { const it = e.target.closest('[data-ref]'); if (!it) return; e.preventDefault(); const ref = findRef(it.dataset.ref); if (ref) showMenu(refMenu(ref), e.clientX, e.clientY); });
  $('#sb-filter').addEventListener('input', debounce(renderSidebar, 80));
  $('#sb-repo').onclick = () => openPalette('repos');
  $('#sb-branch').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); branchChipMenu(r.left, r.bottom + 4); };
  // tabs: click to switch, middle-click to close, drag to reorder
  let tabDrag = null;
  $('#tab-list').addEventListener('mousedown', (e) => {
    const x = e.target.closest('[data-close]'); if (x) { e.stopPropagation(); return closeTab(x.dataset.close); }
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    if (e.button === 1) return closeTab(t.dataset.tab);
    if (e.button === 0) tabDrag = { path: t.dataset.tab, x: e.clientX, moved: false };
  });
  addEventListener('mousemove', (e) => {
    if (!tabDrag) return;
    if (!tabDrag.moved && Math.abs(e.clientX - tabDrag.x) < 6) return;
    tabDrag.moved = true;
    document.body.classList.add('tab-dragging');
    const over = [...document.querySelectorAll('#tab-list [data-tab]')].find((el) => { const r = el.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right; });
    if (over && over.dataset.tab !== tabDrag.path) {
      const from = S.tabs.indexOf(tabDrag.path), to = S.tabs.indexOf(over.dataset.tab);
      const r = over.getBoundingClientRect(), mid = r.left + r.width / 2;
      // only swap once the pointer passes the neighbour's middle → no flicker between two tabs of different width
      if ((from < to && e.clientX > mid) || (from > to && e.clientX < mid)) {
        S.tabs.splice(to, 0, S.tabs.splice(from, 1)[0]);
        renderTabs();
      }
    }
    document.querySelectorAll('#tab-list [data-tab]').forEach((el) => el.classList.toggle('dragging', el.dataset.tab === tabDrag.path));
  });
  addEventListener('mouseup', () => {
    if (!tabDrag) return;
    const d = tabDrag; tabDrag = null;
    document.body.classList.remove('tab-dragging');
    if (d.moved) { saveTabs(); renderTabs(); return; }
    if (d.path !== S.repo) loadRepo(d.path).then(() => { saveTabs(); renderTabs(); });
  });
  $('#tab-add').innerHTML = icon('plus');
  $('#tab-add').onclick = () => openPalette('repos');
  $('#cmdk').onclick = () => openPalette('all');
  document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => S.repo && ACT[b.dataset.act]()));
  $('#banner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-banner]'); if (!b) return;
    if (b.dataset.banner === 'abort') confirmRun('작업 중단', `진행 중인 ${S.meta.op} 을 취소하고 시작 전 상태로 되돌립니다.`, 'abort', { op: S.meta.op }, '중단');
    else run('cont', { op: S.meta.op }, { label: '계속' });
  });
  $('#find').addEventListener('input', runFind);
  $('#find').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { closeFind(); sc.focus(); } });
  $('#find-next').onclick = () => findStep(1);
  $('#find-prev').onclick = () => findStep(-1);
  $('#find-close').onclick = closeFind;
  $('#pl-input').addEventListener('input', () => { S.palette.sel = 0; renderPalette(); });
  $('#pl-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
    if (e.key === 'Enter') { e.preventDefault(); palRun(S.palette.sel); }
    if (e.key === 'Escape') closePalette();
  });
  $('#pl-list').addEventListener('click', (e) => { const it = e.target.closest('[data-pi]'); if (it) palRun(+it.dataset.pi); });
  $('#pl-list').addEventListener('mousemove', (e) => { const it = e.target.closest('[data-pi]'); if (it && +it.dataset.pi !== S.palette.sel) { S.palette.sel = +it.dataset.pi; $('#pl-list').querySelectorAll('.pl-it').forEach((el) => el.classList.toggle('on', el === it)); } });
  $('#pl-foot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pf]'); if (!b) return;
    if (b.dataset.pf === 'rescan') { S.repos && (S.repos.scanning = true); renderPalette(); loadRepos(true); }
    if (b.dataset.pf === 'roots') { closePalette(); editRoots(); }
    if (b.dataset.pf === 'pick') { closePalette(); pickRepo(); }
  });
  $('#palette-layer').addEventListener('mousedown', (e) => { if (e.target.id === 'palette-layer') closePalette(); });
  $('#sb-theme').onclick = toggleTheme;
  $('#sb-ai').onclick = aiPopover;
  $('#sb-settings').onclick = () => openSettings();
  $('#sb-update').onclick = async () => {
    if (S.update?.state !== 'available') return;
    const r = await modal({ title: `새 버전 ${S.update.version}`, text: (S.update.notes || '').slice(0, 800) || '업데이트를 설치하고 다시 시작할까요?', ok: '업데이트하고 재시작' });
    if (r) post('update', {}, { action: 'install' });
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  // drop a folder anywhere → open it as a tab
  document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (e) => {
    document.body.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0]; if (!f) return;
    e.preventDefault();
    const p = window.gr?.pathForFile(f);
    if (p) openTab(p); else toast('폴더 경로를 읽을 수 없어요');
  });
  $('#detail').addEventListener('contextmenu', (e) => {
    const f = e.target.closest('.file'); if (!f) return;
    e.preventDefault();
    const file = S.detailFiles[+f.dataset.fi];
    showMenu([
      { head: file.path },
      { label: '변경 내용 / 미리보기', run: () => openDiff(+f.dataset.fi) },
      { label: '이 파일의 기록 보기', hint: 'log -- 파일', tip: '이 파일을 바꾼 커밋만 그래프에서 강조합니다', run: () => fileHistory(file.path) },
      '-',
      { label: '기본 앱으로 열기', run: () => openExternal(file) },
      { label: S.platform === 'win32' ? '탐색기에서 보기' : 'Finder 에서 보기', run: () => run('showItem', { path: file.path }, { quiet: true, noUndo: true }) },
      { label: '경로 복사', run: () => copy(file.path) },
      { label: '전체 경로 복사', run: () => copy(S.info.path + '/' + file.path) },
    ], e.clientX, e.clientY);
  }, true);
  let lastAuto = Date.now();
  setInterval(() => {
    if (!P.autoFetch || !S.repo || document.hidden || Date.now() - lastAuto < P.autoFetch * 60000) return;
    lastAuto = Date.now();
    post('action', { repo: S.repo }, { action: 'fetch', args: { prune: P.fetchPrune } }).catch(() => {});
  }, 30000);

  document.addEventListener('mousedown', (e) => { if (!e.target.closest?.('.menu')) closeMenus(); if (!e.target.closest?.('#refpop, .more')) hideRefPop(); });
  window.addEventListener('blur', closeMenus);
  document.addEventListener('keydown', (e) => {
    if (!$('#modal-layer').hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); S.repo && termToggle(); return; }
    if (document.activeElement?.closest?.('.xterm')) return; // keys belong to the terminal
    if (mod && e.key === 'k') { e.preventDefault(); S.palette ? closePalette() : openPalette('all'); return; }
    if (mod && (e.key === 'o' || e.key === 'p')) { e.preventDefault(); openPalette('repos'); return; }
    if (S.palette) return;
    if (mod && e.altKey && e.code === 'KeyF') { e.preventDefault(); $('#sb-filter').focus(); return; }
    if (mod && e.key === 'f') { e.preventDefault(); openFind(); return; }
    if (mod && e.key === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); if (S.lastUndo) { const u = S.lastUndo; S.lastUndo = null; u.fn(); } else toast('되돌릴 작업이 없어요'); return; }
    if (mod && e.key === 'r') { e.preventDefault(); S.repo && loadRepo(S.repo, { keep: true }); return; }
    if (mod && e.key === 'w') { e.preventDefault(); S.repo && closeTab(S.repo); return; }
    if (mod && /^[1-9]$/.test(e.key)) { const t = S.tabs[+e.key - 1]; if (t && t !== S.repo) loadRepo(t).then(saveTabs).then(renderTabs); e.preventDefault(); return; }
    if (e.key === 'Escape') { if ($('#menu-layer').children.length) closeMenus(); else if (!$('#diff-view').hidden) closeDiff(); else if (!$('#findbar').hidden) closeFind(); return; }
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if (e.key === '?') { showShortcuts(); return; }
    if (e.key === 'H') { if (S.info?.head) selectCommit(S.info.head); return; }
    if (e.key === 'Enter' && S.selected && S.detailFiles?.length) { openDiff(0); return; }
    const v = vIndex(S.selected);
    const go = (n) => { n = Math.max(0, Math.min(viewLen() - 1, n)); if (viewLen()) selectCommit(rowAt(n).sha); };
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(v < 0 ? 0 : v + 1); }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(v < 0 ? 0 : v - 1); }
    if (e.key === 'PageDown') { e.preventDefault(); go(v + Math.floor(sc.clientHeight / ROW)); }
    if (e.key === 'PageUp') { e.preventDefault(); go(v - Math.floor(sc.clientHeight / ROW)); }
  });
  document.querySelectorAll('.resizer').forEach((rz) => {
    const target = $('#' + rz.dataset.target);
    const saved = LS.get('w.' + rz.dataset.target);
    if (saved) target.style.width = saved + 'px';
    rz.onmousedown = (e) => {
      e.preventDefault(); rz.classList.add('drag');
      const sx = e.clientX, sw = target.offsetWidth, sign = rz.dataset.target === 'sidebar' ? 1 : -1;
      const mv = (ev) => { target.style.width = Math.max(170, sw + sign * (ev.clientX - sx)) + 'px'; };
      const up = () => { rz.classList.remove('drag'); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); LS.set('w.' + rz.dataset.target, target.offsetWidth); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    };
  });
}




// ================================================================ AI usage in the status bar (opt-in)
const AI = { data: null, timer: null };
async function refreshAi(force) {
  if (!P.aiUsage) { $('#sb-ai').hidden = true; return; }
  try { AI.data = await api('aiusage', force ? { force: 1 } : {}); } catch { return; }
  renderAi();
}
const aiLevel = (p) => (p >= 90 ? 'hot' : p >= 70 ? 'warm' : '');
function resetText(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return '곧 초기화';
  const h = ms / 3600000;
  return h < 1 ? `${Math.ceil(ms / 60000)}분 뒤 초기화` : h < 48 ? `${Math.round(h)}시간 뒤 초기화` : `${Math.round(h / 24)}일 뒤 초기화`;
}
function renderAi() {
  const el = $('#sb-ai');
  const ps = AI.data?.providers || [];
  el.hidden = !P.aiUsage || !ps.length;
  if (el.hidden) return;
  el.innerHTML = ps.map((p) => {
    if (p.state !== 'ok') return `<span class="ai-p" title="${esc(p.name)}: ${p.state === 'expired' ? '로그인이 만료됐어요 — CLI 를 한 번 실행하면 갱신됩니다' : esc(p.error || '확인 실패')}">${icon('bot')}${esc(p.name)} <span class="ai-off">${p.state === 'expired' ? '만료' : '?'}</span></span>`;
    if (!p.windows.length) return `<span class="ai-p">${icon('bot')}${esc(p.name)} <span class="ai-off">0%</span></span>`;
    return `<span class="ai-p">${icon('bot')}${esc(p.name)}${p.windows.slice(0, 2).map((w) => `<span class="ai-w ${aiLevel(w.pct)}" title="${esc(p.name)} ${esc(w.label)} 한도의 ${w.pct}% 사용 · ${esc(resetText(w.resetsAt))}"><i>${esc(w.label)}</i><span class="ai-bar"><b style="width:${w.pct}%"></b></span>${w.pct}%</span>`).join('')}</span>`;
  }).join('');
}
function aiPopover() {
  const ps = AI.data?.providers || [];
  const r = $('#sb-ai').getBoundingClientRect();
  showMenu([
    { head: `AI 사용량 · ${AI.data ? relDate(AI.data.at / 1000) : ''} 확인` },
    ...ps.flatMap((p) => p.state !== 'ok'
      ? [{ label: `${p.name} — ${p.state === 'expired' ? '로그인 만료 (CLI 를 한 번 실행하세요)' : '확인 실패'}`, icon: 'bot', disabled: true, run() {} }]
      : [{ head: `${p.name}${p.plan ? ' · ' + p.plan : ''}` }, ...(p.windows.length ? p.windows : [{ label: '사용량', pct: 0 }]).map((w) => ({ label: `${w.label}  ${w.pct}%`, hint: resetText(w.resetsAt), icon: 'zap', run() {} }))]),
    '-',
    { label: '지금 새로고침', icon: 'refresh', run: () => refreshAi(true) },
    { label: '상태바에서 숨기기', icon: 'eye', run: () => setPref('aiUsage', false) },
  ], r.left, r.top - 8 - 30 * (ps.length * 3 + 3));
}
function startAi() {
  clearInterval(AI.timer);
  if (!P.aiUsage) { $('#sb-ai').hidden = true; return; }
  refreshAi();
  AI.timer = setInterval(() => { if (!document.hidden) refreshAi(); }, 5 * 60 * 1000);
}

// ================================================================ undo / filters / help
function snapshotState() {
  const branches = new Map(S.refs.filter((r) => r.type === 'branch').map((r) => [r.name, r.sha]));
  const tags = new Set(S.refs.filter((r) => r.type === 'tag').map((r) => r.name));
  return { head: S.info?.head, branch: S.info?.branch, branches, tags, dirty: S.status.length };
}
// Returns a function that reverses `action`, or null when it can't be undone safely.
function undoFor(action, args, b) {
  if (!b.head) return null;
  const back = async (steps, label) => {
    for (const [a, x] of steps) { const ok = await run(a, x, { quiet: true, noUndo: true }); if (!ok) return; }
    toast(`되돌렸어요: ${label}`, 'ok');
  };
  const backTo = () => (b.branch ? ['checkout', { ref: b.branch, kind: 'branch' }] : ['checkout', { ref: b.head, kind: 'commit' }]);
  switch (action) {
    case 'checkout': return () => back([backTo()], '브랜치 전환');
    case 'reset': case 'merge': case 'ff': case 'rebase': case 'cherrypick': case 'revert': case 'pull': case 'syncUpstream':
      // --keep moves HEAD back but refuses to clobber uncommitted changes
      return () => back([['reset', { sha: b.head, mode: 'keep' }]], action);
    case 'moveBranch': return b.branches.has(args.name) ? () => back([['moveBranch', { name: args.name, sha: b.branches.get(args.name) }]], '브랜치 이동') : null;
    case 'deleteBranch': return b.branches.has(args.name) ? () => back([['branch', { name: args.name, sha: b.branches.get(args.name), checkout: false }]], '브랜치 삭제') : null;
    case 'branch': return () => back([...(args.checkout ? [backTo()] : []), ['deleteBranch', { name: args.name, force: true }]], '브랜치 생성');
    case 'tag': return () => back([['deleteTag', { name: args.name }]], '태그 생성');
    case 'stash': return () => back([['pop', {}]], '스태시');
    default: return null;
  }
}
function setSolo(name) {
  S.solo = name;
  S.selected = null; S.detail = null;
  $('#graph-scroll').scrollTop = 0;
  const repo = S.repo;
  setLoading('불러오는 중…');
  api('log', { repo, limit: 600, ...logParams() }).then((log) => {
    if (repo !== S.repo) return;
    S.commits = log.commits; S.hasMore = log.hasMore;
    rebuild(); renderDetail(); renderStatusbar();
  }).catch((e) => toast(e.message, 'err')).finally(() => setLoading(''));
}
async function fileHistory(p) {
  closeDiff();
  openFind();
  $('#find').value = '';
  S.find = '파일: ' + p;
  $('#find').placeholder = '파일 기록: ' + p;
  const { shas } = await api('filelog', { repo: S.repo, path: p });
  S.findShas = shas; S.findSet = new Set(shas); S.findPos = -1;
  $('#find-count').textContent = shas.length ? `0/${shas.length}` : '없음';
  renderRows();
  if (shas.length) findStep(1);
}
function showShortcuts() {
  const rows = [
    ['⌘K', '명령 팔레트 (저장소 · 브랜치 · 명령)'], ['⌘O', '저장소 찾기 / 열기'], ['⌘F', '커밋 검색 (전체 히스토리)'], ['⌘⌥F', '브랜치 필터'],
    ['↑ ↓ / j k', '커밋 이동'], ['PageUp / PageDown', '한 화면씩 이동'], ['Shift+H', 'HEAD 로 이동'], ['Enter', '첫 번째 파일 diff 열기'],
    ['⌘Z', '방금 한 작업 되돌리기'], ['⌃`', '내장 터미널 열기 / 닫기'], ['⌘1 – ⌘9', '탭 전환'], ['⌘W', '탭 닫기'], ['⌘R', '새로고침'], ['Esc', '닫기'],
    ['더블클릭 (브랜치)', '그 브랜치로 전환'], ['우클릭', '커밋 / 브랜치 / 파일 작업'], ['폴더 드래그', '저장소 열기'], ['헤더 경계 드래그', '컬럼 너비 (더블클릭: 기본값)'],
  ];
  modal({ title: '단축키', ok: null, html: `<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin-bottom:8px">${rows.map(([k, d]) => `<kbd style="justify-self:start">${esc(k)}</kbd><span>${esc(d)}</span>`).join('')}</div>` });
}

// ================================================================ embedded terminal (xterm.js + node-pty)
const T = { byRepo: new Map(), seq: 0, ready: null };
function termTheme() {
  const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
  return { background: v('--panel'), foreground: v('--text'), cursor: v('--accent'), selectionBackground: v('--sel'), black: '#3b3f47', brightBlack: '#5b616c' };
}
function ensureXterm() {
  return (T.ready ||= (async () => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/vendor/xterm.css'; document.head.append(l);
    await loadScript('xterm.js'); await loadScript('xterm-fit.js');
  })());
}
const repoTerms = (repo = S.repo) => { if (!T.byRepo.has(repo)) T.byRepo.set(repo, { list: [], active: null }); return T.byRepo.get(repo); };
async function termNew() {
  if (!S.repo) return;
  await ensureXterm();
  const repo = S.repo, R = repoTerms(repo);
  const el = document.createElement('div');
  el.className = 'term-inst';
  $('#term-body').append(el);
  const xt = new window.Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'), fontSize: P.termFont, lineHeight: 1.15, cursorBlink: true, scrollback: 8000, theme: termTheme(), allowProposedApi: true, macOptionIsMeta: true });
  const fit = new window.FitAddon.FitAddon();
  xt.loadAddon(fit);
  xt.open(el);
  try { fit.fit(); } catch {}
  const t = { id: ++T.seq, repo, el, xt, fit, title: '터미널 ' + (R.list.length + 1), alive: true };
  const ws = new WebSocket(`ws://${location.host}/api/term?${new URLSearchParams({ repo, cols: xt.cols, rows: xt.rows, ...(P.termShell ? { shell: P.termShell } : {}) })}`);
  t.ws = ws;
  ws.onmessage = (e) => xt.write(e.data);
  ws.onclose = () => { t.alive = false; xt.write('\r\n\x1b[2m[프로세스 종료 — 이 탭을 닫거나 + 로 새 터미널]\x1b[0m\r\n'); renderTermTabs(); };
  xt.onData((d) => ws.readyState === 1 && ws.send(d));
  xt.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send('\x00\x01R' + JSON.stringify({ cols, rows })));
  xt.onTitleChange((title) => { t.title = title.split(/[\\/]/).pop() || t.title; renderTermTabs(); });
  R.list.push(t);
  termActivate(t);
}
function termActivate(t) {
  const R = repoTerms(t.repo);
  R.active = t.id;
  for (const [repo, r] of T.byRepo) for (const x of r.list) x.el.hidden = !(repo === S.repo && x.id === t.id);
  renderTermTabs();
  requestAnimationFrame(() => { try { t.fit.fit(); } catch {} t.xt.focus(); });
}
function termClose(t) {
  const R = repoTerms(t.repo);
  try { t.ws.close(); } catch {}
  t.xt.dispose(); t.el.remove();
  R.list = R.list.filter((x) => x !== t);
  if (R.active === t.id) { const n = R.list[R.list.length - 1]; if (n) termActivate(n); else { R.active = null; termShow(false); } }
  renderTermTabs();
}
function renderTermTabs() {
  const R = repoTerms();
  $('#term-tabs').innerHTML = R.list.map((t) => `<div class="tt-tab${t.id === R.active ? ' on' : ''}" data-tid="${t.id}">${icon('terminal')}<span>${esc(t.title)}${t.alive ? '' : ' (종료)'}</span><span class="x" data-tclose="${t.id}">${icon('x')}</span></div>`).join('');
}
function termShow(on) {
  const panel = $('#term-panel');
  panel.hidden = !on;
  $('#center').classList.toggle('term-open', on);
  LS.set('termOpen', on);
  if (on) {
    const R = repoTerms();
    if (!R.list.length) termNew();
    else termActivate(R.list.find((t) => t.id === R.active) || R.list[0]);
  } else $('#graph-scroll').focus();
  canvasSize = ''; renderRows();
}
function termToggle() { termShow($('#term-panel').hidden); }
function termOnRepoSwitch() {
  for (const [repo, r] of T.byRepo) for (const x of r.list) x.el.hidden = !(repo === S.repo && x.id === r.active);
  if (!$('#term-panel').hidden) { const R = repoTerms(); if (!R.list.length) termNew(); else termActivate(R.list.find((t) => t.id === R.active) || R.list[0]); }
}
function termCloseRepo(repo) { const r = T.byRepo.get(repo); if (r) [...r.list].forEach(termClose); T.byRepo.delete(repo); }
function bindTerminal() {
  document.documentElement.style.setProperty('--term-h', LS.get('termH', 240) + 'px');
  $('#term-add').onclick = termNew;
  $('#term-hide').onclick = () => termShow(false);
  $('#term-ext').onclick = () => run('terminal', {}, { quiet: true });
  $('#term-tabs').addEventListener('mousedown', (e) => {
    const x = e.target.closest('[data-tclose]'); const R = repoTerms();
    if (x) { e.stopPropagation(); const t = R.list.find((t) => t.id === +x.dataset.tclose); if (t) termClose(t); return; }
    const tab = e.target.closest('[data-tid]'); if (tab) { const t = R.list.find((t) => t.id === +tab.dataset.tid); if (t) termActivate(t); }
  });
  new ResizeObserver(() => { const R = repoTerms(); const t = R.list.find((t) => t.id === R.active); if (t && !$('#term-panel').hidden) try { t.fit.fit(); } catch {} }).observe($('#term-body'));
  const rz = $('.term-rz');
  rz.onmousedown = (e) => {
    e.preventDefault(); rz.classList.add('drag');
    const sy = e.clientY, sh = $('#term-panel').offsetHeight, max = $('#center').offsetHeight - 120;
    const mv = (ev) => { const h = Math.max(110, Math.min(max, sh - (ev.clientY - sy))); document.documentElement.style.setProperty('--term-h', h + 'px'); };
    const up = () => { rz.classList.remove('drag'); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); LS.set('termH', $('#term-panel').offsetHeight); canvasSize = ''; renderRows(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  };
  if (LS.get('termOpen', false)) setTimeout(() => S.repo && termShow(true), 300);
}

// ================================================================ resizable columns
function applyCols() {
  const cols = `${CW.ref}px ${S.graphW}px minmax(120px,1fr) ${P.colAuthor ? CW.author : 0}px ${P.colDate ? CW.date : 0}px ${P.colSha ? CW.sha : 0}px`;
  const c = $('#center');
  c.classList.toggle('no-author', !P.colAuthor); c.classList.toggle('no-date', !P.colDate); c.classList.toggle('no-sha', !P.colSha);
  document.documentElement.style.setProperty('--cols', cols);
  canvasSize = '';
}
function bindColumnResize() {
  const order = ['ref', 'graph', 'msg', 'author', 'date', 'sha'];
  $('#graph-header').addEventListener('mousedown', (e) => {
    const h = e.target.closest('.col-rz');
    if (!h) return;
    e.preventDefault();
    const i = +h.dataset.b; // boundary between order[i] and order[i+1]
    const left = order[i], right = order[i + 1];
    const key = left === 'ref' || left === 'graph' ? left : right; // fixed column that this boundary controls
    const sign = key === left ? 1 : -1;
    const start = key === 'graph' ? S.graphW : CW[key];
    const sx = e.clientX;
    h.classList.add('drag');
    document.body.style.cursor = 'col-resize';
    const mv = (ev) => {
      const w = Math.max(COL_MIN[key], Math.min(600, start + sign * (ev.clientX - sx)));
      if (key === 'graph') { CW.graph = w; S.graphW = w; } else CW[key] = w;
      applyCols(); renderRows();
    };
    const up = () => {
      h.classList.remove('drag'); document.body.style.cursor = '';
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
      LS.set('cols', CW);
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
  $('#graph-header').addEventListener('dblclick', (e) => {
    const h = e.target.closest('.col-rz'); if (!h) return;
    Object.assign(CW, COL_DEF); LS.set('cols', {}); relayout(); // double-click: reset widths
  });
}

// ================================================================ boot
(async function boot() {
  hydrateIcons();
  if (/Mac/.test(navigator.platform) && /Electron/.test(navigator.userAgent)) document.body.classList.add('mac-electron');
  S.L = new Layout();
  applyGeometry();
  applyTheme();
  bind(); bindTips(); bindColumnResize(); bindTerminal(); connectBus();
  window.gittreeOpen = (p) => openTab(p);
  const [ver, def] = await Promise.all([api('version').catch(() => ({})), api('default').catch(() => ({}))]);
  S.version = ver.version; S.platform = ver.platform; S.homeDir = def.home || '';
  renderDetail(); renderStatusbar(); startAi();
  const urlRepo = new URLSearchParams(location.search).get('repo');
  history.replaceState(null, '', '/');
  if (!P.restoreTabs) S.tabs = [];
  let active = urlRepo || def.repo || (P.restoreTabs ? LS.get('active') || S.tabs[0] : null);
  renderTabs();
  loadRepos(false);
  if (active) await openTab(active);
  else { showEmpty(); openPalette('repos'); }
})();
