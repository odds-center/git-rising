# gittree

GitKraken 대신 쓰려고 만든 가벼운 git 그래프 뷰어. Electron 이라 macOS / Windows 둘 다 됩니다.

![](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-informational)

## 기능

- 저장소 탭 (여러 repo 동시에 열기, 최근 목록)
- 커밋 그래프 — BRANCH/TAG · GRAPH · MESSAGE · AUTHOR · DATE · SHA, 무한 스크롤
- 사이드바 — LOCAL / REMOTE(폴더 트리) / TAGS / WORKTREES / STASHES, 필터(⌘⌥F), ahead/behind 표시
- 커밋 상세 — 메시지, 작성자, parent 이동, 변경 파일(Path/Tree), 파일 클릭 시 diff
- 작업 중 변경(WIP) 행 — staged / unstaged 파일과 diff
- 우클릭 메뉴 — Fast-forward / Merge / Rebase, Checkout, Create branch, Cherry pick, Reset(soft/mixed/hard), Revert, Delete branch(로컬/원격), Copy branch name / sha / 원격 링크, Create tag / annotated tag
- 툴바 — Fetch, Pull, Push(업스트림 없으면 `-u origin`), Branch, Stash, Pop, Terminal, Finder/Explorer
- merge/rebase/cherry-pick 진행 중이면 상단 배너에서 Continue / Abort
- 터미널 등에서 repo 가 바뀌면 자동 새로고침
- 커밋 검색(⌘F, Enter/Shift+Enter 로 이동), ↑/↓ 또는 j/k 로 커밋 이동, 사이드바 브랜치 더블클릭 = checkout

## 실행

```bash
npm install
npm start                 # 또는: npm start -- /path/to/repo
```

## 설치 파일 빌드

```bash
npm run dist:mac          # dist/*.dmg
npm run dist:win          # dist/*.exe (Windows 에서 빌드 권장)
```

서명 안 된 빌드라 macOS 에서 처음 열 때는 우클릭 → 열기.

## 구조

- `src/main.js` — Electron main. `127.0.0.1` 임의 포트로 로컬 서버를 띄우고 창을 엶
- `src/server.js` — `git` CLI 를 호출하는 작은 HTTP API (의존성 없음)
- `public/` — UI (바닐라 JS + canvas 그래프)

시스템에 설치된 `git` 을 그대로 사용하므로 인증(ssh, credential helper)도 평소 설정 그대로 동작합니다.
