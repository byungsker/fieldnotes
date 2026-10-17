# Fieldnotes 작업 지식 기반

## 개요

Fieldnotes는 React·TypeScript 인터페이스와 Node API로 구성된 로컬 우선 Markdown 지식 베이스다. 웹 진입은 `index.html` → `src/app/main.tsx` → `src/pages/workspace` 공개 API, API 진입은 `server/index.ts`다. 기본 저장소는 SQLite이며 `KB_VAULT_DIR`를 설정하면 Markdown 파일이 원본 데이터가 되고 SQLite는 재생성 가능한 검색·변경 인덱스가 된다.

## 구조

```text
fieldnotes/
├── .github/workflows/                # PR·main 자동 검증
├── src/
│   ├── app/                          # React 마운트와 전역 스타일
│   ├── pages/workspace/              # 탐색·편집 workspace 페이지 슬라이스
│   └── shared/api/                   # 브라우저 API transport
├── server/
│   ├── api.ts / index.ts             # HTTP 조합, 보안·SSE·프로세스 수명
│   ├── view-query-limits.ts          # 저장소·시각화 공용 조회 제한
│   ├── routes/                       # 기능별 API 등록
│   ├── http/                         # 요청 검증과 오류 응답
│   ├── storage/                      # 저장소 공개 API와 모드 선택
│   │   ├── database/                 # SQLite 스키마·조회·변경·vault 인덱스
│   │   └── vault/                    # 파일 접근·manifest·이관 내부 구현
│   ├── visualization/                # 시각화 조회·자산·frontmatter
│   └── bookmarks/                    # 북마크 metadata 조회
├── shared/                           # 브라우저·서버·편집기 공용 타입과 함수
├── packages/markdown-live-editor/    # 외부에서 상태를 제어하는 React Markdown 편집기
├── public/                           # 테마 초기화와 격리 시각화 runner
├── scripts/                          # CLI, 백업·복원·이관, LaunchAgent 운영
├── test/
│   ├── api/ / storage/ / runtime/    # HTTP·저장·종료 통합 검증
│   ├── workspace/ / visualization/ # 화면 모델·시각화 검증
│   └── fixtures/                     # 합성 Markdown 데이터
├── docs/                             # 저장소·운영·보안 문서
├── API.md / DESIGN.md                # API와 제품 동작 계약
└── package.json / vite.config.ts     # 실행 명령과 개발·빌드 설정
```

## 작업 위치

| 작업 | 위치 | 기준 |
|---|---|---|
| 앱 화면·탐색·저장 상태 | `src/pages/workspace/ui/WorkspacePage.tsx`, `src/pages/workspace/model/workspace-routing.ts`, `src/pages/workspace/ui/MobileWorkspace.tsx` | 자동 저장·히스토리·모바일 이동 흐름을 함께 확인 |
| UI와 API 연결 | `src/shared/api/request.ts`, `src/pages/workspace/api/editor-adapters.ts` | 편집기는 호스트가 제공하는 어댑터로 연결 |
| HTTP·SSE·인증 경계 | `server/api.ts`, `server/index.ts` | loopback 바인딩, 미들웨어 순서와 종료 상태 유지 |
| API 라우트·요청·오류 처리 | `server/routes/`, `server/http/` | 기능별 등록 함수와 공통 오류 클래스 사용 |
| 저장·버전 충돌 | `server/storage/database.ts`, `server/storage/vault.ts` | 저장소 모드와 version/hash 검사를 함께 확인 |
| Markdown·시각화 공용 계약 | `shared/` | UI·서버·편집기 사이 타입 변경의 영향 경로 |
| 재사용 편집기 | `packages/markdown-live-editor/` | 상세 지침은 하위 `AGENTS.md` 및 패키지 README 참조 |
| 사용자 JavaScript runner | `public/visualization-runner.js`, `public/visualization-runner.html` | `server/api.ts`, `vite.config.ts`, 보안 테스트와 함께 확인 |
| 기능·저장소 회귀 검증 | `test/` | 임시 저장소와 합성 Markdown fixture 사용 |
| 실제 데이터 운영 | `scripts/`, `docs/vault-storage.md`, `docs/launch-agent.md` | 명령 전제와 서버 종료 여부를 먼저 확인 |

## 코드 지도

주요 진입점과 책임을 정리한 지도다. 변경할 때 실제 import와 해당 영역의 테스트를 함께 확인한다.

| 심볼 | 종류 | 위치 | 역할 |
|---|---|---|---|
| `WorkspacePage` | workspace 페이지 컴포넌트 | `src/pages/workspace/ui/WorkspacePage.tsx` | 문서·폴더 UI, 저장 상태, workspace 탐색 조합 |
| `MobileWorkspace` | 모바일 화면 | `src/pages/workspace/ui/MobileWorkspace.tsx` | Stackflow 기반 모바일 activity 렌더링 |
| `createApp` | Express 앱 팩토리 | `server/api.ts` | 라우트 조합, 보안, SSE, 종료 drain, 정적 파일 경로 구성 |
| `openDatabase` | 저장소 초기화 | `server/storage/database.ts` | SQLite와 선택적 FileVault 연결 |
| `FileVault` | 파일 저장소 | `server/storage/vault.ts` | Markdown 파일·manifest의 안전한 변경과 복구 |
| `MarkdownLiveEditor` | 편집기 공개 컴포넌트 | `packages/markdown-live-editor/MarkdownLiveEditor.tsx` | TipTap 편집·Markdown 보존·어댑터 연결 |
| `createFieldnotesEditorAdapters` | 호스트 어댑터 | `src/pages/workspace/api/editor-adapters.ts` | 앱 API와 편집기 계약 연결 |
| `parseVisualizationUiEvent` | 공용 검증 함수 | `shared/visualization.ts` | runner UI 이벤트를 허용된 타입으로 변환 |

## 프로젝트 규칙

- Node.js `22.13.0` 이상과 npm을 사용한다. 프로젝트는 ESM이며 Node 내장 `node:sqlite`를 사용한다.
- 루트 `tsconfig.json`은 브라우저 코드와 `shared/`를 Bundler 해석으로 검사한다. `tsconfig.server.json`은 서버·운영 TypeScript를 NodeNext로 검사한다. 두 설정 모두 strict 모드다.
- `packages/markdown-live-editor`는 자체 `package.json`, lockfile, `tsconfig.json`, 공개 `index.ts`를 가진 로컬 패키지다. 루트 npm workspace가 아니며 `shared/visualization.ts`를 상대 경로로 참조한다.
- API 등록은 `server/routes/`의 `registerXRoutes`로 나누고 필요한 의존성을 명시적으로 전달한다. 공통 요청 오류는 `server/http/validation.ts`의 한 클래스를 사용하며 `server/http/errors.ts`에서 HTTP 응답으로 변환한다.
- 보안·인증·Origin·응답 추적 → JSON parser → vault reconcile → API routes·SSE → API 404 → 정적 파일·SPA → 오류 처리 순서를 유지한다. SSE와 drain 상태는 `createApp` 인스턴스마다 소유한다.
- 저장 모드는 구분한다. SQLite 모드에서는 SQLite가 기준 데이터이고, vault 모드에서는 Markdown 파일과 `.fieldnotes` metadata가 기준 데이터다.
- 저장소 소비자는 `server/storage/database.ts`와 `server/storage/vault.ts`의 공개 API를 사용한다. 내부 구현은 `database/`와 `vault/`에 두며 내부 모듈이 공개 진입점을 다시 import해 순환하지 않도록 한다.
- 문서·폴더 변경 요청은 읽은 버전을 요구한다. vault 문서는 `expectedHash`도 검증하며, 충돌 시 최신 값을 덮어쓰지 않는다.
- `fieldnotes-view` 사용자 코드는 편집기 호스트, iframe/worker 실행기, API 검증, CSP가 함께 이루는 보안 경계다. 코드나 HTML 바이트 변경은 연동 지점을 모두 확인한다.

## 이 저장소의 금지 사항

- `KB_HOST`를 비 loopback 주소로 열거나 Express `trust proxy`를 활성화하지 않는다. Tailscale을 쓸 때 login과 HTTPS origin을 함께 설정하며, origin 검사를 인증으로 취급하지 않는다.
- version/hash 확인이나 vault 경로·symlink 검증을 생략해 오래된 쓰기 또는 임의 경로 쓰기를 허용하지 않는다.
- 실행 중인 SQLite 파일을 직접 복사하지 않는다. `.fieldnotes/state.json`을 손으로 수정하지 않는다. 복원·전체 vault 백업은 문서에 적힌 서버 중지 절차를 따른다.
- 실제 저장소를 대상으로 `db:restore`, `vault:restore`, 마이그레이션, LaunchAgent 설치 명령을 검증 용도로 실행하지 않는다. 스크립트는 `.env`를 읽을 수 있고 실제 데이터를 바꿀 수 있다.
- 시각화 runner의 Worker 제한, sandbox 속성, 입력·출력 크기 제한, HTML/CSS 정화, 사용자 승인 검증을 약화하지 않는다. `visualization-runner.js` 수정 시 HTML의 CSP hash·integrity, `server/api.ts` CSP와 관련 테스트를 함께 갱신한다.

## 자주 쓰는 명령

```bash
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm start
npm run kb -- list
```

개발 웹 주소는 `http://127.0.0.1:4177`, 개발 API는 기본 `4178`이다. 운영 `npm start`는 빌드된 UI와 API를 `4177`에서 제공한다. `npm run build`는 typecheck, 서버 TypeScript 빌드, Vite 빌드 순서다. 에디터의 독립 타입 검사는 해당 패키지에서 `npm run typecheck`로 실행한다. `npm test`는 `test/*/*.test.*`와 편집기 패키지의 테스트를 함께 실행한다. 새 테스트 영역은 이 발견 범위에 포함되는지 확인한다.

## 참고 사항

- 루트 README의 편집기 요약과 패키지 README의 preservation-card 설명은 세부 동작에서 차이가 있다. 편집기 구현 시 하위 패키지 README와 코드의 원문 보존 계약을 기준으로 확인한다.
- `.github/workflows/ci.yml`은 `main` 대상 PR과 `main` 푸시, 수동 실행에서 검증한다. `.nvmrc`의 Node 버전으로 `npm ci`, 린트, 테스트, 빌드를 실행하며 타입 검사는 빌드에 포함된다. 같은 ref의 이전 실행은 취소한다.
- `design-qa.md`는 수동 UI 검증 기록이며, 실제 브라우저 검증과 Node 기반 테스트 결과를 구분한다.
- 테스트·예제 Markdown에는 합성 데이터를 사용한다. `packages/markdown-live-editor/licenses/`의 라이선스 원문은 원본 배포처의 고지이므로 번역하거나 재작성하지 않는다.
