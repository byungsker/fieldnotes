# Movies

```fieldnotes-view
{"version":1,"view":"custom","query":{"where":[{"field":"frontmatter.type","operator":"eq","value":"movie"}]},"js":"const saved = notes.map(note => `<li>${escapeHtml(note.title)}</li>`).join(''); const found = Array.isArray(state.movies) ? state.movies.map(movie => `<li>${escapeHtml(movie.title)} (${escapeHtml(movie.releaseDate || 'date unknown')})</li>`).join('') : ''; return { html: `<section><h2>Watchlist</h2><ul>${saved}</ul><form data-fn-event=\"movies.search\"><label>Find a film<input type=\"search\" name=\"query\" value=\"Arrival\"></label><button type=\"submit\">Search TMDb</button></form><ul>${found}</ul></section>` };"}
```
