# 사용자 JS로 기록 뷰 만들기

책·영화·육아는 사용자 문서의 분류 값이다. 앱은 분류 목록이나 전용 API를 갖지 않는다. 아래 블록을 자신의 Markdown 문서에 복사하고 `Review script`로 소스를 확인하고 `Trust this source and run`을 선택하면 목록·완료 필터·문서 열기·기록 추가·완료 변경을 사용할 수 있다. 이 파일의 코드와 문구는 예시이며 앱 번들에 등록하지 않는다.

`js`는 `(notes, escapeHtml, state, trash)`를 받는 동기 함수의 **본문**이다. `{ html, css? }`를 반환한다. 본문 전체·Obsidian `dv`/`app`·DOM·외부 네트워크를 사용할 수 없다. `notes`에는 query에 맞는 메타데이터·frontmatter·excerpt가 들어온다. 사용자 값을 HTML에 표시할 때는 `escapeHtml`을 사용한다.

예시는 `type`, `date`, `completed` frontmatter를 사용한다. 기존 기록이 다른 키를 쓴다면 `query.where`, 표시 코드와 생성 form의 `metadata`를 함께 바꾼다. 추가한 기록은 기본적으로 최상위에 저장된다. 특정 폴더에 생성하려면 form에 `<input type="hidden" name="folderId" value="대상 폴더 UUID">`를 넣고 조회 범위에도 같은 `query.folderId`를 지정한다. 폴더 이름으로 앱 동작이 바뀌지 않는다.

## 책 기록

```fieldnotes-view
{
  "version": 1,
  "view": "custom",
  "query": {
    "where": [
      {
        "field": "frontmatter.type",
        "operator": "eq",
        "value": "book"
      }
    ],
    "sort": {
      "field": "frontmatter.date",
      "direction": "desc"
    },
    "limit": 100
  },
  "js": "const visible = state.hideCompleted ? notes.filter(note => note.frontmatter.completed !== true) : notes;\nconst rows = visible.map(note => {\n  const patch = escapeHtml(JSON.stringify({ completed: note.frontmatter.completed !== true }));\n  return `<li><button type=\"button\" data-fn-event=\"note.open\" data-note-id=\"${note.id}\">${escapeHtml(note.title)}</button> <span>${escapeHtml(note.frontmatter.date || '')}</span> <form data-fn-event=\"note.frontmatter.patch\" data-note-id=\"${note.id}\"><input type=\"hidden\" name=\"patch\" value=\"${patch}\"><button type=\"submit\">${note.frontmatter.completed === true ? '완료 취소' : '완료'}</button></form></li>`;\n}).join('');\nconst metadata = escapeHtml(JSON.stringify({ type: \"book\", date: new Date().toISOString().slice(0, 10), completed: false }));\nreturn { html: `<section><h2>책 기록</h2><button type=\"button\" data-fn-event=\"state.toggle\" data-state-key=\"hideCompleted\">${state.hideCompleted ? '전체 보기' : '완료 숨기기'}</button><ul>${rows || '<li>아직 기록이 없습니다.</li>'}</ul><form data-fn-event=\"note.create\"><label>제목<input name=\"title\" required></label><input type=\"hidden\" name=\"frontmatter\" value=\"${metadata}\"><label>메모<textarea name=\"body\"></textarea></label><button type=\"submit\">책 기록 추가</button></form></section>` };"
}
```

## 영화 기록

```fieldnotes-view
{
  "version": 1,
  "view": "custom",
  "query": {
    "where": [
      {
        "field": "frontmatter.type",
        "operator": "eq",
        "value": "movie"
      }
    ],
    "sort": {
      "field": "frontmatter.date",
      "direction": "desc"
    },
    "limit": 100
  },
  "js": "const visible = state.hideCompleted ? notes.filter(note => note.frontmatter.completed !== true) : notes;\nconst rows = visible.map(note => {\n  const patch = escapeHtml(JSON.stringify({ completed: note.frontmatter.completed !== true }));\n  return `<li><button type=\"button\" data-fn-event=\"note.open\" data-note-id=\"${note.id}\">${escapeHtml(note.title)}</button> <span>${escapeHtml(note.frontmatter.date || '')}</span> <form data-fn-event=\"note.frontmatter.patch\" data-note-id=\"${note.id}\"><input type=\"hidden\" name=\"patch\" value=\"${patch}\"><button type=\"submit\">${note.frontmatter.completed === true ? '완료 취소' : '완료'}</button></form></li>`;\n}).join('');\nconst metadata = escapeHtml(JSON.stringify({ type: \"movie\", date: new Date().toISOString().slice(0, 10), completed: false }));\nreturn { html: `<section><h2>영화 기록</h2><button type=\"button\" data-fn-event=\"state.toggle\" data-state-key=\"hideCompleted\">${state.hideCompleted ? '전체 보기' : '완료 숨기기'}</button><ul>${rows || '<li>아직 기록이 없습니다.</li>'}</ul><form data-fn-event=\"note.create\"><label>제목<input name=\"title\" required></label><input type=\"hidden\" name=\"frontmatter\" value=\"${metadata}\"><label>메모<textarea name=\"body\"></textarea></label><button type=\"submit\">영화 기록 추가</button></form></section>` };"
}
```

## 육아 기록

```fieldnotes-view
{
  "version": 1,
  "view": "custom",
  "query": {
    "where": [
      {
        "field": "frontmatter.type",
        "operator": "eq",
        "value": "milestone"
      }
    ],
    "sort": {
      "field": "frontmatter.date",
      "direction": "desc"
    },
    "limit": 100
  },
  "js": "const visible = state.hideCompleted ? notes.filter(note => note.frontmatter.completed !== true) : notes;\nconst rows = visible.map(note => {\n  const patch = escapeHtml(JSON.stringify({ completed: note.frontmatter.completed !== true }));\n  return `<li><button type=\"button\" data-fn-event=\"note.open\" data-note-id=\"${note.id}\">${escapeHtml(note.title)}</button> <span>${escapeHtml(note.frontmatter.date || '')}</span> <form data-fn-event=\"note.frontmatter.patch\" data-note-id=\"${note.id}\"><input type=\"hidden\" name=\"patch\" value=\"${patch}\"><button type=\"submit\">${note.frontmatter.completed === true ? '완료 취소' : '완료'}</button></form></li>`;\n}).join('');\nconst metadata = escapeHtml(JSON.stringify({ type: \"milestone\", date: new Date().toISOString().slice(0, 10), completed: false }));\nreturn { html: `<section><h2>육아 기록</h2><button type=\"button\" data-fn-event=\"state.toggle\" data-state-key=\"hideCompleted\">${state.hideCompleted ? '전체 보기' : '완료 숨기기'}</button><ul>${rows || '<li>아직 기록이 없습니다.</li>'}</ul><form data-fn-event=\"note.create\"><label>제목<input name=\"title\" required></label><input type=\"hidden\" name=\"frontmatter\" value=\"${metadata}\"><label>메모<textarea name=\"body\"></textarea></label><button type=\"submit\">육아 기록 추가</button></form></section>` };"
}
```

## 새 카테고리 추가

예시를 복사해 `query.where`의 `value`와 JS `metadata.type`을 원하는 문자열로 바꾸고 제목·표시할 필드를 편집한다. 예를 들어 운동 기록은 둘 다 `exercise`로 정하면 된다. 새로운 분류를 앱에 등록하거나 빌드·배포할 필요가 없다. 코드를 바꾸면 변경된 소스에 다시 실행 승인이 필요하다.

로컬 첨부 이미지는 기록 본문에 `![[/photos/cover.png]]` 같은 명시적 참조를 둔다. `/`로 시작하면 vault 최상위 기준이므로 예시 form이 최상위에 생성한 기록에서도 사용할 수 있다. 조회 결과의 `note.assetPaths`와 `note.contentHash`로 허용된 이미지 URL을 구성할 수 있다. 예: `/api/views/assets/${note.id}?asset=${encodeURIComponent(note.assetPaths[0])}&v=${note.contentHash}`. JPEG·PNG·WebP, 최대 1 MB만 허용하며 JS 문자열이나 frontmatter URL만으로 이미지 접근 권한이 생기지 않는다.

기존 DataviewJS와 영화 검색·포스터 연동의 변경 사항은 [이관 안내](custom-js-view-migration.md), 제한과 실행 경계는 [보안 계약](fieldnotes-visualizations-security.md)을 참고한다.
