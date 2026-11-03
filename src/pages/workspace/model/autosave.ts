export const AUTOSAVE_DELAY_MS = 700;
export const LOCAL_DRAFT_WRITE_DELAY_MS = 250;
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

/**
 * Keep the latest recovery snapshot in memory while the user is typing, then
 * write it once after a short idle period. Explicit flushes protect navigation
 * and page lifecycle boundaries.
 */
export class LocalDraftQueue {
  private readonly pending = new Map<string, LocalDraftSnapshot>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly getStorage: () => DraftStorage,
    private readonly onWriteResult: (documentId: string, saved: boolean) => void = () => undefined,
    private readonly delayMs = LOCAL_DRAFT_WRITE_DELAY_MS,
  ) {}

  schedule(snapshot: LocalDraftSnapshot): void {
    const { documentId } = snapshot;
    this.pending.set(documentId, snapshot);
    this.cancelTimer(documentId);
    const timer = setTimeout(() => {
      this.timers.delete(documentId);
      this.persist(documentId);
    }, this.delayMs);
    this.timers.set(documentId, timer);
  }

  flush(documentId: string): boolean {
    this.cancelTimer(documentId);
    return this.persist(documentId);
  }

  flushAll(): boolean {
    let saved = true;
    for (const documentId of this.pending.keys()) {
      if (!this.flush(documentId)) saved = false;
    }
    return saved;
  }

  writeNow(snapshot: LocalDraftSnapshot): boolean {
    this.cancelTimer(snapshot.documentId);
    this.pending.set(snapshot.documentId, snapshot);
    return this.persist(snapshot.documentId);
  }

  clear(documentId: string): boolean {
    this.cancelTimer(documentId);
    this.pending.delete(documentId);
    try {
      const cleared = clearLocalDraft(documentId, this.getStorage());
      this.onWriteResult(documentId, cleared);
      return cleared;
    } catch {
      this.onWriteResult(documentId, false);
      return false;
    }
  }

  private cancelTimer(documentId: string): void {
    const timer = this.timers.get(documentId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(documentId);
  }

  private persist(documentId: string): boolean {
    const snapshot = this.pending.get(documentId);
    if (!snapshot) return true;
    const saved = this.write(snapshot);
    if (saved && this.pending.get(documentId) === snapshot) this.pending.delete(documentId);
    return saved;
  }

  private write(snapshot: LocalDraftSnapshot): boolean {
    try {
      const saved = writeLocalDraft(snapshot, this.getStorage());
      this.onWriteResult(snapshot.documentId, saved);
      return saved;
    } catch {
      this.onWriteResult(snapshot.documentId, false);
      return false;
    }
  }
}

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
