# 영화 기록 예시

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
