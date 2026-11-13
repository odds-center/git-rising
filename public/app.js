'use strict';
// ---------------------------------------------------------------- utils
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('gittree.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gittree.' + k, JSON.stringify(v)); } catch {} },
};
const ROW = 30, LANE = 22, PAD = 14, AV_R = 10;
const COLORS = ['#36b6d6', '#4f7cff', '#b45cf0', '#e055c8', '#f0647a', '#f2913d', '#e5c443', '#47c27a', '#2bb3a3', '#8d8cff'];
const laneColor = (i) => COLORS[i % COLORS.length];

async function api(p, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`/api/${p}?${qs}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function post(p, params, body) {
  const r = await fetch(`/api/${p}?${new URLSearchParams(params)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gittree': '1' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  t.onclick = () => t.remove();
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 12000 : 3500);
}

function fmtDate(sec) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function relDate(sec) {
  const s = Date.now() / 1000 - sec;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return fmtDate(sec).slice(0, 10);
}
function initials(name) {
  name = (name || '?').trim();
  if (/[^\x00-\x7f]/.test(name[0])) return name.replace(/\s/g, '').slice(0, 2);
  const w = name.split(/[\s._-]+/).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase();
}
function hue(str) { let h = 0; for (const c of str || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
const avColor = (email) => `hsl(${hue(email)} 45% 38%)`;
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('복사됨: ' + text, 'ok'); } catch { toast('복사 실패', 'err'); } }

// ---------------------------------------------------------------- state
const S = {
  tabs: LS.get('tabs', []),
  repo: null,          // abs path of active repo
  info: null,          // {path,name,branch,head}
  meta: { op: null, worktrees: [], remotes: {} },
  commits: [], hasMore: false, index: new Map(),
  refs: [], refsBySha: new Map(), stashes: 0,
  status: [],
  rows: [], maxLanes: 1,
  selected: null, detail: null,
  search: '', matches: [], matchPos: -1,
  fp: null, loading: false,
  collapsed: new Set(LS.get('collapsed', [])),
  fileView: LS.get('fileView', 'path'),
};

// ---------------------------------------------------------------- graph layout
function computeLayout(list) {
  const lanes = [], srcs = [], rows = new Array(list.length);
  let maxL = 1;
  const free = () => { const i = lanes.findIndex((l) => l == null); return i === -1 ? lanes.length : i; };
  for (let r = 0; r < list.length; r++) {
    const c = list[r];
    let col = lanes.indexOf(c.sha);
    const edges = [];
    if (col === -1) col = free();
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
        if (j === -1) { j = free(); lanes[j] = ps[k]; srcs[j] = [col]; }
        else srcs[j].push(col);
      }
    } else { lanes[col] = null; srcs[col] = []; }
    while (lanes.length && lanes[lanes.length - 1] == null) { lanes.pop(); srcs.pop(); }
    rows[r] = { col, edges: [] };
    maxL = Math.max(maxL, col + 1, lanes.length);
  }
  // lanes still open at the bottom (more history not yet loaded)
  if (list.length) {
    const last = rows[list.length - 1];
    last.tail = lanes.map((l, i) => (l == null ? null : srcs[i])).flatMap((ss, i) => (ss ? ss.map((s) => ({ x1: s, x2: i, lane: i, top: s !== i, bot: false })) : []));
  }
  return { rows, maxLanes: maxL };
}

// ---------------------------------------------------------------- data loading
function viewList() {
  const list = S.commits;
  if (S.status.length && S.info?.head) {
    return [{ sha: 'WIP', parents: [S.info.head], subject: '', author: '', email: '', time: Date.now() / 1000, wip: true }, ...list];
  }
  return list;
}

async function loadRepo(repo, { keep = false } = {}) {
  if (!repo) return;
  const switching = repo !== S.repo;
  S.repo = repo;
  S.loading = true;
  try {
    const limit = keep ? Math.max(1500, S.commits.length) : 1500;
    const [info, refs, meta, status, log] = await Promise.all([
      api('repo', { repo }),
      api('refs', { repo }),
      api('info', { repo }),
      api('status', { repo }),
      api('log', { repo, limit }),
    ]);
    if (S.repo !== repo) return; // tab switched mid-load
    if (info.path !== repo) {
      // normalise to toplevel
      S.tabs = S.tabs.map((t) => (t === repo ? info.path : t)).filter((t, i, a) => a.indexOf(t) === i);
      S.repo = info.path;
      saveTabs();
    }
    S.info = info; S.meta = meta; S.status = status.files;
    S.refs = refs.refs; S.stashes = refs.stashes;
    S.refsBySha = new Map();
    for (const r of S.refs) { if (!S.refsBySha.has(r.sha)) S.refsBySha.set(r.sha, []); S.refsBySha.get(r.sha).push(r); }
    S.commits = log.commits; S.hasMore = log.hasMore;
    if (switching) { S.selected = null; S.detail = null; closeDiff(); $('#graph-scroll').scrollTop = 0; }
    rebuild();
    renderTabs(); renderToolbar(); renderSidebar(); renderBanner();
    if (S.selected && !S.index.has(S.selected)) S.selected = null;
    if (S.selected) selectCommit(S.selected, { scroll: false, force: true });
    else renderDetail();
    $('#empty').hidden = true;
    api('fingerprint', { repo: S.repo }).then((f) => (S.fp = f.fp)).catch(() => {});
  } catch (e) {
    showEmpty(e.message);
  } finally { S.loading = false; }
}

function rebuild() {
  const list = viewList();
  S.view = list;
  S.index = new Map(list.map((c, i) => [c.sha, i]));
  const L = computeLayout(list);
  S.rows = L.rows; S.maxLanes = L.maxLanes;
  const gw = Math.min(Math.max(80, PAD * 2 + S.maxLanes * LANE), 420);
  S.graphW = gw;
  document.documentElement.style.setProperty('--cols', `190px ${gw}px minmax(160px,1fr) 110px 92px 66px`);
  $('#graph-inner').style.height = list.length * ROW + (S.hasMore ? 40 : 0) + 'px';
  $('#sb-count').textContent = S.commits.length + (S.hasMore ? '+' : '');
  computeMatches();
  renderRows(true);
}

async function loadMore() {
  if (!S.hasMore || S.loadingMore) return;
  S.loadingMore = true;
  try {
    const repo = S.repo;
    const log = await api('log', { repo, skip: S.commits.length, limit: 2000 });
    if (repo !== S.repo) return;
    S.commits = S.commits.concat(log.commits);
    S.hasMore = log.hasMore;
    rebuild();
  } catch (e) { toast(e.message, 'err'); }
  finally { S.loadingMore = false; }
}

async function ensureLoaded(sha) {
  for (let i = 0; i < 30 && !S.index.has(sha) && S.hasMore; i++) await loadMore();
  return S.index.has(sha);
}

function showEmpty(msg) {
  const e = $('#empty');
  e.hidden = false;
  e.innerHTML = `<div>${esc(msg || '저장소를 열어주세요')}</div><button id="empty-open">폴더 열기…</button>`;
  $('#empty-open').onclick = pickRepo;
}

// ---------------------------------------------------------------- rows + canvas
function refLabels(sha) {
  const refs = S.refsBySha.get(sha) || [];
  // merge "main" + "origin/main" into one pill
  const out = [], locals = new Map();
  for (const r of refs) if (r.type === 'branch') { const x = { ...r, remotes: [] }; out.push(x); locals.set(r.name, x); }
  for (const r of refs) if (r.type === 'remote') {
    const short = r.name.slice(r.name.indexOf('/') + 1);
    if (locals.has(short)) locals.get(short).remotes.push(r.name);
    else out.push({ ...r, remotes: [r.name] });
  }
  for (const r of refs) if (r.type === 'tag') out.push(r);
  const headB = S.info?.branch;
  out.sort((a, b) => (b.name === headB && b.type === 'branch') - (a.name === headB && a.type === 'branch'));
  return out;
}

function pillHTML(r, color, attr = '') {
  const isHead = r.type === 'branch' && r.name === S.info?.branch;
  const ico = r.type === 'tag' ? '◆' : isHead ? '✓' : '';
  const cloud = r.type !== 'tag' && r.remotes?.length ? '<span class="ico">☁</span>' : '';
  const label = r.type === 'remote' ? r.name : r.name;
  return `<span class="pill ${r.type}${isHead ? ' head' : ''}" style="--pc:${color}" ${attr} title="${esc([r.type === 'tag' ? 'tag ' + r.name : r.name, ...(r.remotes || []).filter((x) => x !== r.name)].join('\n'))}">${ico ? `<span class="ico">${ico}</span>` : ''}<span class="t">${esc(label)}</span>${cloud}</span>`;
}

let lastRange = '';
function renderRows(force) {
  const sc = $('#graph-scroll');
  const list = S.view || [];
  const h = sc.clientHeight;
  const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 5);
  const last = Math.min(list.length - 1, Math.ceil((sc.scrollTop + h) / ROW) + 5);
  const key = `${first}:${last}`;
  if (!force && key === lastRange) return;
  lastRange = key;
  let html = '';
  for (let i = first; i <= last; i++) {
    const c = list[i], row = S.rows[i];
    const col = laneColor(row.col);
    const labels = c.wip ? [] : refLabels(c.sha);
    const cls = ['row'];
    if (c.sha === S.selected) cls.push('selected');
    if (S.search) cls.push(S.matchSet.has(c.sha) ? 'match' : 'dim');
    let ref = '';
    if (labels.length) {
      ref = pillHTML(labels[0], col, `data-ref="${esc(labels[0].type)}:${esc(labels[0].name)}"`);
      if (labels.length > 1) ref += `<span class="more" title="${esc(labels.slice(1).map((l) => l.name).join('\n'))}">+${labels.length - 1}</span>`;
    }
    const msg = c.wip
      ? `<span class="s wip">// WIP — 변경된 파일 ${S.status.length}개</span>`
      : `<span class="s">${esc(c.subject)}</span>`;
    html += `<div class="${cls.join(' ')}" data-i="${i}" style="top:${i * ROW}px;--lc:${labels.length || c.wip || c.sha === S.info?.head ? col : 'transparent'}">
      <div class="c-ref">${ref}</div><div class="c-graph"></div>
      <div class="c-msg">${msg}</div>
      <div class="c-author">${esc(c.author)}</div>
      <div class="c-date" title="${c.wip ? '' : fmtDate(c.time)}">${c.wip ? '' : relDate(c.time)}</div>
      <div class="c-sha">${c.wip ? '' : c.sha.slice(0, 7)}</div></div>`;
  }
  if (S.hasMore) html += `<div class="load-more" style="top:${list.length * ROW}px">불러오는 중…</div>`;
  $('#rows').innerHTML = html;
  drawGraph(first, last);
  if (S.hasMore && last >= list.length - 30) loadMore();
}

function drawGraph(first, last) {
  const cv = $('#graph-canvas');
  const dpr = window.devicePixelRatio || 1;
  const x0 = 190; // ref column width
  const w = x0 + S.graphW;
  const top = first * ROW;
  const hpx = (last - first + 1) * ROW;
  cv.style.top = top + 'px';
  cv.style.width = w + 'px';
  cv.style.height = hpx + 'px';
  cv.width = Math.ceil(w * dpr); cv.height = Math.ceil(hpx * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hpx);
  g.save();
  g.beginPath(); g.rect(x0, 0, S.graphW, hpx); g.clip();
  const X = (lane) => x0 + PAD + lane * LANE + LANE / 2 - 4;
  const Y = (r) => (r - first) * ROW + ROW / 2;
  const list = S.view;
  g.lineWidth = 2;
  // edges (draw one row above to cover lines entering the viewport)
  for (let r = Math.max(0, first - 1); r <= last; r++) {
    const row = S.rows[r];
    const es = r === list.length - 1 ? row.tail || [] : row.edges;
    const y1 = Y(r), y2 = r === list.length - 1 ? y1 + ROW : Y(r + 1);
    for (const e of es) {
      const a = X(e.x1), b = X(e.x2);
      g.strokeStyle = laneColor(e.lane);
      const wip = list[r].wip;
      g.setLineDash(wip ? [3, 3] : []);
      g.beginPath(); g.moveTo(a, y1);
      if (a === b) g.lineTo(b, y2);
      else {
        const rad = Math.min(8, Math.abs(b - a) / 2, ROW / 2);
        const sx = Math.sign(b - a);
        if (e.top && !e.bot) { // leave the node horizontally, then go down the lane
          g.lineTo(b - sx * rad, y1); g.quadraticCurveTo(b, y1, b, y1 + rad); g.lineTo(b, y2);
        } else if (e.bot && !e.top) { // come down the lane, then turn into the node
          g.lineTo(a, y2 - rad); g.quadraticCurveTo(a, y2, a + sx * rad, y2); g.lineTo(b, y2);
        } else {
          const my = (y1 + y2) / 2;
          g.bezierCurveTo(a, my, b, my, b, y2);
        }
      }
      g.stroke();
    }
  }
  g.setLineDash([]);
  // nodes
  for (let r = first; r <= last; r++) {
    const c = list[r], row = S.rows[r];
    const x = X(row.col), y = Y(r), col = laneColor(row.col);
    if (c.wip) {
      g.setLineDash([3, 2]); g.strokeStyle = col; g.fillStyle = '#1b1d23';
      g.beginPath(); g.arc(x, y, AV_R - 1, 0, Math.PI * 2); g.fill(); g.stroke(); g.setLineDash([]);
      continue;
    }
    if (c.parents.length > 1) {
      g.fillStyle = col; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
      continue;
    }
    g.fillStyle = col; g.beginPath(); g.arc(x, y, AV_R + 1.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = avColor(c.email); g.beginPath(); g.arc(x, y, AV_R - 1, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = '600 9px -apple-system, "Apple SD Gothic Neo", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(initials(c.author), x, y + 0.5);
    if (c.sha === S.info?.head) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, AV_R + 4, 0, Math.PI * 2); g.stroke(); g.lineWidth = 2; }
  }
  g.restore();
  // connector from ref pill to node
  for (let r = first; r <= last; r++) {
    const c = list[r];
    if (c.wip || !S.refsBySha.has(c.sha)) continue;
    const row = S.rows[r];
    g.strokeStyle = laneColor(row.col); g.globalAlpha = 0.55; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x0 - 4, Y(r)); g.lineTo(X(row.col) - AV_R - 2, Y(r)); g.stroke();
    g.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- selection / detail
async function selectCommit(sha, { scroll = true, force = false } = {}) {
  if (!force && sha === S.selected && S.detail) return;
  if (!S.index.has(sha) && !(await ensureLoaded(sha))) { toast('불러온 범위에 없는 커밋입니다'); return; }
  S.selected = sha;
  if (scroll) scrollToRow(S.index.get(sha));
  renderRows(true);
  if (sha === 'WIP') { S.detail = { wip: true }; renderDetail(); return; }
  const repo = S.repo;
  try {
    const d = await api('commit', { repo, sha });
    if (S.selected !== sha || S.repo !== repo) return;
    S.detail = d;
    renderDetail();
  } catch (e) { toast(e.message, 'err'); }
}

function scrollToRow(i) {
  const sc = $('#graph-scroll');
  const y = i * ROW;
  if (y < sc.scrollTop + ROW || y > sc.scrollTop + sc.clientHeight - ROW * 2) sc.scrollTop = y - sc.clientHeight / 3;
}

function fileListHTML(files, wip) {
  const st = (f) => (f.status === '?' ? 'A' : f.status);
  const icon = { A: '+', D: '−', M: '✎', R: '→', C: '⧉', U: '!', T: '✎' };
  const one = (f, i, short) => {
    const s = st(f);
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const base = f.path.slice(dir.length);
    const n = f.add != null ? `<span class="n"><span class="a">+${f.add}</span> <span class="d">−${f.del}</span></span>` : '';
    const p = short ? `<bdi>${esc(base)}</bdi>` : `<bdi><span class="dir">${esc(dir)}</span>${esc(base)}</bdi>`;
    return `<div class="file" data-fi="${i}" data-wip="${wip ? 1 : 0}" title="${esc(f.oldPath ? f.oldPath + ' → ' + f.path : f.path)}"><span class="st st-${esc(f.status)}">${icon[s] || s}</span><span class="p">${p}</span>${n}</div>`;
  };
  if (S.fileView === 'tree') {
    const groups = new Map();
    files.forEach((f, i) => {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push([f, i]);
    });
    return `<div class="files tree">${[...groups.keys()].sort().map((d) => `<div class="dir-h">${esc(d)}/</div>` + groups.get(d).map(([f, i]) => one(f, i, true)).join('')).join('')}</div>`;
  }
  return `<div class="files">${files.map((f, i) => one(f, i, false)).join('')}</div>`;
}

function statsHTML(files) {
  const c = { M: 0, A: 0, D: 0, R: 0 };
  for (const f of files) { const s = f.status === '?' ? 'A' : f.status === 'C' ? 'A' : f.status === 'U' || f.status === 'T' ? 'M' : f.status; c[s] = (c[s] || 0) + 1; }
  return `<div class="d-stats">${c.M ? `<span class="m">✎ ${c.M} modified</span>` : ''}${c.A ? `<span class="a">+ ${c.A} added</span>` : ''}${c.D ? `<span class="d">− ${c.D} deleted</span>` : ''}${c.R ? `<span class="r">→ ${c.R} renamed</span>` : ''}
    <div class="seg"><button data-fv="path" class="${S.fileView === 'path' ? 'on' : ''}">Path</button><button data-fv="tree" class="${S.fileView === 'tree' ? 'on' : ''}">Tree</button></div></div>`;
}

function renderDetail() {
  const el = $('#detail');
  const d = S.detail;
  if (!d) { el.innerHTML = '<div class="placeholder">커밋을 선택하세요</div>'; return; }
  if (d.wip) {
    const staged = S.status.filter((f) => f.staged), rest = S.status.filter((f) => !f.staged);
    S.detailFiles = [...staged, ...rest];
    el.innerHTML = `<div class="d-top"><span>작업 중인 변경사항</span><span>${esc(S.info?.branch || 'detached')}</span></div>
      ${statsHTML(S.status)}
      ${staged.length ? `<div class="wip-sec">STAGED (${staged.length})</div>` + fileListHTML(staged, true).replace(/data-fi="(\d+)"/g, (m, i) => `data-fi="${i}"`) : ''}
      ${rest.length ? `<div class="wip-sec">UNSTAGED (${rest.length})</div>` + fileListHTML(rest, true).replace(/data-fi="(\d+)"/g, (m, i) => `data-fi="${+i + staged.length}"`) : ''}`;
    return;
  }
  S.detailFiles = d.files;
  const [subject, ...bodyLines] = d.message.split('\n');
  const body = bodyLines.join('\n').trim();
  const labels = refLabels(d.sha);
  const committerDiff = d.committer !== d.author;
  el.innerHTML = `
    <div class="d-top"><span>commit: <span class="sha" data-copy="${d.sha}" title="클릭해서 복사">${d.sha.slice(0, 7)}</span></span><span>${d.parents.length > 1 ? 'merge' : ''}</span></div>
    <div class="d-msg"><h2>${esc(subject)}</h2>${body ? `<pre>${esc(body)}</pre>` : ''}</div>
    ${labels.length ? `<div class="d-refs">${labels.map((l) => pillHTML(l, laneColor(S.rows[S.index.get(d.sha)]?.col || 0), `data-ref="${esc(l.type)}:${esc(l.name)}"`)).join('')}</div>` : ''}
    <div class="d-author">
      <div class="av" style="background:${avColor(d.email)}">${esc(initials(d.author))}</div>
      <div class="who"><div class="nm">${esc(d.author)}</div><div class="sub" title="${esc(d.email)}">authored ${fmtDate(d.time)}</div>
        ${committerDiff ? `<div class="sub">committed by ${esc(d.committer)} ${fmtDate(d.committerTime)}</div>` : ''}</div>
      <div class="par">${d.parents.length ? 'parent' + (d.parents.length > 1 ? 's' : '') : 'root'}${d.parents.map((p) => `<a data-goto="${p}">${p.slice(0, 7)}</a>`).join('')}</div>
    </div>
    ${statsHTML(d.files)}
    ${d.files.length ? fileListHTML(d.files, false) : '<div class="placeholder">변경된 파일 없음</div>'}`;
}

// ---------------------------------------------------------------- diff
async function openDiff(fi) {
  const f = S.detailFiles?.[fi];
  if (!f) return;
  document.querySelectorAll('#detail .file').forEach((e) => e.classList.toggle('selected', +e.dataset.fi === fi));
  const d = S.detail;
  const params = { repo: S.repo, path: f.path };
  if (f.oldPath) params.oldPath = f.oldPath;
  if (d.wip) { params.sha = 'WIP'; if (f.status === '?') params.untracked = '1'; }
  else { params.sha = d.sha; if (d.parents[0]) params.parent = d.parents[0]; }
  $('#diff-view').hidden = false;
  $('#diff-title').textContent = (f.oldPath ? f.oldPath + ' → ' : '') + f.path;
  $('#diff-body').innerHTML = '<div class="diff-note">불러오는 중…</div>';
  try {
    const r = await api('diff', params);
    renderDiff(r.patch, r.truncated);
  } catch (e) { $('#diff-body').innerHTML = `<div class="diff-note">${esc(e.message)}</div>`; }
}

function renderDiff(patch, truncated) {
  if (!patch.trim()) { $('#diff-body').innerHTML = '<div class="diff-note">표시할 변경 내용이 없습니다 (모드 변경 등)</div>'; return; }
  const lines = patch.split('\n');
  let o = 0, n = 0, inHunk = false;
  const out = [];
  for (const l of lines) {
    if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { o = +m[1]; n = +m[2]; }
      inHunk = true;
      out.push(`<div class="dl hunk"><span class="ln"></span><span class="ln"></span><span class="tx">${esc(l)}</span></div>`);
    } else if (!inHunk || l.startsWith('diff --git')) {
      inHunk = false;
      if (/^(diff --git|index |--- |\+\+\+ )/.test(l)) continue;
      if (l) out.push(`<div class="dl meta"><span class="ln"></span><span class="ln"></span><span class="tx">${esc(l)}</span></div>`);
    } else if (l[0] === '+') out.push(`<div class="dl add"><span class="ln"></span><span class="ln">${n++}</span><span class="tx">${esc(l)}</span></div>`);
    else if (l[0] === '-') out.push(`<div class="dl del"><span class="ln">${o++}</span><span class="ln"></span><span class="tx">${esc(l)}</span></div>`);
    else if (l[0] === '\\') out.push(`<div class="dl meta"><span class="ln"></span><span class="ln"></span><span class="tx">${esc(l)}</span></div>`);
    else if (l !== '' || o || n) out.push(`<div class="dl"><span class="ln">${o++}</span><span class="ln">${n++}</span><span class="tx">${esc(l)}</span></div>`);
  }
  if (truncated) out.push('<div class="diff-note">diff가 너무 커서 일부만 표시합니다</div>');
  $('#diff-body').innerHTML = out.join('');
  $('#diff-body').scrollTop = 0;
}
function closeDiff() {
  $('#diff-view').hidden = true;
  document.querySelectorAll('#detail .file.selected').forEach((e) => e.classList.remove('selected'));
}

// ---------------------------------------------------------------- sidebar
function buildTree(items, nameOf) {
  const root = { dirs: new Map(), leaves: [] };
  for (const it of items) {
    const parts = nameOf(it).split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), leaves: [] });
      node = node.dirs.get(p);
    }
    node.leaves.push({ it, label: parts[parts.length - 1] });
  }
  return root;
}

function parseTrack(t) {
  if (!t) return '';
  const a = t.match(/ahead (\d+)/), b = t.match(/behind (\d+)/);
  return [a ? `${a[1]}↑` : '', b ? `${b[1]}↓` : ''].filter(Boolean).join(' ');
}

function renderSidebar() {
  const q = $('#sb-filter').value.trim().toLowerCase();
  const local = S.refs.filter((r) => r.type === 'branch');
  const remote = S.refs.filter((r) => r.type === 'remote');
  const tags = S.refs.filter((r) => r.type === 'tag').sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  const match = (r) => !q || r.name.toLowerCase().includes(q);
  const head = S.info?.branch;

  const leafHTML = (r, label, depth) => {
    const tr = r.type === 'branch' ? parseTrack(r.track) : '';
    const ic = r.type === 'tag' ? '◆' : r.type === 'branch' && r.name === head ? '✓' : '⑂';
    return `<div class="sb-item${r.name === head && r.type === 'branch' ? ' head' : ''}${S.selected === r.sha ? ' selected' : ''}" style="padding-left:${12 + depth * 14}px" data-ref="${esc(r.type)}:${esc(r.name)}" title="${esc(r.name)}">
      <span class="ic">${ic}</span><span class="nm">${esc(label)}</span>${tr ? `<span class="track">${tr}</span>` : ''}</div>`;
  };
  const treeHTML = (node, depth, keyPrefix) => {
    let h = '';
    for (const [name, sub] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const key = keyPrefix + '/' + name;
      const col = S.collapsed.has(key);
      h += `<div class="sb-item folder${col ? ' collapsed' : ''}" style="padding-left:${12 + depth * 14}px" data-fold="${esc(key)}"><span class="chev">▾</span><span class="nm">${esc(name)}</span></div>`;
      if (!col) h += treeHTML(sub, depth + 1, key);
    }
    for (const { it, label } of node.leaves.sort((a, b) => a.label.localeCompare(b.label))) h += leafHTML(it, label, depth + (node.dirs.size || depth ? 0.9 : 0.9));
    return h;
  };
  const section = (key, title, icon, count, body) => {
    const col = S.collapsed.has('sec:' + key) && !q;
    return `<div class="sb-sec-h${col ? ' collapsed' : ''}" data-fold="sec:${key}"><span class="chev">▾</span>${icon} ${title}<span class="cnt">${count}</span></div>${col ? '' : body || '<div class="sb-empty">없음</div>'}`;
  };
  const flat = (list) => list.map((r) => leafHTML(r, r.name, 0.9)).join('');

  let h = '';
  const ll = local.filter(match);
  h += section('local', 'LOCAL', '🖥', local.length, q ? flat(ll) : treeHTML(buildTree(ll, (r) => r.name), 0, 'local'));
  const rl = remote.filter(match);
  let rb = '';
  const byRemote = new Map();
  for (const r of rl) { const rn = r.name.split('/')[0]; if (!byRemote.has(rn)) byRemote.set(rn, []); byRemote.get(rn).push(r); }
  for (const [rn, list] of byRemote) {
    const key = 'remote/' + rn;
    const col = S.collapsed.has(key) && !q;
    rb += `<div class="sb-item folder${col ? ' collapsed' : ''}" style="padding-left:12px" data-fold="${esc(key)}"><span class="chev">▾</span><span class="nm" style="color:var(--text)">☁ ${esc(rn)}</span></div>`;
    if (!col) rb += q ? list.map((r) => leafHTML(r, r.name.slice(rn.length + 1), 1.9)).join('') : treeHTML(buildTree(list, (r) => r.name.slice(rn.length + 1)), 1, key);
  }
  h += section('remote', 'REMOTE', '☁', remote.length, rb);
  h += section('tags', 'TAGS', '◆', tags.length, flat(tags.filter(match)));
  const wts = S.meta.worktrees || [];
  h += section('wt', 'WORKTREES', '⧉', wts.length, wts.map((w) => `<div class="sb-item" style="padding-left:24px" data-wt="${esc(w.head || '')}" title="${esc(w.path)}"><span class="ic">⧉</span><span class="nm">${esc(w.branch || w.path.split('/').pop())}</span><span class="track">${esc(w.path.split('/').pop())}</span></div>`).join(''));
  h += `<div class="sb-sec-h" style="cursor:default"><span class="chev"></span>⊻ STASHES<span class="cnt">${S.stashes}</span></div>`;
  $('#sb-body').innerHTML = h;
}

function findRef(key) {
  const i = key.indexOf(':');
  const type = key.slice(0, i), name = key.slice(i + 1);
  return S.refs.find((r) => r.type === type && r.name === name);
}

// ---------------------------------------------------------------- tabs / toolbar / banner
function saveTabs() { LS.set('tabs', S.tabs); LS.set('active', S.repo); }
function renderTabs() {
  $('#tab-list').innerHTML = S.tabs.map((t) => `<div class="tab${t === S.repo ? ' active' : ''}" data-tab="${esc(t)}" title="${esc(t)}"><span>⑂ ${esc(t.split('/').pop())}</span><span class="x" data-close="${esc(t)}">✕</span></div>`).join('');
  document.title = S.info ? `${S.info.name} — gittree` : 'gittree';
}
function renderToolbar() {
  $('#tb-repo-name').textContent = S.info?.name || '—';
  $('#tb-branch-name').textContent = S.info?.branch || (S.info?.head ? `(detached ${S.info.head.slice(0, 7)})` : '—');
  $('[data-act=pop]').disabled = !S.stashes;
  $('[data-act=stash]').disabled = !S.status.length;
}
function renderBanner() {
  const b = $('#banner');
  const op = S.meta.op;
  if (!op) { b.hidden = true; return; }
  b.hidden = false;
  const conflicts = S.status.filter((f) => f.status === 'U').length;
  b.innerHTML = `<b>${op} 진행 중</b>${conflicts ? ` — 충돌 파일 ${conflicts}개. 해결 후 add 하고 Continue 하세요.` : ''}<span class="tb-spacer"></span>
    ${op !== 'merge' ? `<button data-banner="cont">Continue</button>` : ''}<button data-banner="abort">Abort</button>`;
}

async function openTab(repo) {
  if (!S.tabs.includes(repo)) S.tabs.push(repo);
  S.repo = null;
  await loadRepo(repo);
  if (!S.tabs.includes(S.repo)) S.tabs.push(S.repo);
  saveTabs(); renderTabs();
}
function closeTab(repo) {
  const i = S.tabs.indexOf(repo);
  S.tabs = S.tabs.filter((t) => t !== repo);
  if (repo === S.repo) {
    const next = S.tabs[Math.min(i, S.tabs.length - 1)];
    S.repo = null;
    if (next) loadRepo(next); else { S.info = null; S.commits = []; S.status = []; S.refs = []; S.refsBySha = new Map(); rebuild(); renderTabs(); renderSidebar(); renderDetail(); showEmpty(); }
  }
  saveTabs(); renderTabs();
}
async function pickRepo() {
  try {
    const r = await post('pick', {}, {});
    if (r.path) openTab(r.path);
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------- actions
async function run(action, args = {}, { label, quiet } = {}) {
  const btn = document.querySelector(`[data-act="${action}"]`);
  btn?.classList.add('busy');
  try {
    const r = await post('action', { repo: S.repo }, { action, args });
    if (!quiet) toast((label || action) + ' 완료' + (r.output?.trim() ? '\n' + r.output.trim().slice(-600) : ''), 'ok');
    return true;
  } catch (e) {
    toast((label || action) + ' 실패\n' + e.message, 'err');
    return false;
  } finally {
    btn?.classList.remove('busy');
    await loadRepo(S.repo, { keep: true });
  }
}

function modal({ title, text, input, inputValue = '', textarea, checkbox, ok = '확인', danger }) {
  return new Promise((resolve) => {
    const L = $('#modal-layer');
    L.hidden = false;
    L.innerHTML = `<div class="modal"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input type="text" id="m-in" placeholder="${esc(input)}" value="${esc(inputValue)}" spellcheck="false">` : ''}
      ${textarea ? `<textarea id="m-ta" placeholder="${esc(textarea)}"></textarea>` : ''}
      ${checkbox ? `<label class="chk"><input type="checkbox" id="m-cb" ${checkbox.checked ? 'checked' : ''}> ${esc(checkbox.label)}</label>` : ''}
      <div class="btns"><button id="m-cancel">취소</button><button id="m-ok" class="primary${danger ? ' danger' : ''}">${esc(ok)}</button></div></div>`;
    const done = (v) => { L.hidden = true; L.innerHTML = ''; document.removeEventListener('keydown', key, true); resolve(v); };
    const submit = () => {
      const v = { value: $('#m-in')?.value.trim(), text: $('#m-ta')?.value.trim(), checked: $('#m-cb')?.checked };
      if (input && !v.value) return $('#m-in').focus();
      done(v);
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    document.addEventListener('keydown', key, true);
    $('#m-cancel').onclick = () => done(null);
    $('#m-ok').onclick = submit;
    L.onclick = (e) => { if (e.target === L) done(null); };
    setTimeout(() => ($('#m-in') || $('#m-ok')).focus(), 0);
  });
}

async function newBranch(sha) {
  const r = await modal({ title: '새 브랜치', text: `${sha === 'HEAD' ? 'HEAD' : sha.slice(0, 7)} 에서 브랜치 생성`, input: 'branch-name', checkbox: { label: '생성 후 checkout', checked: true }, ok: '생성' });
  if (r) run('branch', { name: r.value, sha, checkout: r.checked }, { label: `브랜치 ${r.value} 생성` });
}
async function newTag(sha, annotated) {
  const r = await modal({ title: annotated ? 'Annotated tag 생성' : '태그 생성', text: sha.slice(0, 7), input: 'v1.0.0', textarea: annotated ? '태그 메시지' : null, ok: '생성' });
  if (r) run('tag', { name: r.value, sha, message: annotated ? r.text || r.value : undefined }, { label: `태그 ${r.value}` });
}
async function confirmRun(title, text, action, args, label, danger = true) {
  const r = await modal({ title, text, ok: '실행', danger });
  if (r) run(action, args, { label });
}

const ACT = {
  fetch: () => run('fetch', {}, { label: 'Fetch' }),
  pull: () => run('pull', {}, { label: 'Pull' }),
  push: () => run('push', {}, { label: 'Push' }),
  newbranch: () => newBranch('HEAD'),
  stash: () => run('stash', {}, { label: 'Stash' }),
  pop: () => run('pop', {}, { label: 'Stash pop' }),
  terminal: () => run('terminal', {}, { quiet: true }),
  reveal: () => run('reveal', {}, { quiet: true }),
};

// ---------------------------------------------------------------- context menu
function closeMenus() { $('#menu-layer').innerHTML = ''; }
function showMenu(items, x, y) {
  closeMenus();
  const build = (items, px, py, parentEl) => {
    const m = document.createElement('div');
    m.className = 'menu';
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { m.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); continue; }
      if (it.head) { m.insertAdjacentHTML('beforeend', `<div class="mhead">${esc(it.head)}</div>`); continue; }
      const el = document.createElement('div');
      el.className = 'mi' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
      el.innerHTML = `<span>${esc(it.label)}</span>${it.sub ? '<span class="sub-caret">▶</span>' : ''}`;
      if (it.sub) {
        el.onmouseenter = () => {
          m.querySelectorAll('.mi.open').forEach((o) => o.classList.remove('open'));
          m._sub?.remove();
          el.classList.add('open');
          const r = el.getBoundingClientRect();
          m._sub = build(it.sub, r.right + 2, r.top - 5, m);
        };
      } else {
        el.onmouseenter = () => { m._sub?.remove(); m.querySelectorAll('.mi.open').forEach((o) => o.classList.remove('open')); };
        el.onclick = () => { closeMenus(); it.run(); };
      }
      m.append(el);
    }
    $('#menu-layer').append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(px, innerWidth - r.width - 6)) + 'px';
    m.style.top = Math.max(4, Math.min(py, innerHeight - r.height - 6)) + 'px';
    if (parentEl && px + r.width > innerWidth) m.style.left = Math.max(4, parentEl.getBoundingClientRect().left - r.width - 2) + 'px';
    return m;
  };
  build(items, x, y);
}

function branchItems(ref) {
  const cur = S.info?.branch;
  const name = ref.name;
  const isCur = ref.type === 'branch' && name === cur;
  const items = [];
  if (ref.type !== 'tag' && !isCur && cur) {
    items.push({ label: `Fast-forward ${cur} to ${name}`, run: () => run('ff', { ref: name }, { label: 'Fast-forward' }) });
    items.push({ label: `Merge ${name} into ${cur}`, run: () => confirmRun('Merge', `${name} → ${cur}`, 'merge', { ref: name }, 'Merge', false) });
    items.push({ label: `Rebase ${cur} onto ${name}`, run: () => confirmRun('Rebase', `${cur} 를 ${name} 위로 rebase 합니다`, 'rebase', { ref: name }, 'Rebase', false) });
    items.push('-');
  }
  if (!isCur) {
    if (ref.type === 'branch') items.push({ label: `Checkout ${name}`, run: () => run('checkout', { ref: name, kind: 'branch' }, { label: `Checkout ${name}` }) });
    else if (ref.type === 'remote') items.push({ label: `Checkout ${name} (로컬 브랜치로)`, run: () => run('checkout', { ref: name, kind: 'remote' }, { label: `Checkout ${name}` }) });
    else items.push({ label: `Checkout tag ${name} (detached)`, run: () => run('checkout', { ref: ref.sha, kind: 'commit' }, { label: 'Checkout' }) });
  }
  return items;
}

function deleteItems(ref) {
  const cur = S.info?.branch;
  if (ref.type === 'branch' && ref.name !== cur) return [{ label: `Delete ${ref.name}`, danger: true, run: async () => {
    const r = await modal({ title: `브랜치 삭제: ${ref.name}`, text: '로컬 브랜치를 삭제합니다.', checkbox: { label: '머지되지 않았어도 강제 삭제 (-D)', checked: false }, ok: '삭제', danger: true });
    if (r) run('deleteBranch', { name: ref.name, force: r.checked }, { label: `${ref.name} 삭제` });
  } }];
  if (ref.type === 'remote') return [{ label: `Delete ${ref.name} (원격에서)`, danger: true, run: () => confirmRun('원격 브랜치 삭제', `git push ${ref.name.split('/')[0]} --delete ${ref.name.slice(ref.name.indexOf('/') + 1)}`, 'deleteRemoteBranch', { ref: ref.name }, '원격 브랜치 삭제') }];
  if (ref.type === 'tag') return [{ label: `Delete tag ${ref.name} (로컬)`, danger: true, run: () => confirmRun('태그 삭제', ref.name, 'deleteTag', { name: ref.name }, '태그 삭제') }];
  return [];
}

function commitMenu(c, ref) {
  const cur = S.info?.branch || 'HEAD';
  const sha = c.sha;
  const short = sha.slice(0, 7);
  const isHead = sha === S.info?.head;
  if (!ref) ref = refLabels(sha).find((r) => r.type !== 'tag') || null;
  const items = [{ head: `${short} — ${c.subject.slice(0, 50)}` }];
  if (ref) items.push(...branchItems(ref));
  items.push({ label: 'Checkout this commit (detached)', disabled: isHead && !S.info?.branch, run: () => run('checkout', { ref: sha, kind: 'commit' }, { label: 'Checkout' }) });
  items.push('-');
  items.push({ label: 'Create branch here', run: () => newBranch(sha) });
  items.push({ label: 'Cherry pick commit', disabled: isHead, run: () => confirmRun('Cherry pick', `${short} 를 ${cur} 에 cherry-pick`, 'cherrypick', { sha }, 'Cherry pick', false) });
  items.push({ label: `Reset ${cur} to this commit`, sub: [
    { label: 'Soft — 변경사항 staged 유지', run: () => confirmRun('Reset --soft', `${cur} → ${short}`, 'reset', { sha, mode: 'soft' }, 'Reset soft', false) },
    { label: 'Mixed — 변경사항 working tree 유지', run: () => confirmRun('Reset --mixed', `${cur} → ${short}`, 'reset', { sha, mode: 'mixed' }, 'Reset mixed', false) },
    { label: 'Hard — 변경사항 모두 버림', danger: true, run: () => confirmRun('Reset --hard', `${cur} → ${short}\n커밋되지 않은 변경사항이 모두 사라집니다.`, 'reset', { sha, mode: 'hard' }, 'Reset hard') },
  ] });
  items.push({ label: 'Revert commit', run: () => confirmRun('Revert', `${short} 를 되돌리는 커밋을 만듭니다`, 'revert', { sha }, 'Revert', false) });
  if (ref) { const del = deleteItems(ref); if (del.length) items.push('-', ...del); }
  items.push('-');
  if (ref) items.push({ label: 'Copy branch name', run: () => copy(ref.name) });
  items.push({ label: 'Copy commit sha', run: () => copy(sha) });
  const remoteName = (ref?.remotes?.[0] || ref?.name || '').split('/')[0];
  const web = S.meta.remotes?.[S.meta.remotes?.[remoteName] ? remoteName : 'origin'] || Object.values(S.meta.remotes || {})[0];
  if (web) {
    const remoteRef = ref?.type === 'remote' ? ref.name : ref?.remotes?.[0];
    if (remoteRef) items.push({ label: `Copy link to branch: ${remoteRef}`, run: () => copy(`${web}/tree/${remoteRef.slice(remoteRef.indexOf('/') + 1)}`) });
    items.push({ label: 'Copy link to this commit on remote', run: () => copy(`${web}/commit/${sha}`) });
  }
  items.push('-');
  items.push({ label: 'Create tag here', run: () => newTag(sha, false) });
  items.push({ label: 'Create annotated tag here', run: () => newTag(sha, true) });
  return items;
}

function refMenu(ref) {
  const c = S.view[S.index.get(ref.sha)];
  if (c) return commitMenu(c, ref);
  const items = [{ head: ref.name }, ...branchItems(ref)];
  const del = deleteItems(ref);
  if (del.length) items.push('-', ...del);
  items.push('-', { label: 'Copy branch name', run: () => copy(ref.name) }, { label: 'Copy commit sha', run: () => copy(ref.sha) });
  return items;
}

// ---------------------------------------------------------------- search
function computeMatches() {
  const q = S.search.toLowerCase();
  S.matchSet = new Set();
  S.matches = [];
  if (!q) { $('#search-count').textContent = ''; return; }
  (S.view || []).forEach((c, i) => {
    if (c.wip) return;
    if (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q) || c.email.toLowerCase().includes(q)) { S.matchSet.add(c.sha); S.matches.push(i); }
  });
  $('#search-count').textContent = S.matches.length ? `${Math.max(0, S.matchPos) + 1}/${S.matches.length}` : '0';
}
function nextMatch(dir = 1) {
  if (!S.matches.length) return;
  S.matchPos = (S.matchPos + dir + S.matches.length) % S.matches.length;
  $('#search-count').textContent = `${S.matchPos + 1}/${S.matches.length}`;
  selectCommit(S.view[S.matches[S.matchPos]].sha);
}

// ---------------------------------------------------------------- events
function bind() {
  const sc = $('#graph-scroll');
  sc.addEventListener('scroll', () => requestAnimationFrame(() => renderRows(false)));
  new ResizeObserver(() => renderRows(true)).observe(sc);

  $('#rows').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) { selectCommit(S.view[+row.dataset.i].sha, { scroll: false }); sc.focus(); }
  });
  $('#rows').addEventListener('dblclick', (e) => {
    const pill = e.target.closest('[data-ref]');
    if (!pill) return;
    const ref = findRef(pill.dataset.ref);
    if (ref && ref.type === 'branch' && ref.name !== S.info?.branch) run('checkout', { ref: ref.name, kind: 'branch' }, { label: `Checkout ${ref.name}` });
    else if (ref && ref.type === 'remote') run('checkout', { ref: ref.name, kind: 'remote' }, { label: `Checkout ${ref.name}` });
  });
  $('#rows').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    const c = S.view[+row.dataset.i];
    if (c.wip) return;
    selectCommit(c.sha, { scroll: false });
    const pill = e.target.closest('[data-ref]');
    let ref = pill ? findRef(pill.dataset.ref) : null;
    if (ref && ref.type === 'branch') ref = refLabels(c.sha).find((l) => l.type === 'branch' && l.name === ref.name) || ref;
    showMenu(commitMenu(c, ref), e.clientX, e.clientY);
  });

  $('#detail').addEventListener('click', (e) => {
    const f = e.target.closest('.file');
    if (f) return openDiff(+f.dataset.fi);
    const g = e.target.closest('[data-goto]');
    if (g) return selectCommit(g.dataset.goto);
    const cp = e.target.closest('[data-copy]');
    if (cp) return copy(cp.dataset.copy);
    const fv = e.target.closest('[data-fv]');
    if (fv) { S.fileView = fv.dataset.fv; LS.set('fileView', S.fileView); renderDetail(); }
  });
  $('#detail').addEventListener('contextmenu', (e) => {
    const pill = e.target.closest('[data-ref]');
    if (!pill) return;
    e.preventDefault();
    const ref = findRef(pill.dataset.ref);
    if (ref) showMenu(refMenu(ref), e.clientX, e.clientY);
  });

  $('#sb-body').addEventListener('click', (e) => {
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const k = fold.dataset.fold;
      S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k);
      LS.set('collapsed', [...S.collapsed]);
      return renderSidebar();
    }
    const it = e.target.closest('[data-ref]');
    if (it) { const ref = findRef(it.dataset.ref); if (ref) selectCommit(ref.sha); return; }
    const wt = e.target.closest('[data-wt]');
    if (wt && wt.dataset.wt) selectCommit(wt.dataset.wt);
  });
  $('#sb-body').addEventListener('dblclick', (e) => {
    const it = e.target.closest('[data-ref]');
    if (!it) return;
    const ref = findRef(it.dataset.ref);
    if (!ref || ref.type === 'tag' || (ref.type === 'branch' && ref.name === S.info?.branch)) return;
    run('checkout', { ref: ref.name, kind: ref.type }, { label: `Checkout ${ref.name}` });
  });
  $('#sb-body').addEventListener('contextmenu', (e) => {
    const it = e.target.closest('[data-ref]');
    if (!it) return;
    e.preventDefault();
    const ref = findRef(it.dataset.ref);
    if (ref) showMenu(refMenu(ref), e.clientX, e.clientY);
  });
  $('#sb-filter').addEventListener('input', renderSidebar);

  $('#tab-list').addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]');
    if (x) { e.stopPropagation(); return closeTab(x.dataset.close); }
    const t = e.target.closest('[data-tab]');
    if (t && t.dataset.tab !== S.repo) { loadRepo(t.dataset.tab).then(saveTabs); }
  });
  $('#tab-list').addEventListener('auxclick', (e) => { const t = e.target.closest('[data-tab]'); if (t && e.button === 1) closeTab(t.dataset.tab); });

  const repoMenu = async (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const { recent } = await api('recent');
    showMenu([
      { label: '폴더 열기…', run: pickRepo },
      { label: '경로 직접 입력…', run: async () => { const v = await modal({ title: '저장소 경로', input: '/Users/…/repo', ok: '열기' }); if (v) openTab(v.value); } },
      recent.length ? '-' : null,
      recent.length ? { head: '최근' } : null,
      ...recent.map((p) => ({ label: p.replace(/^\/Users\/[^/]+/, '~'), run: () => openTab(p) })),
    ], r.left, r.bottom + 4);
  };
  $('#tab-add').onclick = repoMenu;
  $('#tb-repo').onclick = repoMenu;
  $('#tb-branch').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const locals = S.refs.filter((x) => x.type === 'branch');
    showMenu([{ head: 'Checkout' }, ...locals.map((b) => ({ label: (b.name === S.info?.branch ? '✓ ' : '   ') + b.name, run: () => b.name !== S.info?.branch && run('checkout', { ref: b.name, kind: 'branch' }, { label: `Checkout ${b.name}` }) })), '-', { label: '새 브랜치…', run: () => newBranch('HEAD') }], r.left, r.bottom + 4);
  };

  document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => ACT[b.dataset.act]()));
  $('#banner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-banner]');
    if (!b) return;
    if (b.dataset.banner === 'abort') confirmRun(`${S.meta.op} abort`, '진행 중인 작업을 취소합니다', 'abort', { op: S.meta.op }, 'Abort');
    else run('cont', { op: S.meta.op }, { label: 'Continue' });
  });

  $('#search').addEventListener('input', (e) => { S.search = e.target.value.trim(); S.matchPos = -1; computeMatches(); renderRows(true); });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.target.value = ''; S.search = ''; computeMatches(); renderRows(true); sc.focus(); }
  });

  $('#diff-close').onclick = closeDiff;
  $('#diff-wrap').onchange = (e) => $('#diff-body').classList.toggle('wrap', e.target.checked);

  document.addEventListener('mousedown', (e) => { if (!e.target.closest?.('.menu')) closeMenus(); });
  window.addEventListener('blur', closeMenus);
  document.addEventListener('keydown', (e) => {
    if (!$('#modal-layer').hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && e.code === 'KeyF') { e.preventDefault(); $('#sb-filter').focus(); return; }
    if (mod && e.key === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
    if (mod && e.key === 'r') { e.preventDefault(); loadRepo(S.repo, { keep: true }); return; }
    if (e.key === 'Escape') { if ($('#menu-layer').children.length) closeMenus(); else if (!$('#diff-view').hidden) closeDiff(); return; }
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    const i = S.index.get(S.selected);
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); const n = i == null ? 0 : Math.min(S.view.length - 1, i + 1); S.view[n] && selectCommit(S.view[n].sha); }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); const n = i == null ? 0 : Math.max(0, i - 1); S.view[n] && selectCommit(S.view[n].sha); }
  });

  // resizable side panels
  document.querySelectorAll('.resizer').forEach((rz) => {
    const target = $('#' + rz.dataset.target);
    const saved = LS.get('w.' + rz.dataset.target);
    if (saved) target.style.width = saved + 'px';
    rz.onmousedown = (e) => {
      e.preventDefault();
      rz.classList.add('drag');
      const sx = e.clientX, sw = target.offsetWidth, sign = rz.dataset.target === 'sidebar' ? 1 : -1;
      const mv = (ev) => { target.style.width = Math.max(160, sw + sign * (ev.clientX - sx)) + 'px'; };
      const up = () => { rz.classList.remove('drag'); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); LS.set('w.' + rz.dataset.target, target.offsetWidth); renderRows(true); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    };
  });

  // auto refresh when the repo changes on disk (commits from terminal, etc.)
  setInterval(async () => {
    if (!S.repo || document.hidden || S.loading) return;
    try {
      const { fp } = await api('fingerprint', { repo: S.repo });
      if (S.fp && fp !== S.fp) { S.fp = fp; loadRepo(S.repo, { keep: true }); }
      S.fp = fp;
    } catch {}
  }, 2500);
  window.addEventListener('focus', () => S.repo && !S.loading && loadRepo(S.repo, { keep: true }));
}

// ---------------------------------------------------------------- boot
(async function boot() {
  bind();
  window.gittreeOpen = (p) => openTab(p);
  if (/Mac/.test(navigator.platform) && /Electron/.test(navigator.userAgent)) document.body.classList.add('mac-electron');
  const urlRepo = new URLSearchParams(location.search).get('repo');
  history.replaceState(null, '', '/');
  let active = LS.get('active');
  if (urlRepo) {
    active = urlRepo;
  }
  if (!active && S.tabs.length) active = S.tabs[0];
  if (!active) active = (await api('default')).repo;
  renderTabs();
  await openTab(active);
})();
