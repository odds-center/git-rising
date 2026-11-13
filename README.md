# Git Rising

<img src="build/icon.png" width="96" align="right">

가볍고 빠른 git 그래프 클라이언트. Electron 이라 **macOS / Windows** 둘 다 됩니다.
화면은 전부 한국어이고, 버튼·메뉴에 마우스를 올리면 하는 일과 실제 git 명령이 나옵니다.

## 설치

**릴리즈에서 받기** — [Releases](https://github.com/odds-center/git-rising/releases) 에서 `.dmg`(mac) / `.exe`(Windows).
서명 안 된 앱이라 맥에서 처음 열 때는 우클릭 → 열기. 이후에는 앱이 **스스로 업데이트**합니다.

**소스에서 바로 설치 (macOS)**

```bash
npm install
npm run install:mac      # 빌드해서 /Applications/Git Rising.app 으로 복사
```

개발 모드: `npm start` (또는 `npm start -- /path/to/repo`)

## 기능

| | |
| --- | --- |
| **저장소 자동 찾기** | 홈 폴더를 훑어 git 저장소를 찾아 최근 작업 순으로 보여줍니다 (`⌘O`). 워크트리는 원래 저장소 아래로 묶입니다. 검색 위치·깊이는 설정에서 변경 |
| **명령 팔레트** | `⌘K` — 저장소 열기, 브랜치 전환, 모든 명령을 한 곳에서 검색 |
| **커밋 그래프** | 브랜치/태그 · 그래프 · 메시지 · 작성자 · 날짜 · SHA. 헤더 경계를 드래그해 컬럼 너비 조절, 무한 스크롤 |
| **우클릭 작업** | 빨리감기 · 머지 · 리베이스 · **리셋(soft/mixed/hard)** · 전환 · 새 브랜치 · 다른 브랜치를 여기로 옮기기 · 체리픽 · 되돌리기 · 삭제 · 태그 · 링크 복사 |
| **원격과 똑같이 맞추기** | 현재 브랜치를 `origin/…` 과 완전히 같게 (`fetch` + `reset --hard @{u}`) |
| **되돌리기** | 방금 한 작업을 토스트의 [되돌리기] 또는 `⌘Z` 로 취소 (리셋·머지·브랜치 이동/삭제·전환 등) |
| **코드 보기** | 변경(통합 diff) · 좌우 비교(이전/이후) · 파일 전체 — 문법 색상 포함 |
| **프로필 · 로고** | 커밋 작성자 프로필 사진(GitHub), 저장소 로고(저장소 안의 로고 파일 → 없으면 조직/소유자 이미지) |
| **미리보기** | 이미지(이전/이후 비교) · PDF · 영상 · 오디오 · Word(docx) · 엑셀/CSV · Markdown. 그 밖의 형식은 [기본 앱으로 열기] |
| **내장 터미널** | 기본 셸이 그래프 아래 패널에 뜹니다 (`` ⌃` ``). 탭 여러 개, 저장소별로 유지 |
| **인증** | HTTPS / SSH 모두 지원. 암호가 필요하면 앱 안에 입력 창, 맥은 키체인에 저장해 다음부터 자동. 원격 추가·주소 변경·HTTPS↔SSH 전환, URL 로 복제(clone) |
| **검색** | `⌘F` — 메시지·작성자·SHA 를 **전체 히스토리**에서. 파일 우클릭 → 이 파일의 기록 |
| **Claude 연결 (MCP)** | Claude 가 저장소 목록 조회, 탭 열기, 상태/로그 확인, git 작업을 Git Rising 을 통해 실행 |
| **설정** | 테마(라이트/다크/시스템) · 강조 색 · 글자 크기 · 줄 간격 · 아바타 · 컬럼 · 자동 가져오기 · 풀 방식 · 셸 등 |
| **한글 / 인코딩** | EUC-KR(CP949)·Shift_JIS·GBK·UTF-16 파일도 diff 가 깨지지 않고, 맥의 자모 분리(NFD) 파일명도 정상 표시 |

## 가볍게 만든 부분

- **폴링 없음** — 파일 감시(fs.watch)로 바뀐 순간만 갱신하고, 창이 백그라운드면 감시를 멈춥니다. 열려 있는 탭 하나만 감시하므로 워크트리가 많아도 CPU 를 쓰지 않습니다.
- 커밋 목록은 보이는 줄만 DOM 으로 만들어 재사용하고, 그래프는 화면 크기 canvas 한 장.
- 그래프 배치는 추가분만 계산(증분), 커밋 상세·diff 는 캐시.

## Claude 에서 쓰기 (MCP)

앱의 **설정 → Claude 연결 → 등록** 을 누르면 `claude mcp add` 를 대신 실행합니다. 수동으로는:

```bash
claude mcp add --scope user git-rising -e ELECTRON_RUN_AS_NODE=1 -- \
  "/Applications/Git Rising.app/Contents/MacOS/Git Rising" \
  "/Applications/Git Rising.app/Contents/Resources/app/src/mcp.js"
```

도구: `list_repos` · `open_repo` · `repo_overview` · `list_branches` · `repo_log` · `show_commit` · `search_commits` · `git_action` · `set_scan_roots`
예) “docca 레포 열어줘”, “develop 을 master 로 reset --hard 해줘”, “최근 커밋 요약해줘”

## 단축키

| 키 | 동작 | 키 | 동작 |
| --- | --- | --- | --- |
| `⌘K` | 명령 팔레트 | `⌘O` | 저장소 찾기 |
| `⌘F` | 커밋 검색 | `⌘⌥F` | 브랜치 필터 |
| `↑ ↓` / `j k` | 커밋 이동 | `Shift+H` | HEAD 로 |
| `⌘Z` | 되돌리기 | `` ⌃` `` | 터미널 |
| `⌘1–9` | 탭 전환 | `⌘W` | 탭 닫기 |
| `Enter` | 첫 파일 diff | `?` | 단축키 도움말 |

## 릴리즈 만들기 (자동 업데이트 배포)

```bash
npm version patch          # package.json 버전 올리고 태그 생성
git push --follow-tags     # v* 태그 → GitHub Actions 가 mac/win 빌드를 Release 에 올림
```

설치된 앱은 6시간마다 최신 Release 를 확인하고, 상태바의 알림을 누르면 내려받아 교체 후 재시작합니다.

## 구조

- `src/main.js` — Electron 메인. 로컬 서버(127.0.0.1 임의 포트)를 띄우고 창을 엶
- `src/server.js` — 시스템 `git` 을 호출하는 HTTP API, 파일 감시(SSE), 터미널(WebSocket + node-pty)
- `src/updater.js` — GitHub Releases 기반 자동 업데이트
- `src/mcp.js` — MCP 서버 (stdio)
- `public/` — 화면 (바닐라 JS, canvas 그래프)
