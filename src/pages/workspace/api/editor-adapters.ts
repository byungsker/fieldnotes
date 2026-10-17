import { apiRequest } from "../../../shared/api";
import type {
  BookmarkMetadata,
  EditorSnippet,
  MarkdownLiveEditorAdapters,
  NewEditorSnippet,
} from "../../../../packages/markdown-live-editor";
import type { VisualizationAction, VisualizationQuery, VisualizationQueryResponse } from "../../../../shared/visualization";
import { subscribeToVaultChanges } from "./vault-change-subscription";

const SNIPPETS_KEY = "fieldnotes:editor-snippets:v1";
const MAX_IMAGE_SOURCE_LENGTH = 20_000;
const MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_SNIPPETS = 100;
const VISUALIZATION_TRUST_PREFIX = "fieldnotes:trusted-view:v1:";
const MAX_TRUSTED_VIEWS = 200;

function visualizationTrustKey(documentId: string, blockIndex: number, sourceHash: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(documentId) || !Number.isSafeInteger(blockIndex) || blockIndex < 0 || !/^[0-9a-f]{64}$/i.test(sourceHash)) {
    throw new Error("This visualization cannot be trusted because its identity is invalid.");
  }
  return `${VISUALIZATION_TRUST_PREFIX}${documentId}:${blockIndex}:${sourceHash}`;
}

function trustedVisualizationKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(VISUALIZATION_TRUST_PREFIX)) keys.push(key);
  }
  return keys;
}

function storeVisualizationTrust(documentId: string, blockIndex: number, sourceHash: string): void {
  const key = visualizationTrustKey(documentId, blockIndex, sourceHash);
  window.localStorage.setItem(key, String(Date.now()));
  const records = trustedVisualizationKeys().map((recordKey) => ({ key: recordKey, timestamp: Number(window.localStorage.getItem(recordKey)) || 0 }));
  records.sort((left, right) => left.timestamp - right.timestamp);
  while (records.length > MAX_TRUSTED_VIEWS) {
    const expired = records.shift();
    if (expired) window.localStorage.removeItem(expired.key);
  }
}

function isEditorSnippet(value: unknown): value is EditorSnippet {
  if (!value || typeof value !== "object") return false;
  const snippet = value as Partial<EditorSnippet>;
  return typeof snippet.id === "string" && snippet.id.length <= 100
    && typeof snippet.name === "string" && snippet.name.length > 0 && snippet.name.length <= 80
    && typeof snippet.content === "string" && snippet.content.length <= 10_000
    && (snippet.shortcut === undefined || snippet.shortcut === null
      || (typeof snippet.shortcut === "string" && snippet.shortcut.length <= 64));
}

function listSnippets(): EditorSnippet[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SNIPPETS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEditorSnippet).slice(0, MAX_SNIPPETS) : [];
  } catch {
    return [];
  }
}

function storeSnippets(snippets: EditorSnippet[]): void {
  window.localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets.slice(0, MAX_SNIPPETS)));
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read compressed image."));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Could not encode compressed image."));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("This browser cannot compress the image.")), "image/webp", quality);
  });
}

async function compressImage(file: File): Promise<string> {
  if (!/^image\/(?:jpeg|png|webp)$/i.test(file.type) || file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error("Choose a PNG, JPEG, or WebP image smaller than 15 MB.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    let longestSide = Math.min(Math.max(bitmap.width, bitmap.height), 1400);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const scale = Math.min(1, longestSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("This browser cannot process the image.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const quality = Math.max(0.38, 0.78 - Math.max(0, attempt - 3) * 0.07);
      const encoded = await blobAsDataUrl(await canvasBlob(canvas, quality));
      if (encoded.length <= MAX_IMAGE_SOURCE_LENGTH) return encoded;
      longestSide = Math.floor(longestSide * 0.78);
    }
  } finally {
    bitmap.close();
  }
  throw new Error("The image is too detailed to fit safely in a Markdown note.");
}

export function createFieldnotesEditorAdapters(): MarkdownLiveEditorAdapters {
  return {
    uploadImage: compressImage,
    async fetchBookmarkMetadata(url, signal) {
      const response = await apiRequest<{ metadata: BookmarkMetadata }>(
        "/api/bookmarks/metadata?url=" + encodeURIComponent(url),
        { signal },
      );
      return response.metadata;
    },
    async listSnippets() {
      return listSnippets();
    },
    async saveSnippet(input: NewEditorSnippet) {
      const snippets = listSnippets();
      const id = input.id || crypto.randomUUID();
      const snippet: EditorSnippet = {
        id,
        name: input.name.trim().slice(0, 80),
        content: input.content.slice(0, 10_000),
        shortcut: input.shortcut?.trim().slice(0, 64) || null,
      };
      if (!snippet.name) throw new Error("Snippet name cannot be empty.");
      const next = [...snippets.filter((item) => item.id !== id), snippet].slice(-MAX_SNIPPETS);
      storeSnippets(next);
      return snippet;
    },
    async deleteSnippet(id) {
      storeSnippets(listSnippets().filter((snippet) => snippet.id !== id));
    },
    async queryVisualization(query: VisualizationQuery, signal: AbortSignal): Promise<VisualizationQueryResponse> {
      return apiRequest<VisualizationQueryResponse>("/api/views/query", {
        method: "POST",
        body: JSON.stringify({ query }),
        signal,
      });
    },
    async executeVisualizationAction(action: VisualizationAction): Promise<Record<string, unknown>> {
      return apiRequest<Record<string, unknown>>("/api/views/actions", {
        method: "POST",
        body: JSON.stringify(action),
      });
    },
    isVisualizationTrusted(documentId: string, blockIndex: number, sourceHash: string): boolean {
      try { return window.localStorage.getItem(visualizationTrustKey(documentId, blockIndex, sourceHash)) !== null; }
      catch { return false; }
    },
    trustVisualization(documentId: string, blockIndex: number, sourceHash: string): void {
      storeVisualizationTrust(documentId, blockIndex, sourceHash);
    },
    revokeVisualizationTrust(documentId: string, blockIndex: number, sourceHash: string): void {
      try { window.localStorage.removeItem(visualizationTrustKey(documentId, blockIndex, sourceHash)); }
      catch { throw new Error("Could not revoke this visualization's trust record."); }
    },
    resolveLocalImage({ documentId, documentPath, documentHash, source, assetPath }) {
      if (documentPath.startsWith("babies/")) {
        const query = new URLSearchParams({ documentId, source });
        return `/api/preview/babies/asset?${query.toString()}`;
      }
      if (!documentHash) return null;
      const query = new URLSearchParams({ asset: assetPath, v: documentHash });
      return `/api/views/assets/${encodeURIComponent(documentId)}?${query.toString()}`;
    },
    resolveReferencedVaultAsset(documentId, assetPath, contentHash) {
      const query = new URLSearchParams({ asset: assetPath, v: contentHash });
      return `/api/views/assets/${encodeURIComponent(documentId)}?${query.toString()}`;
    },
    subscribeToVaultChanges,
    enableCustomVisualizations: true,
  };
}
