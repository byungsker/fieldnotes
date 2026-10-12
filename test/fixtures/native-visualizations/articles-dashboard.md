# Articles

```fieldnotes-view
{"version":1,"view":"table","query":{"where":[{"field":"frontmatter.type","operator":"eq","value":"article"}]},"columns":["title","frontmatter.status","updatedAt"]}
```

```fieldnotes-view
{"version":1,"view":"custom","query":{"where":[{"field":"frontmatter.type","operator":"eq","value":"article"}]},"js":"const rows = notes.map(note => `<li><strong>${escapeHtml(note.title)}</strong> <button type=\"button\" data-fn-event=\"note.open\" data-note-id=\"${note.id}\">Open in editor</button></li>`).join(''); return { html: `<section><h2>Continue writing</h2><ul>${rows}</ul></section>` };"}
```
