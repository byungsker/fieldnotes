This example uses only fictional notes. A `fieldnotes-view` fence is stored as Markdown source and reads the current Fieldnotes library through its local API.

## Filtered table

```fieldnotes-view
{
  "version": 1,
  "view": "table",
  "query": {
    "where": [
      { "field": "frontmatter.status", "operator": "eq", "value": "active" }
    ],
    "sort": { "field": "frontmatter.due", "direction": "asc" },
    "limit": 100
  },
  "columns": ["title", "frontmatter.due", "frontmatter.tags"]
}
```

## Calendar

```fieldnotes-view
{
  "version": 1,
  "view": "calendar",
  "query": { "limit": 100 },
  "dateField": "frontmatter.due",
  "labelField": "title"
}
```

## Custom HTML, CSS, and JavaScript

In local development, `notes` is a frozen array of query results and `escapeHtml` is provided to encode text before placing it in an HTML string. The sandbox accepts only small, well-formed XHTML and scoped CSS from a fixed property list.

```fieldnotes-view
{
  "version": 1,
  "view": "custom",
  "query": { "where": [{ "field": "frontmatter.status", "operator": "eq", "value": "active" }], "limit": 100 },
  "js": "return { html: '<section class=\"summary\"><h2>Active notes</h2><p>' + notes.length + '</p></section>', css: '.summary { padding: 12px; border-radius: 8px; background-color: #eef3fa; color: #1e293b; }' };"
}
```

Custom JavaScript runs only after you review and approve the exact source for this note and block. Changed source needs approval again, and you can revoke approval. It runs in an opaque sandboxed frame and a disposable Worker; file access, app storage, and network requests are blocked.
