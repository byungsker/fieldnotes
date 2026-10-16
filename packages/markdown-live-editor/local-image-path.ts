const LOCAL_RASTER_EXTENSION = /\.(?:jpe?g|png|webp)$/iu;

/** Resolve one preserved Markdown image target to the vault-root path used by the safe asset API. */
export function resolveLocalImageAssetPath(rawSource: string, markdownPath: string): string | null {
  const target = rawSource.split("|", 1)[0]?.split("#", 1)[0]?.trim() ?? "";
  const hasControl = (value: string) => [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
  if (!target || target.length > 1_024 || target.includes("\\") || target.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/iu.test(target) || hasControl(target)) return null;
  if (!markdownPath || markdownPath.startsWith("/") || markdownPath.includes("\\") || hasControl(markdownPath)) return null;

  const noteSegments = markdownPath.split("/");
  if (noteSegments.some((segment) => !segment || segment === "." || segment === ".."
    || segment === ".fieldnotes" || segment.startsWith(".fieldnotes-tmp-"))) return null;

  const resolved = target.startsWith("/") ? [] : noteSegments.slice(0, -1);
  const targetSegments = target.startsWith("/") ? target.slice(1).split("/") : target.split("/");
  for (const segment of targetSegments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) return null;
      resolved.pop();
      continue;
    }
    if (segment === ".fieldnotes" || segment.startsWith(".fieldnotes-tmp-")) return null;
    resolved.push(segment);
  }

  const assetPath = resolved.join("/");
  if (!assetPath || !LOCAL_RASTER_EXTENSION.test(assetPath)) return null;
  return assetPath;
}
