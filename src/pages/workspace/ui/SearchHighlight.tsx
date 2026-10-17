import { Fragment } from "react";

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return text;

  const source = text.toLocaleLowerCase();
  const segments: Array<{ value: string; matched: boolean }> = [];
  let cursor = 0;
  let match = source.indexOf(needle, cursor);
  while (match >= 0) {
    if (match > cursor) segments.push({ value: text.slice(cursor, match), matched: false });
    const end = match + needle.length;
    segments.push({ value: text.slice(match, end), matched: true });
    cursor = end;
    match = source.indexOf(needle, cursor);
  }
  if (cursor < text.length) segments.push({ value: text.slice(cursor), matched: false });
  if (segments.length === 0) return text;

  return segments.map((segment, index) => segment.matched
    ? <mark className="search-match" key={index}>{segment.value}</mark>
    : <Fragment key={index}>{segment.value}</Fragment>);
}
