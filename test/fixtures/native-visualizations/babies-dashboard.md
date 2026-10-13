# Milestones

```fieldnotes-view
{"version":1,"view":"calendar","query":{"where":[{"field":"frontmatter.type","operator":"eq","value":"milestone"}]},"dateField":"frontmatter.date","labelField":"title"}
```

```fieldnotes-view
{"version":1,"view":"custom","query":{"where":[{"field":"frontmatter.type","operator":"eq","value":"milestone"}]},"js":"return { html: `<form data-fn-event=\"note.create\"><label>Milestone title<input name=\"title\" value=\"A new synthetic milestone\"></label><input type=\"hidden\" name=\"frontmatter\" value=\"{&quot;type&quot;:&quot;milestone&quot;,&quot;date&quot;:&quot;2026-10-20&quot;}\"><textarea name=\"body\">A new milestone note.</textarea><button type=\"submit\">Add milestone</button></form>` };"}
```
