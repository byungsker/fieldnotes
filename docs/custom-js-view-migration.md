# 카테고리 전용 뷰에서 사용자 JS로 이관

## 변경된 책임

기록의 종류와 필드는 사용자 Markdown·frontmatter·`fieldnotes-view` JS에 둔다. 앱·편집기·서버·runner는 카테고리를 등록하거나 특정 폴더 이름을 검사하지 않는다. 모든 기록은 `/api/views/query`, `/api/views/actions`, `/api/views/assets/:id`의 공통 계약을 사용한다. [책·영화·육아 예시](custom-js-record-views.md)는 복사해서 사용하는 사용자 문서다.

| 기존 동작 | 현재 동작 |
|---|---|
| `babies/` 경로와 일부 DataviewJS 패턴에 육아 React UI 표시 | 모든 경로에 동일한 보존 블록 미리보기 적용 |
| `/api/preview/babies`, `/api/preview/babies/asset` | 경로 제거, `404` 응답 |
| `movies.search` 액션과 검색 결과 `state.movies` | 전용 액션 제거, `400` 응답. `state`는 사용자 JS의 일반 상태로만 사용 |
| `?field=poster`와 TMDb 원격 이미지 다운로드 | 전용 쿼리 제거, `400` 응답. 명시적 로컬 이미지 참조만 제공 |
| 책·영화별 기록 REST API | 기존에도 별도 기록 REST API는 없었으며 공통 문서 API 사용 |

기존 영화 검색은 어댑터를 주입했을 때만 동작했고 기본 서버에서는 비활성이었다. 원격 포스터 다운로드는 기본 서버에서도 사용할 수 있었다. 현재는 두 경로 모두 제거했다. 외부 검색 서비스를 대체하는 새 네트워크 API를 추가하지 않는다.

## 원문과 호환성

기존 Markdown·frontmatter URL·DataviewJS 원문을 자동 수정하거나 삭제하지 않는다. DataviewJS는 보존되지만 실행되지 않으며, 이전 육아 전용 자동 대체 화면도 표시하지 않는다. Obsidian의 `dv.pages`, `app.vault`, DOM 조작을 쓰는 코드는 fence 이름만 바꿔 실행할 수 없다.

작동하는 뷰를 만들려면 원문을 보관한 상태에서 별도 `fieldnotes-view` 블록을 작성한다. 조회할 필드를 frontmatter로 정리하고 query와 JS를 맞춘다. 전체 본문은 JS 입력으로 제공하지 않는다. 새 코드는 정확한 소스에 대한 사용자의 검토·승인 후 실행된다.

## 로컬 이미지 차이

공통 자산 API는 현재 문서 hash와 본문에 명시한 Markdown·wiki 이미지 참조를 검증한다. 경로는 문서 기준 상대 경로이며 `/photos/image.png`는 vault 최상위 기준이다. 이름만 같은 파일을 vault 전체에서 찾아주는 fallback이나 JS 코드 안의 경로 문자열은 허용하지 않는다. 코드 fence 내부의 이미지 예시도 참조로 인정하지 않는다.

JPEG·PNG·WebP의 실제 바이트를 검사하고 1 MB로 제한한다. 예전 육아 전용 경로의 GIF·AVIF·25 MB 허용과 자동 경로 탐색은 유지하지 않는다. 큰 첨부는 별도 사본을 줄여 명시적으로 참조하고, 기존 파일을 자동 변환하지 않는다. 원격 poster URL은 메타데이터로 남지만 자동 프록시·이미지 표시는 제공하지 않는다.

## 검증 기준

합성 저장소에서 기존 Dataview 원문과 content hash 보존, 여러 카테고리의 공통 생성·조회·수정, 제거한 API의 거부, 로컬 이미지 참조·hash·형식·크기·symlink 검증을 확인한다. 사용자 실행 승인·version/hash 충돌·생성 멱등성·Worker 격리·CSP/SRI 제한은 동일하게 유지한다. 실제 vault나 사용자 기록을 이관하는 작업은 포함하지 않는다.
