# 서버 작업 지침

상위 `AGENTS.md`의 공통 규칙에 더해, 이 문서는 서버의 요청·저장·종료 경계를 다룬다.

## 수정 위치

| 파일 | 소유하는 동작 | 함께 확인할 경계 |
|---|---|---|
| `index.ts` | 바인딩, 프로세스 lock, DB 시작, 종료 | `api.ts`의 drain과 vault monitor |
| `api.ts`의 `createApp` | 라우트 조합, 인증·CSP, SSE, drain | 미들웨어 순서와 인스턴스별 종료 상태 |
| `routes/` | 문서·폴더·설정·미리보기·북마크·시각화 API | 명시적으로 전달한 저장소·어댑터와 요청 계약 |
| `http/validation.ts`, `http/errors.ts` | 공통 요청 검증·오류 응답 | 동일한 오류 클래스와 기존 상태·메시지 |
| `storage/database.ts` | SQLite 트랜잭션, vault 인덱스, 변경 발행 | FileVault 성공 여부와 sequence |
| `storage/vault.ts`의 `FileVault` | manifest, 파일 쓰기, 복구, reconcile, migration | 파일·metadata의 내구성과 외부 편집 충돌 |

## 시작·lock·종료

- `index.ts`는 DB를 열기 전에 `server.lock`을 배타적 생성한다. 시작 경로를 바꿀 때 lock 획득과 DB 초기화 실패 시 정리를 함께 확인한다.
- 기존 lock은 PID가 유효하고 `process.kill(pid, 0)`이 `ESRCH`를 반환한 경우에만 stale로 처리한다. JSON 손상, 잘못된 PID, 권한 오류를 죽은 프로세스로 간주하지 않는다.
- 정상 종료는 vault monitor 중지 → `server.close()`로 신규 연결 중지 → `beginShutdown()` 완료 대기 → 남은 연결 종료 → HTTP 서버 종료 대기 → DB 닫기 → 자기 PID의 lock 제거 순서를 유지한다.
- `beginShutdown()`은 새 요청에 503을 반환하고 SSE를 종료한 뒤 추적 중인 응답의 완료를 기다린다. SSE 종료 알림과 `finish`/`close` 정리를 함께 확인한다.
- 중복 signal은 하나의 종료 Promise를 공유한다. drain 누락이나 실패를 강제 성공으로 바꾸거나 DB를 먼저 닫지 않는다.
- 종료 시 lock 소유 PID가 바뀌었거나 내용을 검증할 수 없으면 남겨 둔다. 복구를 위해 살아 있는 프로세스의 lock을 수동 삭제하지 않는다.

## API 변경

- 요청 필드 추가는 해당 `routes/` 검증과 `http/validation.ts`, `storage/database.ts` 인자, `../src/shared/api/request.ts`, `../API.md`의 해당 계약을 함께 추적한다.
- 변경 요청의 `expectedVersion`과 필요한 `expectedHash`가 검증 함수부터 저장소 호출까지 전달되는지 확인한다. 시각화 action의 기존 문서 변경은 현재 version/hash 비교를 유지한다.
- 충돌 응답에는 현재 version/hash가 전달되는 흐름을 보존한다. 재시도에서 검사를 제거하거나 오래된 입력으로 자동 덮어쓰지 않는다.
- 인증 설정 변경은 `KB_ALLOWED_TAILSCALE_LOGIN`과 경로·query·fragment 없는 HTTPS `KB_PUBLIC_ORIGIN`의 쌍 검증을 다룬다.
- Tailscale 요청은 실제 socket의 loopback 주소와 주입된 login을 검사한다. `index.ts`의 loopback 바인딩과 Express의 proxy trust 비활성 상태를 함께 확인한다.
- `Origin: null` 예외는 sandbox가 읽는 runner JavaScript의 GET 요청에 한정한다. 일반 API나 다른 자산으로 확대하지 않는다.
- runner 응답의 CSP는 일반 앱 응답과 분리되어 있다. 관련 변경은 `../public/visualization-runner.html`, `../public/visualization-runner.js`, `../vite.config.ts`의 정책과 대조한다.
- `/api/views/actions`는 payload 크기와 허용 action·필드를 검증한다. 새 action도 이 경로를 거치게 하고, 편집기 host의 사용자 승인 흐름과 생성 action의 재실행 충돌 처리를 함께 확인한다.

## 파일 저장과 SQLite 인덱스

- vault 변경은 `FileVault`의 작업 메서드를 사용한다. API에서 Markdown 파일이나 manifest를 직접 수정하는 별도 경로를 만들지 않는다.
- 파일 변경 전 pending 작업 기록, 파일 반영, metadata·변경 sequence 확정의 연결을 추적한다. 중간 실패를 잡아 성공 응답으로 바꾸지 않는다.
- 새 파일은 배타적 임시 파일 생성과 목적지 충돌 방지를, 교체는 임시 파일 fsync 후 현재 hash 재확인과 rename을 유지한다. 디렉터리 동기화도 함께 확인한다.
- 이름 변경 중 원래 파일이 외부에서 수정되면 두 파일을 보존하는 충돌 경로를 유지한다. pending 복구에서 어느 파일이 최신인지 추측해 삭제하지 않는다.
- 경로 변경은 `safeAbsolute`, 일반 파일 여부, symlink, 대소문자·Unicode 동등 이름 충돌 검사를 따라간다. 단순 문자열 prefix 검사로 대체하지 않는다.
- `reconcileVault()`는 외부 변경을 반영한 후 인덱스 readiness와 sequence를 확인한다. watcher 알림만 믿지 말고 주기적 전체 scan 경로를 유지한다.
- `rebuildVaultIndex()`의 트랜잭션이 성공한 뒤 readiness·sequence를 갱신하고 변경 이벤트를 발행한다. rollback 후 인덱스를 준비 완료로 표시하지 않는다.
- migration 수정은 staging 파일의 Markdown roundtrip 검증과 hash 기록, manifest 생성, 최종 rename 순서를 확인한다. 기존 목적지나 manifest를 덮어쓰지 않는 실패 경로도 보존한다.

## 변경별 확인 위치

- lock·signal·drain 변경: `../test/runtime/shutdown.test.ts`에서 진행 중 응답, SSE, 종료 후 lock을 확인한다.
- 저장·복구 변경: `../test/storage/vault.test.ts`와 `../test/workspace/vault-change-subscription.test.ts`에서 외부 편집 충돌, 재시작 복구, 인덱스와 변경 알림을 확인한다.
- 시각화 API 변경: `../test/visualization/visualization-actions.test.ts`, `../test/visualization/visualization-assets.test.ts`, `../test/visualization/visualization-trust.test.ts`, `../test/visualization/visualization-runner-security.test.ts` 중 해당 경계를 확인한다.
- `storage/`는 HTTP 라우트나 시각화 구현에 의존하지 않는다. 양쪽에서 사용하는 제한·오류 계약은 서버 공용 `view-query-limits.ts`를 따른다.
- HTTP 오류·API 404·SPA 경계는 `../test/api/http-boundaries.test.ts`, API·CLI 통합은 `../test/api/library-integration.test.ts`로 확인한다.
- 서버 타입 검사는 `../tsconfig.server.json`을 따른다. 테스트는 변경한 동작에 맞춰 선택하고 실제 데이터 경로와 분리한다.
