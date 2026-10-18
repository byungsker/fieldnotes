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

## 로컬 이미지 호환성

공통 자산 API는 현재 문서 hash와 본문에 명시한 Markdown·wiki 이미지 참조를 검증한다. 문서 기준 상대 경로와 `/photos/image.png` 같은 vault 최상위 경로를 지원한다. `![[cover.jpg]]`처럼 경로가 없는 wiki 첨부 링크는 문서 폴더를 먼저 확인하고, 없으면 vault 전체에서 같은 이름의 파일이 하나일 때 연결한다. 경로가 모호하면 이미지를 제공하지 않는다. 코드 fence 안의 예시는 참조로 인정하지 않는다.

실제 이미지 바이트를 확인해 JPEG·PNG·WebP·GIF·AVIF를 최대 25 MB까지 제공한다. 따라서 기존 8.1 MB 사진은 다른 경로·형식 문제가 없다면 공통 자산 API의 크기 제한에 걸리지 않는다. JS 문자열이나 frontmatter의 외부 URL만으로 이미지 접근 권한이 생기지는 않으며 원격 poster URL도 자동 다운로드하지 않는다.

## 기존 DataviewJS 대시보드

기존 DataviewJS는 원문만 보존하고 실행하지 않는다. Dataview API를 에뮬레이션하거나 폴더·분류를 기준으로 화면을 고르지 않으므로, 작동하던 각 대시보드는 사용자 Markdown에 `fieldnotes-view` 블록을 추가해 공통 query와 custom JS로 옮겨야 한다. 원본 DataviewJS를 남겨 두고 새 블록을 옆에 추가하면 되며, 앱 배포 없이 사용자 스크립트만으로 새 분류와 필드를 표현할 수 있다. 현재 저장소에는 실제 사용자 vault의 대시보드 소스가 없으므로 이 문서 변경만으로 기존 사용자 대시보드가 변환되지는 않는다.

## 검증 기준

합성 저장소에서 기존 Dataview 원문과 content hash 보존, 여러 카테고리의 공통 생성·조회·수정, 제거한 API의 거부, 로컬 이미지 참조·hash·형식·크기·symlink 검증을 확인한다. 사용자 실행 승인·version/hash 충돌·생성 멱등성·Worker 격리·CSP/SRI 제한은 동일하게 유지한다. 실제 vault나 사용자 기록을 이관하는 작업은 포함하지 않는다.
