# Git Branch Tree

브랜치 이름의 `/` 를 **임의 뎁스 폴더 트리**로 펼쳐 보여주고, **leaf 브랜치를 클릭하면 체크아웃**하는 경량 VSCode 익스텐션.

기존 브랜치 트리 익스텐션들이 1뎁스만 접는 한계를, `foo/bar/abc/ticket-1234` 같은 3~4뎁스 전략에서도 제대로 펼쳐 해결합니다.

## 동작

```
Local                     ← 현재 워크스페이스 repo 의 로컬 브랜치
 ┣ sv-experience          (폴더)
 ┃ ┗ epic-p1
 ┃   ┗ henby              (브랜치 · 현재 ✓)
 ┗ master                 (브랜치)
Remote                    ← refs/remotes (네트워크 없이 로컬 캐시)
 ┗ origin                 (리모트 2개 이상일 때만 노출)
   ┗ ...
```

- **단일 클릭은 선택만**(동작 없음). 동작은 모두 **우클릭 컨텍스트 메뉴**.
- **체크아웃**: 로컬은 `git switch <name>`, 리모트 전용 브랜치는 DWIM 으로 같은 이름 로컬 추적 브랜치 자동 생성 후 전환. 더티 트리 등으로 막히면 git 에러를 그대로 알림.
- **브랜치 삭제**:
  - 로컬 — 모달에서 `[삭제]`(안전, `-d`) / `[강제 삭제]`(`-D`). 미병합이 거부되면 강제 여부 재확인.
  - 원격 서버 — `git push <remote> --delete`. 되돌릴 수 없어 모달 확인 필수.
- **새 브랜치 생성**: 툴바 `+` 또는 브랜치 우클릭(그 지점에서 분기). `git switch -c`.
- **Fetch + Prune**: 툴바 `sync` 또는 Remote 섹션 우클릭. 서버에서 사라진 추적 ref 정리.
- 현재 브랜치는 **초록 라벨 + ● 배지** + 뷰 열 때 자동 노출.
- 리모트는 1개면 이름을 접고, 2개 이상이면 리모트 이름 폴더를 한 단계 둠.
- 새로고침: 툴바 버튼 + 동작 후 자동 + 뷰가 다시 보일 때.

데이터는 전부 로컬 `git` CLI 로만 읽습니다. 삭제(원격)·fetch 만 네트워크를 쓰고, 그 외엔 **OAuth/네트워크 없음.**

## 개발

```bash
npm install
npm test            # 순수 트리 빌더 단위 테스트(vitest)
npm run check-types # 타입 체크
npm run compile     # esbuild 번들 → dist/extension.js
```

VSCode 에서 이 폴더를 열고 **F5** → Extension Development Host 가 뜨고, 활동 막대에 Branch Tree 아이콘이 생깁니다.

## 패키징(.vsix 사이드로드)

```bash
npm run vsix        # git-branch-tree-0.0.1.vsix 생성
code --install-extension git-branch-tree-0.0.1.vsix
```

## 범위

체크아웃 · 삭제(로컬/원격) · 새 브랜치 생성 · fetch+prune. 이름변경/별도 검색창은 제외(검색은 트리뷰 내장 타입어헤드로 충분). 단일 repo 가정.
