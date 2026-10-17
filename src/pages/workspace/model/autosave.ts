export const AUTOSAVE_DELAY_MS = 700;
export const LOCAL_DRAFT_PREFIX = "fieldnotes:draft:";

export type LocalDraftSnapshot = {
  documentId: string;
  title: string;
  body: string;
  folderId: string | null;
  baseVersion: number;
  baseHash: string;
  revision: number;
  pendingCreate: boolean;
  initialFolderId: string | null;
};

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function localDraftKey(documentId: string): string {
  return LOCAL_DRAFT_PREFIX + documentId;
}

export function isMeaningfulNewDraft(snapshot: Pick<LocalDraftSnapshot, "title" | "body" | "folderId" | "initialFolderId">): boolean {
  return Boolean(
    snapshot.body.trim() ||
    (snapshot.title.trim() && snapshot.title.trim() !== "Untitled note") ||
    snapshot.folderId !== snapshot.initialFolderId,
  );
}

export function readLocalDraft(documentId: string, storage: DraftStorage): LocalDraftSnapshot | null {
  try {
    const raw = storage.getItem(localDraftKey(documentId));
    if (!raw) return null;
    const candidate = JSON.parse(raw) as Partial<LocalDraftSnapshot>;
    if (
      candidate.documentId !== documentId ||
      typeof candidate.title !== "string" ||
      typeof candidate.body !== "string" ||
      !(candidate.folderId === null || typeof candidate.folderId === "string") ||
      !Number.isSafeInteger(candidate.baseVersion) ||
      typeof candidate.baseHash !== "string" ||
      !Number.isSafeInteger(candidate.revision) ||
      typeof candidate.pendingCreate !== "boolean" ||
      !(candidate.initialFolderId === null || typeof candidate.initialFolderId === "string")
    ) return null;
    return candidate as LocalDraftSnapshot;
  } catch {
    return null;
  }
}

export function writeLocalDraft(snapshot: LocalDraftSnapshot, storage: DraftStorage): boolean {
  try {
    storage.setItem(localDraftKey(snapshot.documentId), JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalDraft(documentId: string, storage: DraftStorage): boolean {
  try {
    storage.removeItem(localDraftKey(documentId));
    return true;
  } catch {
    return false;
  }
}

export function draftMatchesDocument(
  draft: Pick<LocalDraftSnapshot, "title" | "body" | "folderId">,
  document: { title: string; body: string; folderId: string | null },
): boolean {
  return draft.title === document.title && draft.body === document.body && draft.folderId === document.folderId;
}

export function rebaseDraft(
  draft: LocalDraftSnapshot,
  document: { version: number; contentHash?: string },
): LocalDraftSnapshot {
  return {
    ...draft,
    baseVersion: document.version,
    baseHash: document.contentHash ?? "",
    pendingCreate: false,
  };
}
