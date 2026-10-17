# 프런트엔드 작업 지침

## 변경 위치

| 관심사 | 먼저 확인할 파일 |
|---|---|
| React 마운트와 스타일 로딩 순서 | `app/main.tsx`, `app/styles.css` |
| 문서·폴더 화면, 선택 상태, 저장 큐, 외부 변경 | `pages/workspace/ui/WorkspacePage.tsx` |
| HTTP 요청과 오류 분류 | `shared/api/request.ts`, `pages/workspace/model/workspace-types.ts` |
| 편집기 호스트 기능과 브라우저 저장소 | `pages/workspace/api/editor-adapters.ts` |
| 로컬 draft 형식·복구·비교 | `pages/workspace/model/autosave.ts` |
| URL 변환과 브라우저 history 상태 | `pages/workspace/model/workspace-routing.ts` |
| 모바일 activity와 화면 context | `pages/workspace/ui/MobileWorkspace.tsx`, `pages/workspace/config/activities.ts`, `pages/workspace/ui/WorkspaceViewContext.ts` |
| 앱 shell, 목록·편집 영역, 반응형 스타일 | `app/styles.css` |

## 편집과 저장

- `pages/workspace/model/autosave.ts`는 draft 도우미이며 실제 타이머·문서별 저장 큐는 `pages/workspace/ui/WorkspacePage.tsx`에 있다. 저장 동작을 바꿀 때 두 파일을 함께 읽는다.
- 제목·본문·폴더 변경은 화면 state와 최신 값을 읽는 ref, draft snapshot이 일치하도록 갱신한다. 비동기 응답에서 오래된 렌더 값을 사용하지 않는다.
- 문서별 `pendingWritesRef`·`activeWritesRef`의 직렬 처리와 revision 비교를 유지한다. 요청 중 추가 입력이 생겼다면 완료 응답으로 최신 draft를 지우지 않는다.
- 로컬 draft의 `baseVersion`·`baseHash`와 저장된 문서 기준값을 구분한다. 새로 읽은 버전을 미해결 draft에 자동 적용해 충돌을 숨기지 않는다.
- 외부 수정·삭제를 받았을 때 편집 중인 draft를 보존하고 자동 저장을 중단한다. 최신본 불러오기와 사용자 확인을 거친 덮어쓰기 흐름을 유지한다.
- 자신의 저장 응답과 외부 변경 알림이 겹치는 경로를 함께 확인한다. 외부 최신본이 도착한 뒤 늦은 저장 응답으로 상태를 되돌리지 않는다.
- 제목과 본문 모두 IME composition 상태를 반영한다. 조합 중에는 자동·수동 저장을 막고, 조합 종료 뒤 완성된 값으로 저장을 재개한다.
- 편집기의 Markdown 직렬화 안전 여부를 저장 조건에 포함한다. 안전하지 않은 본문은 로컬에 보존하고 오류 상태를 표시한다.
- 새 문서는 의미 있는 입력 전까지 로컬 draft로 유지한다. 문서 전환·새로고침 복구와 localStorage 실패 안내를 보존한다.

## 탐색과 모바일 화면

- URL과 activity의 변환은 `workspace-routing.ts`에 모은다. 경로 추가 시 `stackflow.config.ts`와 activity 등록도 함께 확인한다.
- 브라우저 URL·history는 `pages/workspace/ui/WorkspacePage.tsx`의 navigation 경로로 갱신한다. `mergeWorkspaceHistoryState`로 다른 history 필드를 보존하고 `popstate`에서 route와 index를 함께 복원한다.
- 모바일 Stackflow는 별도 memory history를 사용한다. 활성 activity를 앱의 `currentRoute`에 맞추는 연결을 유지하고 브라우저 history를 중복으로 push하지 않는다.
- 모바일 drawer는 별도 history 항목을 가진다. 뒤로 가기로 drawer를 먼저 닫는 동작과 닫힌 뒤 대기 중 탐색을 처리하는 순서를 확인한다.
- 820px 이하의 모바일 Stackflow와 그보다 넓은 데스크톱 렌더러를 함께 확인한다. 화면 전환으로 선택 문서·draft가 사라지지 않게 한다.
- 활성 activity에만 포커스와 목록 스크롤을 복원한다. 목록 복귀 시 문서 anchor·offset을 사용하고, 해당 항목이 없으면 저장된 scrollTop으로 복원한다.
- 모바일 문서의 고정 도구 모음과 본문 스크롤 영역을 구분한다. `styles.css` 변경 시 가로 넘침·대화상자·drawer·터치 영역도 확인한다.

## API와 편집기 연결

- 앱 요청은 `apiRequest`와 `ApiError`의 오류 전달 방식을 따른다. 상태 코드·오류 코드·현재 버전 정보가 충돌 UI까지 전달되도록 유지한다.
- 호스트 API·localStorage 기능은 `createFieldnotesEditorAdapters`에서 편집기 계약으로 연결한다. 앱의 저장·탐색 상태를 재사용 편집기 내부로 옮기지 않는다.
- 외부 변경 구독은 `vault-change-subscription.ts`와 연결해 확인한다. 새 구독이 기존 정리·재연결 흐름을 누락하지 않게 한다.
- 앱 shell 스타일과 편집기 패키지 스타일의 소유 범위를 구분한다. `app/main.tsx`의 CSS 로딩 순서가 바뀌면 두 영역의 우선순위를 확인한다.

## 검증 선택

- 저장 변경은 `../test/autosave.test.ts`, 외부 알림 변경은 `../test/vault-change-subscription.test.ts`, 탐색 변경은 `../test/workspace-routing.test.tsx`를 우선 확인한다.
- 모바일 변경은 관련 `../test/mobile-*.test.ts`와 `../test/explorer-touch-targets.test.ts`를 선택한다. Node 기반 결과만으로 실제 브라우저 조작·시각 검증을 완료했다고 판단하지 않는다.
- 브라우저에서는 한글 조합 입력, 저장 중 추가 편집, 외부 충돌, 문서 전환 후 draft 복구, URL 직접 진입, 뒤로·앞으로 이동 중 변경 영역에 해당하는 시나리오를 확인한다.
- 수동 UI 결과는 `../design-qa.md`의 기록 방식과 구분해 남긴다. 실제 실행한 브라우저·viewport·조작·결과·캡처 경로를 적고 기존 기록의 통과 결과를 재사용하지 않는다.
- 모바일 에뮬레이션 결과와 실제 기기 결과를 구별하고, 이번에 확인하지 않은 환경은 검증했다고 적지 않는다.
