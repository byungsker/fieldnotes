export interface HeadingItem {
  index: number;
  level: number;
  text: string;
}

/** Extract ATX headings for the editor TOC while ignoring fenced code. */
export function extractHeadings(markdown: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const tick = String.fromCharCode(96);
  const fencePattern = new RegExp("^ {0,3}(" + tick + "{3,}|~{3,})");
  let fenceCharacter = "";
  let fenceLength = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const fence = fencePattern.exec(line);
    if (fence) {
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      continue;
    }
    if (fenceCharacter) continue;
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ index: headings.length, level: match[1].length, text: match[2].trim() });
  }
  return headings;
}
