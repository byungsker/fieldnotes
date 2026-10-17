# Fieldnotes 디자인 시스템

## 1. 분위기와 적용 원칙

조용한 로컬 글쓰기 작업 공간의 기존 녹색 계열과 문서 중심 구성을 유지한다. 앱·모바일·Markdown 편집기·육아 기록 미리보기는 같은 의미 토큰을 사용한다. 같은 역할에 별도 색·크기·간격을 만들지 않는다.

실행 값의 단일 정의는 `packages/markdown-live-editor/tokens.css`다. 편집기 `styles.css`가 이를 불러오므로 패키지만 복사한 환경에서도 같은 기본 테마가 적용된다. 앱의 `--ink`·`--surface`와 편집기의 `--mle-*`는 이 토큰을 가리키는 호환 별칭이며 별도 값이 아니다. `DESIGN.md`는 용도·척도·컴포넌트 계약을 정하고, 자동 검증은 문서·정의·참조의 일치를 검사한다.

## 2. 색상

원시 색상은 토큰 정의 파일에만 둔다. 상태·분류가 다른 경우만 아래 의미에 따라 구분하며, 비슷한 회색·녹색을 컴포넌트마다 추가하지 않는다. 밝은 테마와 어두운 테마의 역할은 동일하다.

| 토큰 | 밝은 테마 | 어두운 테마 | 용도 |
|---|---|---|---|
| `--ds-color-ink` | `#28322e` | `#e4ebe5` | 본문·제목 |
| `--ds-color-muted` | `#616d65` | `#a5b0a7` | 보조 설명·메타데이터 |
| `--ds-color-surface` | `#ffffff` | `#202722` | 문서·기본 패널 |
| `--ds-color-canvas` | `#f7f7f5` | `#171d19` | 앱 바탕·보조 영역 |
| `--ds-color-raised` | `#ffffff` | `#242d27` | 대화상자·팝오버·입력 |
| `--ds-color-hover` | `#f0f4ef` | `#29332c` | 가리킴 상태 |
| `--ds-color-selected` | `#eaf1e8` | `#2b3c30` | 선택 상태 |
| `--ds-color-line` | `#e7e9e5` | `#36423a` | 기본 경계·구분선 |
| `--ds-color-line-strong` | `#ccd7cf` | `#4a584d` | 강조된 중립 경계 |
| `--ds-color-accent` | `#4c735b` | `#a3c7a8` | 주요 동작·링크 |
| `--ds-color-accent-hover` | `#3f684a` | `#b2d4b7` | 주요 동작 가리킴 |
| `--ds-color-on-accent` | `#ffffff` | `#142017` | 주요 동작 위 텍스트 |
| `--ds-color-danger` | `#a63232` | `#efb3a7` | 오류·삭제 텍스트 |
| `--ds-color-danger-soft` | `#fff1ee` | `#482d28` | 오류 배경 |
| `--ds-color-danger-fill` | `#a63232` | `#a63232` | 삭제 버튼 배경 |
| `--ds-color-on-fill` | `#ffffff` | `#ffffff` | 삭제 버튼 위 텍스트 |
| `--ds-color-warning` | `#84612d` | `#f0d6a7` | 충돌·대기 텍스트 |
| `--ds-color-warning-soft` | `#fff8e8` | `#483923` | 충돌·대기 배경 |
| `--ds-color-info` | `#285e9a` | `#a8c7f0` | 정보·일정 파랑 |
| `--ds-color-info-soft` | `#edf5ff` | `#25374d` | 정보·일정 파랑 배경 |
| `--ds-color-rose` | `#9c3155` | `#f0b8c8` | 기록 분류 분홍 |
| `--ds-color-rose-soft` | `#fff0f4` | `#452b36` | 기록 분류 분홍 배경 |
| `--ds-color-violet` | `#6840a4` | `#d0b9f0` | 기록 분류 보라 |
| `--ds-color-violet-soft` | `#f2edfa` | `#352c46` | 기록 분류 보라 배경 |
| `--ds-color-highlight` | `#f4df95` | `#dfbf63` | 검색 일치 배경 |
| `--ds-color-highlight-ink` | `#28322e` | `#282414` | 검색 일치 텍스트 |
| `--ds-color-code-surface` | `#f3f5f1` | `#111713` | 코드 블록 배경 |
| `--ds-color-inline-code-surface` | `#edf0eb` | `#303b33` | 인라인 코드 배경 |
| `--ds-color-warm` | `#f3efea` | `#302a23` | 따뜻한 보조 면 |

성공과 주요 동작은 `--ds-color-success` → `--ds-color-accent`, 선택 면은 `--ds-color-accent-soft`·`--ds-color-success-soft` → `--ds-color-selected`로 연결한다. 키보드 포커스는 `--ds-color-focus` → `--ds-color-accent`, backdrop은 `--ds-color-backdrop`(검정 45%), loading shimmer는 `--ds-color-shimmer`(ink 8%)를 사용한다. `transparent`·`currentColor`·`inherit`는 브라우저 의미를 유지하는 키워드로 허용한다.

## 3. 글꼴과 글자 척도

- UI: `--ds-font-ui` — Avenir Next, Apple SD Gothic Neo, 플랫폼 sans-serif.
- 문서 제목·본문 heading: `--ds-font-document` — Iowan Old Style, Palatino, Apple SD Gothic Neo, Georgia, serif. 문서 heading과 앱 UI의 구분을 위한 기존 제품 정체성이다.
- 코드: `--ds-font-mono` — SF Mono, Menlo, Consolas, monospace.

| 토큰 | 크기 | 용도 |
|---|---|---|
| `--ds-text-caption` | `10px` | 촘촘한 보조 표기 |
| `--ds-text-meta` | `12px` | 메타데이터 |
| `--ds-text-control` | `14px` | 동작·폼 |
| `--ds-text-body` | `16px` | 일반 본문 |
| `--ds-text-reading` | `17px` | 문서 본문 |
| `--ds-text-list-title` | `18px` | 목록 제목 |
| `--ds-text-h4` | `20px` | 작은 소제목 |
| `--ds-text-h3` | `24px` | 소제목 |
| `--ds-text-h2` | `28px` | 중간 제목 |
| `--ds-text-h1` | `32px` | 큰 제목 |
| `--ds-text-display` | `40px` | 화면 제목 |
| `--ds-text-code` | `.9em` | 주변 글자에 비례하는 코드 |

본문은 body 16px, 문서 읽기는 reading 17px다. meta 12px와 caption 10px는 밀집된 탐색 메타데이터만 사용하고 설명 본문에는 쓰지 않는다. 상대 코드 크기는 `--ds-text-code: .9em`다. 가변 제목은 `clamp()`의 양 끝에 제목 토큰을 사용한다.

굵기는 `--ds-weight-regular/medium/semibold/bold` = 400/500/600/700, 행간은 `--ds-leading-tight/heading/control/body/reading` = 1.2/1.3/1.4/1.6/1.8이다. 자간은 `--ds-tracking-tight/normal/label` = -.025em/0/.08em만 사용한다.

## 4. 간격과 배치

4px를 기본 단위로 하고 밀집된 아이콘 정렬에는 half 2px만 허용한다. 화면별로 5·7·9·11px 등을 새로 만들지 않는다.

| 토큰 접미사 (`--ds-space-*`) | 값 |
|---|---|
| `0` | `0` |
| `half` | `2px` |
| `1` | `4px` |
| `2` | `8px` |
| `3` | `12px` |
| `4` | `16px` |
| `5` | `20px` |
| `6` | `24px` |
| `7` | `28px` |
| `8` | `32px` |
| `9` | `36px` |
| `10` | `40px` |
| `12` | `48px` |
| `14` | `56px` |
| `16` | `64px` |
| `20` | `80px` |
| `24` | `96px` |
| `28` | `112px` |

문서 내부의 글자 상대 간격은 `--ds-prose-quarter/half/flow/section/indent` = .25/.5/1/1.5/2em을 사용한다.

컨트롤 높이는 `--ds-control-compact/default/touch` = 32/40/44px다. 모바일 동작 버튼은 touch 이상을 유지하며 입력 글자는 body 16px로 iOS 자동 확대를 방지한다. 아이콘은 `--ds-icon-sm/md/lg/xl` = 12/16/20/24px다.

배치 폭은 `--ds-layout-sidebar/list/document/dialog` = 228/330/1100/520px다. 반응형 경계는 기존 820px(모바일), 560px(편집기), 520/380/360/340px(좁은 화면 보정)을 유지한다. CSS custom property는 media 조건에서 사용할 수 없어 이 경계만 원시 px로 둔다. `auto`, `%`, `fr`, viewport 단위, `minmax()`, 실제 콘텐츠 크기 제한, 트리 깊이·드래그 좌표·일정 시간에 따라 계산한 값은 배치 연산이며 임의 디자인 토큰으로 늘리지 않는다.

## 5. 재사용 컴포넌트 계약

| 패턴 | 구현 | 공통 계약 |
|---|---|---|
| 동작·아이콘 버튼 | 앱 `.icon-button`, `.text-tool`, 편집기 `ToolbarButton`·`.mle-tool-button` | 같은 control 높이·radius-md·control 글자, hover/selected 면·focus 토큰, disabled 상태 |
| 문서·폴더 탐색 행 | `.document-row`, `.explorer-file-row`, `.folder-tree-row` | 중립 line, hover/selected 면, 키보드 포커스, 모바일 44px 이상 동작 영역 |
| 입력·선택 | 앱 폼, `.mle-language-select`, 편집기 대화상자 | raised 면, ink/muted, line, radius-md, 명시적 접근성 이름 |
| 대화상자 | `ActionDialog`, `VaultSettingsDialog`, `.mle-link-dialog` | surface/raised, backdrop, radius-xl, shadow-lg; 헤더·동작 고정, 내용 영역만 스크롤 |
| 문서·원문 보존 | `MarkdownLiveEditor`, `PreservedMarkdownPreview` | reading 글자·행간, 원문 직렬화 보존, 코드 면 토큰, 안전한 링크·이미지 |
| 시각화·육아 기록 카드 | `FieldnotesViewBlock`, `BabiesDataview` | surface/canvas, radius-lg, space-3/4, 상태 의미 색, 분류 색은 info/rose/violet/warning/success만 사용 |

새 상태나 변형도 먼저 이 계약과 토큰으로 표현한다. 같은 역할의 컨트롤을 별도 hex·px로 꾸미지 않는다. 사용자 작성 `fieldnotes-view`의 격리된 HTML/CSS는 문서 콘텐츠이며 호스트 디자인 계약을 강제로 주입하지 않는다. sandbox·CSP·원문 보존 계약은 유지한다.

## 6. 움직임과 상호작용

`--ds-duration-fast/normal/slow/pulse/reduced` = 120/180/240/1600/.01ms, `--ds-ease-standard` = cubic-bezier(.2, .7, .2, 1), `--ds-ease-linear` = linear다. 클릭·저장·오류 반응은 해당 동작 옆에 표시한다. 로딩·탐색의 기존 동작을 유지하고 장식용 애니메이션을 추가하지 않는다. `prefers-reduced-motion`에서는 reduced 값을 사용한다.

## 7. 깊이·경계·모서리

중립 경계와 필요한 팝오버·대화상자 그림자를 함께 사용한다. `--ds-border-width` = 1px, `--ds-focus-width/offset` = 2px다. 상태는 면·텍스트·아이콘으로 표현하고 선택된 카드에 장식용 색 테두리를 추가하지 않는다. 키보드 focus-visible의 윤곽은 유지한다.

| 토큰 | 값 | 용도 |
|---|---|---|
| `--ds-radius-sm` | `4px` | 작은 코드·배지 |
| `--ds-radius-md` | `8px` | 버튼·입력 |
| `--ds-radius-lg` | `12px` | 카드·패널 |
| `--ds-radius-xl` | `20px` | 대화상자·시트 |
| `--ds-radius-full` | `9999px` | pill·원형 지표 |
| `--ds-shadow-sm` | `0 2px 8px rgb(0 0 0 / 8%)` | 작은 떠 있는 도구 |
| `--ds-shadow-md` | `0 8px 24px rgb(0 0 0 / 14%)` | 팝오버 |
| `--ds-shadow-lg` | `0 16px 48px rgb(0 0 0 / 24%)` | 대화상자 |

## 8. 접근성·예외·검증

- 기본 본문과 보조 텍스트는 실제 바탕에서 4.5:1 대비를 목표로 검증한다. 포커스는 보이며 버튼·폼·영역은 의미 있는 HTML과 접근성 이름을 유지한다.
- 390px·넓은 화면, 밝은·어두운 테마에서 문서·탐색·대화상자·미리보기의 가로 넘침과 컨트롤 상태를 확인한다. 기기 실측과 브라우저 크기 검증을 구분한다.
- 자동 검증은 토큰 밖 원시 색상, font-size·간격·모서리 값, 정의되지 않은 토큰, 문서에서 빠진 토큰·테마 차이를 차단한다. 크기 계산·media 조건과 명시적인 외부 프로토콜 데이터는 위 4절의 예외다.
- theme-color 메타데이터는 CSS canvas 토큰에서 읽는다. favicon 등 정적 브랜드 자산은 콘텐츠로 보존한다. 사용자 시각화 코드와 제3자 스타일은 자동 수정하지 않는다.
- 이 변경에서 대비·모바일 동작·원문 보존을 낮추는 예외는 승인하지 않는다. 확인하지 않은 실제 기기·보조기술 검증을 완료로 기록하지 않는다.
