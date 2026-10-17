# Markdown Live Editor 작업 지침

이 디렉터리는 호스트 앱이 값을 제어하는 React Markdown 편집기다.
공통 작업 규칙은 루트 `AGENTS.md`를 따르고, 편집기의 동작 계약은 이 패키지 `README.md`와 구현을 함께 확인한다.

## 공개 경계와 호스트 연결

- 공개 진입점은 `index.ts`이며 스타일 진입점은 `styles.css`다. export 변경 시 `package.json`의 `exports`와 소비 코드를 함께 확인한다.
- `types.ts`의 `MarkdownLiveEditorProps`와 `MarkdownLiveEditorAdapters`가 호스트 연결 계약이다.
- 문서 값은 `value`로 받고 변경은 `onChange`로 전달한다. 호스트가 최신 값을 되돌려 줄 때 편집 상태와 선택 영역을 불필요하게 초기화하지 않는다.
- 저장·네트워크·인증 책임은 호스트에 둔다. 이미지 업로드, 북마크 조회, 스니펫, 시각화 query/action은 선택적 어댑터를 통해 주입한다.
- 어댑터가 없을 때 앱 API 주소나 저장소를 직접 참조하는 대체 경로를 추가하지 않는다.
- 시각화 계약과 이벤트 검증의 단일 정의는 `visualization-contract.ts`다. `../../shared/visualization.ts`는 이를 재export한다. 패키지에서 상위 저장소 소스를 import하거나 계약을 복제하지 않는다.
- 호스트별 보존 블록 UI는 `renderPreservedBlock`으로 주입한다. `null`·`undefined`를 반환하면 안전한 기본 미리보기를 사용하며 원문 직렬화는 바뀌지 않는다. 렌더러는 신뢰할 수 있는 호스트 React UI를 반환하며 보존된 사용자 JavaScript를 직접 실행하지 않는다.
- 로컬 이미지 경로는 먼저 패키지에서 검증한 뒤 선택적 `resolveLocalImage`에 원문 source와 해석한 assetPath를 전달한다. 전용 폴더·API 선택과 문서 조회·생성은 호스트가 소유한다.

## 원문 보존 경로

| 파일 | 변경 시 확인할 책임 |
|---|---|
| `MarkdownLiveEditor.tsx` | 호스트 제어값 동기화, 보호된 frontmatter, 편집 결과 직렬화 |
| `markdown-preservation.ts` | 블록별 parse/serialize 동일성 검사와 보존 노드 생성 |
| `markdown-line-endings.ts` | LF/CRLF 판별·복원과 마지막 개행 보존 |
| `PreservedMarkdownExtension.tsx` | 원문 Markdown과 공백 보존 노드의 표시·직렬화 |
| `markdown-safety.ts` | 선두 frontmatter 분리와 URL·이미지 안전성 검사 |

- 지원하지 않거나 정확히 왕복 변환할 수 없는 구문은 원문을 가진 보존 카드로 남긴다. 주변 지원 블록은 계속 편집할 수 있어야 한다.
- 안전하게 블록을 나눌 수 없으면 전체 원문을 보존한다. 미지원 구문 때문에 소스 편집 모드로 전환하거나 내용을 자동 재작성하지 않는다.
- 초기 로드, 외부 값 갱신, 붙여넣기, 스니펫 삽입에 같은 보존 파서를 적용한다.
- 닫힌 선두 YAML frontmatter, 뒤의 구분 공백, BOM을 보호된 접두부로 유지한다. 호스트 문서 속성으로 덮어쓰지 않는다.
- 균일한 LF/CRLF와 마지막 개행 수를 복원한다. 혼합 LF/CRLF 또는 bare CR은 정규화하지 않고 전체 원문 카드로 보존한다.
- `onSerializationSafetyChange(false)`는 예상하지 못한 직렬화 실패를 알리는 계약이다. 단순 미지원 구문을 실패로 취급하지 않는다.
- wikilink와 `fieldnotes-view` 같은 원자 노드의 원래 토큰·펜스를 재생성하거나 정규화하지 않는다.

## 렌더링과 실행 경계

- Markdown의 원시 HTML을 실행 가능한 DOM으로 렌더링하지 않는다. 원문 보존과 HTML 실행은 구분한다.
- 링크 삽입은 안전한 URL 검사와 구조화된 ProseMirror text node/mark를 사용한다. 사용자 문자열을 HTML에 보간하지 않는다.
- `fieldnotes-view` 사용자 JavaScript는 정확한 문서 ID, 블록 인덱스, 소스 지문에 대한 명시적·철회 가능한 승인 후에만 실행한다.
- 소스나 문서·블록 맥락이 바뀌면 이전 승인을 재사용하지 않는다. 호스트 문맥에서 사용자 JavaScript를 직접 실행하지 않는다.
- `FieldnotesViewBlock.tsx`와 `SandboxedVisualization.tsx`의 승인·sandbox·MessagePort 검증을 함께 확인한다.
- 실행 경계는 `../../public/visualization-runner.js`, runner HTML, `../../server/api.ts`, 공용 타입 action 검증까지 이어진다. 브라우저의 로컬 승인을 서버 쓰기 권한으로 취급하지 않는다.
- 보존된 `dataviewjs` 원문을 임의 실행하는 기능으로 확장하지 않는다. 지원 미리보기가 있어도 원문 보존 계약을 유지한다.

## 패키지 관리와 검증 위치

- 의존성 변경은 이 디렉터리의 `package.json`과 `package-lock.json`을 기준으로 한다. 독립 `tsconfig.json`의 검사 범위도 확인한다.
- 패키지 코드 검증 명령은 이 디렉터리에서 `npm run typecheck`, `npm test`다. 루트 검증과 패키지 검증 결과를 혼동하지 않는다.
- 원문 보존 변경은 `markdown-roundtrip.test.ts`, `markdown-line-endings.test.ts`, `node-view-regression.test.ts`의 관련 시나리오를 확인한다.
- URL·미리보기·시각화 변경은 `markdown-safety.test.ts`, `preserved-block-preview.test.ts`, `preserved-markdown-preview.test.ts`, `fieldnotes-view-config.test.ts` 및 관련 `visualization-*.test.ts`를 확인한다. 육아 기록 호스트 연결은 `../../test/workspace/baby-preview-integration.test.ts`와 `babies-dataview.test.ts`에서 확인한다.
- 독립성을 확인할 때 이 패키지만 임시 디렉터리에 복사하고 `npm ci`, `npm run typecheck`, `npm test`를 실행한다. 상위 저장소의 node_modules나 shared 소스가 없어도 통과해야 한다.
- 스타일은 `.mle-*` 클래스와 `--mle-*` 변수를 유지하고 호스트 전역 스타일에 영향을 주는 선택자를 추가하지 않는다.
- `licenses/`의 원본 라이선스 문구는 보존한다. 패키지 설명을 갱신하면서 번역하거나 재작성하지 않는다.
