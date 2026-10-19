import type { FolderRecord } from "./workspace-types";

export function folderSubtreeIds(folders: readonly FolderRecord[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = children.get(folder.parentId) ?? [];
    list.push(folder.id);
    children.set(folder.parentId, list);
  }

  const subtree = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const child of children.get(stack.pop() as string) ?? []) {
      if (subtree.has(child)) continue;
      subtree.add(child);
      stack.push(child);
    }
  }
  return subtree;
}

export function toggleFolderSubtree(
  expandedFolderIds: ReadonlySet<string>,
  folders: readonly FolderRecord[],
  id: string,
): Set<string> {
  const shouldExpand = !expandedFolderIds.has(id);
  const next = new Set(expandedFolderIds);
  for (const folderId of folderSubtreeIds(folders, id)) {
    if (shouldExpand) next.add(folderId);
    else next.delete(folderId);
  }
  return next;
}
