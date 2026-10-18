# Mobile document redesign QA

## References and captures

- Reference images: `../.private-materialized-screenshots/IMG_5691.png` and `../.private-materialized-screenshots/IMG_5692.png` (each 942 × 2048 px). They were materialized through the Library workflow, viewed, and kept outside the repository.
- Synthetic implementation captures: `../.private-materialized-screenshots/fieldnotes-mobile-synthetic-390x844.png` and `../.private-materialized-screenshots/fieldnotes-mobile-synthetic-scroll-390x844.png` (390 × 844 px).
- Final side-by-side comparisons: `../.private-materialized-screenshots/notion-fieldnotes-comparison-780x844.png` and `../.private-materialized-screenshots/notion-scroll-fieldnotes-comparison-780x844.png` (780 × 844 px). The reference images were scaled to 390 px wide and center-cropped by 4 px vertically for an exact 390 × 844 comparison pane.
- Browser: isolated headless Chrome, mobile emulation, CSS viewport 390 × 844, device scale factor 1. Synthetic Fieldnotes data and a temporary SQLite database under `/tmp` were used. No source library data or note bodies were imported.

## Result

**passed** — no actionable P0, P1, or P2 visual defects remain in the reviewed mobile document screens.

The top-of-document comparison matches the reference's compact pinned title context, large heading, icon-led property rows, muted labels, thin divider, dark surface, and comfortable body spacing. The scrolled comparison keeps the title and action bar pinned while the note body scrolls. Fieldnotes uses its own status, folder, version, save, write, preview, and delete controls; these preserve the app's existing functions while following the reference's compact document hierarchy. Desktop continues to use the existing non-Stackflow workspace.

## Reviewed surfaces

- **Typography:** Mobile title is approximately 34 px; body is 17 px with about 29 px line height. Labels and dates stay subordinate and legible.
- **Spacing and layout:** Property labels align with values, the metadata divider clearly separates the body, the title/action toolbar stays pinned during document scroll, and the 390 px viewport has no horizontal overflow.
- **Colors and tokens:** The default dark surface and muted text follow the existing theme. The reference and implementation use a similar near-black canvas, soft white body text, and low-contrast secondary labels. Light mode continues to use existing theme tokens.
- **Images and assets:** The document view uses the existing Lucide icon package. No new image asset or dependency was added.
- **Content and copy:** The preview and edit views were populated with a synthetic Korean note covering paragraphs, a heading, bullets, a wikilink, and a callout. App-specific labels remain unchanged.

## Interaction and runtime checks

- Preview opens by default; Write and Preview controls switch modes.
- `⌘E` switches to Write and back to Preview.
- The mobile folder context remains visible under the document title.
- A 1280 × 900 viewport renders the existing desktop workspace directly, without the mobile Stackflow shell.
- The isolated browser reported zero console messages for the app URL and zero runtime exceptions.
- Chrome emulation was used. A physical iPhone and Safari were not available for verification.

## Iteration notes

The first review found the folder context hidden by a generic mobile rule; the document-specific rule was corrected and the view captured again. The initial synthetic note did not scroll far enough to compare the compact pinned header, so it was extended with generic synthetic paragraphs and recaptured. The final top and scrolled comparison images above were reviewed together at equal viewport dimensions.

## 2026-10-07 search, properties, and panel QA

- Four additional Library reference screenshots were materialized through the private Library workflow and viewed. They showed the duplicate search clear affordance, the visible `Search: …` query tag, frontmatter text leaking into excerpts, and the mobile note property/toolbar layout. The source images remain outside this repository.
- QA ran in a fresh Chrome profile against an isolated loopback Vite/API pair and a temporary synthetic SQLite database under `/tmp`; it did not open or write the production database. The synthetic note included Korean, English, punctuation, raw HTML text, and YAML frontmatter.
- The desktop Notes list collapsed independently from the folder sidebar, expanded editor width from 882 px to 1212 px, survived reload, and reopened through an accessible control. The folder sidebar remained collapsed when reopening the note list.
- Browser search tests found and highlighted Korean, English, and punctuation literally; the query tag was absent; the custom clear button cleared search and keyboard insertion still edited the input. The single visible clear affordance was captured; temporarily hiding the custom button left no native X visible.
- Folder filtering returned only the synthetic note in its selected folder. Search snippets centered a mid-body match and omitted YAML fields. The raw note body including frontmatter remained unchanged.
- Desktop and mobile note views shared Status, Created, Folder, Updated, and Version properties. Mobile screenshots were reviewed at 320, 360, and 390 px; note and list views had no horizontal page overflow. Write, Preview, Save, and Delete targets measured 44 × 44 px at 390 px; Write/Preview/Save labels were visually hidden while accessible names remained. The toolbar stayed sticky at top 0 and the document editor had 36 px top padding.
- Date unit tests cover 23 h 59 min versus exactly 24 h, Korean calendar formatting across UTC midnight, and invalid timestamps. Lint, typecheck, and the isolated integration suite passed (35 tests). The visual browser was Chrome emulation; physical iPhone Safari was not tested.

Synthetic captures are kept outside Git under `/tmp/fieldnotes-qa-*`; no reference or user-data images were added to the repository.

## 2026-10-18 공통 디자인 토큰 검증

기존 기록과 별도로 이번 토큰 변경을 검증했다. 앱·편집기·육아 기록의 실행 값은 `packages/markdown-live-editor/tokens.css`, 용도와 척도는 `DESIGN.md`를 기준으로 한다.

- 환경: 합성 문서·사진을 넣은 임시 vault와 빌드된 Node 22 서버. 실제 vault와 운영 데이터는 사용하지 않았다.
- 브라우저: Aside에서 데스크톱 1440×900을 먼저 확인했다. 해당 연결에 viewport 변경 API가 없어 모바일은 독립 Chrome 프로필에서 390×844, device scale factor 1, 터치 에뮬레이션으로 검증했다. 실제 iPhone·Safari 결과와 구분한다.
- 밝은·어두운 테마의 탐색·문서·삭제 대화상자·육아 대시보드를 확인했다. 문서·목록·대화상자·미리보기에 가로 넘침이 없었고, 편집기 `--mle-ink`와 앱의 공통 ink 값이 일치했다. 문서 글자는 17px, 행간은 30.6px이었다.
- 모바일 폴더 선택은 16px 글자와 44px 높이, 뒤로·삭제·목차·대화상자 버튼은 44px 동작 영역을 확인했다. 대화상자의 40px 버튼과 폴더 선택의 14px 우선순위 문제를 수정한 뒤 다시 측정했다. 아이콘은 공통 크기 토큰을 사용하며 닫기 아이콘은 20px로 표시되었다.
- 모바일 대시보드의 4열 규칙이 반응형 규칙보다 우선하던 문제를 수정해 통계 카드를 2열로 표시했다. 일정 분류색과 오늘 표시는 공통 의미 토큰을 따른다.
- 모바일 탐색에서 밝은 테마 전환을 조작했고 브라우저의 theme-color가 canvas 토큰과 함께 변경되었다. 어두운 테마 재진입에서도 canvas와 theme-color가 일치했다. 대화상자에서 Tab으로 이동한 삭제 버튼의 포커스는 공통 accent의 2px 윤곽이었다.
- 본문을 편집해 Unsaved→Saved와 version 1→2를 확인했다. API의 저장된 본문에 입력한 문구와 원래 `![[/photos/example.png]]`가 함께 남아 있었다. 삭제 대화상자는 취소로 닫았다.
- 자동 검증은 원시 색상·별도 글자/간격/반경 값·아이콘 크기, 정의되지 않은 토큰, 문서의 색상·글자·간격 표 불일치, 호환 별칭 순환·의미 불일치, 두 테마의 주요 텍스트 색 조합 4.5:1 대비를 검사한다.

Node 22에서 루트 린트·185개 테스트·타입 검사를 포함한 빌드가 통과했다. 편집기 디렉터리만 저장소 밖으로 복사한 환경에서도 `npm ci`, 타입 검사, 55개 테스트가 통과했다. 빌드의 기존 대형 청크 경고는 별도 성능 검증 결과로 간주하지 않는다.

이번 캡처와 측정은 로컬 `.omo/evidence/design-tokens-20261018/`의 `desktop-{light,dark}-*.png`, `mobile-{light,dark}-*.png`, `browser-metrics.jsonl`, `autosave.json`에 남겼다. 생성한 이미지와 합성 저장소는 Git에 포함하지 않는다.

## 2026-10-18 사용자 JS 기록 뷰 검증

기록 종류를 앱 코드에서 분리한 변경을 합성 vault와 빌드된 Node 22 서버에서 검증했다. 기존 디자인 토큰 기록은 당시 결과로 남긴다.

- Aside 데스크톱에서 책 예시의 소스 검토·승인, 기록 생성, 완료 변경, 완료 숨김, 문서 열기를 조작했다. 육아 예시도 같은 승인 흐름과 공통 iframe에서 표시되었다.
- Aside에 viewport 변경 API가 없어 별도 임시 Chrome 프로필에서 390×844, scale factor 1, 모바일·터치 에뮬레이션을 사용했다. 영화 기록 생성과 임의의 `exercise-qa` 카테고리 생성·완료 변경이 동작했다. 앱을 다시 빌드하거나 카테고리를 등록하지 않았다.
- 승인 철회 후 iframe이 사라지고 `Trust was revoked. This script has stopped.` 상태가 표시되었다. 기록은 남았다.
- 저장 결과를 API로 다시 읽어 생성한 세 기록의 type과 완료 값을 확인했다. 기존 `babies/legacy.md`의 DataviewJS는 실행되지 않는 안내로 표시되었고 원문 SHA-256은 초기값과 같았다.
- 공통 로컬 이미지 URL이 `/api/views/assets/:id?asset=...&v=...`로 생성되었고 합성 PNG의 `complete=true`, natural size 1×1을 확인했다. 전용 육아 이미지 경로는 사용하지 않았다.
- 밝은·어두운 앱 화면과 데스크톱·모바일 렌더링을 확인했다. 모바일 문서의 viewport와 root scrollWidth는 모두 390px이었다. 사용자 JS 내부 스타일은 격리된 runner의 기본 스타일을 사용한다. 실제 iPhone·Safari는 검증하지 않았다.

Node 22에서 루트 린트·171개 테스트·타입 검사를 포함한 빌드가 통과했다. 편집기만 별도로 복사한 환경의 설치·타입 검사·55개 테스트도 통과했다. 제거된 전용 동작의 테스트를 공통 카테고리 CRUD·원문 보존·제거 경로 거부 검증으로 교체했으며 기존 격리·승인·이미지 검증은 유지했다.

로컬 `.omo/evidence/generic-js-views-20261018/`에 브라우저 캡처, 저장 결과, 검증 로그를 남겼다. 캡처와 합성 저장소는 Git에 포함하지 않는다. 검증용 탭·Chrome 프로필·임시 서버와 vault를 종료·정리했다.
