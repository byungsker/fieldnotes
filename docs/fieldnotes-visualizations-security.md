# Fieldnotes 시각화 보안 계약

`fieldnotes-view`는 원본 fence를 보존하는 Markdown 블록이다. Dataview를 설치하거나 `dv` API를 구현하지 않는다. 기본 table·calendar는 편집기에서 렌더링한다. custom view는 사용자가 정확한 소스를 검토·승인한 뒤 일회용 Worker에서 동기 함수 `(notes, escapeHtml, state, trash)`의 본문을 실행한다. 승인은 문서 ID·블록 인덱스·소스 지문에 한정되며 변경 후 재승인이 필요하고 언제든 철회할 수 있다. 기록 카테고리는 사용자 문서에 정의한다.

## 읽기 전용 조회

`POST /api/views/query`는 선택적 폴더 UUID 또는 최상위 문서를 뜻하는 `null`, 최대 120자 검색어, 최대 8개 필터, 정렬, 1~200개 제한값을 받는다. 기본 제한은 100개다. 지원 필드는 `title`, `path`, `createdAt`, `updatedAt`, `excerpt`, `frontmatter.<key>`이며 중첩 frontmatter는 점 경로를 사용한다. 연산자는 `eq`, `contains`, `exists`, `before`, `after`, `in`이다.

결과에는 ID·제목·상대 경로·시간·version·content hash·150자 excerpt·frontmatter와 선택적 `frontmatterError`가 있다. 전체 Markdown 본문과 절대 경로는 전달하지 않는다. 파일 저장소에서는 문서에 명시적으로 삽입한 JPEG·PNG·WebP·GIF·AVIF의 정규화된 상대 경로를 최대 20개 제공한다. 경로는 참조이며 파일 바이트가 아니다. `path` 필터는 본문을 읽기 전에 경로 메타데이터에서 적용하고, 나머지 필터는 최대 1,000개 후보·20,000,000 UTF-8 바이트 제한 안에서 검사한다. JSON 응답은 1.5 MB로 제한한다. 초과하면 `413`이므로 폴더나 경로 조건으로 query 범위를 줄여야 한다.

`includeTrash`는 최근 휴지통 항목 최대 100개와 최대 20,000,000 UTF-8 바이트에서 ID·제목·폴더 ID·삭제 시간·version·excerpt를 읽는다. 초과 조회는 `413`이다. 조회는 동기화된 인덱스를 사용하며 vault monitor가 파일 변경을 반영한다. 매 렌더마다 vault 전체를 탐색하지 않는다. YAML은 안전한 scalar·list·mapping 부분집합으로 읽으며 태그·생성자·표현식을 평가하지 않는다. 해석 실패는 `frontmatterError`로 보고하고 원문을 재작성하지 않는다.

## 실행 경계

호스트는 제한된 조회 결과만 `sandbox="allow-scripts allow-forms"` iframe으로 보낸다. `allow-same-origin`, 최상위 이동, 팝업 권한은 없으며 opaque origin 때문에 호스트 DOM·쿠키·localStorage·인증 문맥에 접근하지 못한다. form은 브라우저의 신뢰된 submit 이벤트를 받기 위한 것이며 runner가 기본 동작을 막고 CSP `form-action 'none'`도 이동을 차단한다.

runner는 부모 window·예상 origin을, 호스트는 source window·opaque-origin ready 신호를 확인한 뒤 뷰별 `MessagePort`를 연결한다. 현재 request ID와 일치하는 응답만 받는다. 블록당 연결 하나, Worker당 렌더 메시지 하나이며 완료·취소·시간 초과 시 종료한다.

runner 정적 스크립트는 일치하는 SHA-256 CSP와 SRI로만 허용한다. opaque `null` origin에서 이 파일을 읽을 수 있도록 `/visualization-runner.js` GET에만 CORS와 cross-origin resource policy 예외를 둔다. API나 다른 자산에는 적용하지 않는다. 그 밖의 `script-src`·`script-src-elem`은 Blob만 허용해 Worker가 같은 origin이나 외부 네트워크 스크립트를 불러오지 못한다. connect·font·media·frame·child·object·form·manifest 출처는 차단한다.

Chrome은 CSP WebRTC 지시어를 지원하지 않으므로 Worker의 전역 객체와 prototype chain에서 WebRTC·fetch·XHR·WebSocket·EventSource·WebTransport·broadcast·storage·DOM·file·URL/Blob·timer·Worker·importScripts를 가린다. `eval`·`Function` 이름과 일반·async·generator·async-generator 함수 prototype의 constructor도 제거한다. `globalThis`는 남으므로 이 가림과 CSP가 함께 경계를 이룬다.

## 로컬 이미지

`img-src 'self'`는 Fieldnotes origin만 허용한다. runner는 현재 query 결과의 문서 ID·content hash·검증된 `assetPaths`에서 만든 **정확한 자산 URL**만 이미지 src로 허용한다. frontmatter의 `poster` 등 임의 URL 필드는 접근 권한을 부여하지 않는다. 원격 호스트에 요청하거나 카테고리 전용 프록시를 제공하지 않는다.

`GET /api/views/assets/:id`는 현재 문서 hash와 본문에 명시한 정규화 경로를 검증한다. fenced code 안의 이미지나 JS 문자열은 참조가 아니다. vault의 no-follow 경로 검사로 읽고 최대 25 MB·JPEG/PNG/WebP/GIF/AVIF 확장자·실제 이미지 바이트를 검사한다. 경로는 문서 기준 상대 경로 또는 `/`로 시작하는 vault 최상위 경로를 지원한다. 경로 없는 wiki 첨부 링크는 vault에서 같은 이름의 파일이 하나일 때만 기존 노트를 위해 해석한다. 응답 MIME은 검증한 바이트로 정하며 이미지 바이트 hash로 ETag를 만든다. `If-None-Match`의 완전한 entity tag를 weak comparison으로 비교하고, 단독 wildcard 또는 유효한 일치 tag만 `304`로 응답한다.

파일 open 뒤 경로와 열린 파일 identity를 다시 확인해 상위 디렉터리 symlink 교체를 검사한다. Node의 이식 가능한 파일 API에는 descriptor 기준 `openat` 탐색이 없어, 디렉터리를 동시에 바꾸는 로컬 프로세스에 대해 완전한 방어를 보장하지 않는다. vault의 쓰기 접근을 다른 프로세스와 공유하지 않는 운영 경계가 필요하다.

## 크기·동작 제한

Worker 기한은 부모가 제어하는 700 ms다. 입력은 200개 문서·1 MB, JS 소스는 16 KB, HTML은 48 KB, CSS는 12 KB·80개 규칙, 정화된 DOM은 1,000개 요소·깊이 20, 이미지 참조는 렌더당 50개로 제한한다. 동시에 실행하는 Worker는 2개, 대기는 6개다.

허용한 요소·속성·CSS 속성만 DOM에 복사한다. script·style·frame·link·media·object를 제거하고 지원하지 않는 중립 요소는 자식만 남긴다. 이미지 외의 URL 속성은 제거하며 CSS `url()`, import, font face, escape 등 자원 로딩 구문을 거절한다. 버튼·form은 허용된 일반 상태·문서 이벤트만 내보내며 브라우저의 신뢰된 click·submit·change를 요구한다. 필드는 개수·크기·형식을 검증한다.

문서 쓰기는 서버 `/api/views/actions`로 전달한다. 서버는 로컬 실행 승인 기록을 받거나 쓰기 권한으로 취급하지 않고, 독립적으로 액션·ID·필드·크기·version/hash를 검사한다. 호스트도 현재 query 문서 범위와 승인 상태를 확인한다. 코드가 변경되거나 승인이 철회되면 실행을 중단한다. 오래된 쓰기는 충돌하며 생성 재시도는 action ID로 멱등 처리한다.

브라우저는 Worker별 강제 메모리 한도를 이식 가능한 방식으로 제공하지 않는다. 스케줄링 때문에 타이머는 최선의 제한이며 반환값 크기 검사 전에 메모리를 할당할 수 있다. 이 경계는 브라우저 엔진 취약점을 방어하지 않는다. 실행 승인은 사용자가 소스를 검토한 뒤 하는 신뢰 결정이다.

## 실패와 검증

잘못된 query·블록 JSON·YAML·출력, 크기 초과, DOM·CSS 제한 초과, 대기열 포화, 시간 초과는 오류나 중지 상태로 표시한다. Worker에는 파일 쓰기나 외부 네트워크 API가 없다. 카테고리는 같은 query/actions 계약으로 처리한다.

자동 검증은 조회 범위·원문 보존·공통 CRUD·버전 충돌·멱등성·로컬 자산 참조/hash/path/type/size·CSP/SRI·iframe sandbox·Worker 문법/prototype 가림·오래된 request ID·Worker 동시 실행을 확인한다. 실제 브라우저 검증은 별도 기록하며 기기나 제공자 검증으로 확대 해석하지 않는다.
