import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import { apiRequest, jsonRequest } from "./api";

type VaultSettingsState = {
  currentPath: string | null;
  selectedPath: string | null;
  configuredPath: string | null;
  restartRequired: boolean;
  documentsRoot: string;
};
type SettingsResponse = { settings: VaultSettingsState };
type DirectoryEntry = { name: string; relativePath: string };
type DirectoryResponse = { listing: { relativePath: string; directories: DirectoryEntry[] } };
type VerifyResponse = { verified: true; path: string; state: "empty" | "managed"; relativePath: string };

export function VaultSettingsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const historyEntryRef = useRef(false);
  const closePendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const listingRequestRef = useRef(0);
  const [settings, setSettings] = useState<VaultSettingsState | null>(null);
  const [listing, setListing] = useState<DirectoryResponse["listing"] | null>(null);
  const [verified, setVerified] = useState<VerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const loadDirectory = useCallback(async (relativePath: string) => {
    const requestId = ++listingRequestRef.current;
    setLoading(true);
    setError("");
    setMessage("");
    setVerified(null);
    try {
      const response = await apiRequest<DirectoryResponse>(`/api/vault/settings/directories?relativePath=${encodeURIComponent(relativePath)}`);
      if (requestId === listingRequestRef.current) setListing(response.listing);
    } catch (cause) {
      if (requestId === listingRequestRef.current) setError(cause instanceof Error ? cause.message : "Could not browse server folders.");
    } finally {
      if (requestId === listingRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    window.requestAnimationFrame(() => dialog.querySelector<HTMLButtonElement>("[data-initial-focus]")?.focus());
    window.history.pushState({ ...(window.history.state ?? {}), fieldnotesVaultSettings: true }, "", window.location.href);
    historyEntryRef.current = true;
    const handlePopState = () => {
      if (!historyEntryRef.current) return;
      historyEntryRef.current = false;
      closePendingRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener("popstate", handlePopState);
    void apiRequest<SettingsResponse>("/api/vault/settings")
      .then((response) => setSettings(response.settings))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not read vault settings."));
    void loadDirectory("");
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (historyEntryRef.current) {
        historyEntryRef.current = false;
        window.history.back();
      }
      if (dialog.open) dialog.close();
      openerRef.current?.focus({ preventScroll: true });
      openerRef.current = null;
    };
  }, [loadDirectory]);

  const close = () => {
    if (closePendingRef.current) return;
    if (historyEntryRef.current) {
      closePendingRef.current = true;
      window.history.back();
    } else {
      onCloseRef.current();
    }
  };

  const verifyCurrent = async () => {
    if (!listing) return;
    setBusy(true);
    setError("");
    setMessage("");
    setVerified(null);
    try {
      const result = await apiRequest<VerifyResponse>("/api/vault/settings/verify", jsonRequest("POST", { relativePath: listing.relativePath }));
      setVerified({ ...result, relativePath: listing.relativePath });
      setMessage(result.state === "managed" ? "Existing Fieldnotes vault verified." : "Empty private folder verified. No files will be moved or imported.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not verify this folder.");
    } finally {
      setBusy(false);
    }
  };

  const saveCurrentFolder = async () => {
    if (!listing || !verified || verified.relativePath !== listing.relativePath) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest<SettingsResponse>("/api/vault/settings/selection", jsonRequest("POST", { relativePath: listing.relativePath }));
      setSettings(result.settings);
      setMessage(result.settings.restartRequired
        ? "Saved for the next server restart. The current vault stays active until then."
        : "This folder is already the active vault.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this folder selection.");
    } finally {
      setBusy(false);
    }
  };

  const clearSelection = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest<SettingsResponse>("/api/vault/settings/selection", jsonRequest("DELETE"));
      setSettings(result.settings);
      setMessage("Saved folder selection cleared. The configured vault will be used after restart.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear the saved folder selection.");
    } finally {
      setBusy(false);
    }
  };

  const pathSegments = listing?.relativePath ? listing.relativePath.split("/") : [];
  const navigateUp = () => void loadDirectory(pathSegments.slice(0, -1).join("/"));

  return (
    <dialog
      ref={dialogRef}
      className="action-dialog action-dialog-centered vault-settings-dialog"
      aria-labelledby="vault-settings-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="vault-settings-panel">
        <header className="vault-settings-header">
          <div>
            <div className="eyebrow">SERVER STORAGE</div>
            <h2 id="vault-settings-title">Vault settings</h2>
          </div>
          <button data-initial-focus type="button" className="action-dialog-close" onClick={close} aria-label="Close vault settings"><X size={18} /></button>
        </header>

        <section className="vault-path-summary" aria-label="Current server vault">
          <span className="vault-path-label">CURRENT VAULT ON THIS MAC</span>
          <code>{settings?.currentPath ?? "No Markdown vault is active (SQLite mode)."}</code>
          {settings?.restartRequired && (settings.selectedPath || settings.configuredPath) && <p className="vault-pending-path"><strong>After restart:</strong> <code>{settings.selectedPath ?? settings.configuredPath}</code></p>}
          <p>Folder choices apply after a server restart. Fieldnotes keeps the current vault active until then and never moves or deletes notes.</p>
        </section>

        <section className="vault-folder-browser" aria-label="Browse server Documents folders">
          <div className="vault-folder-toolbar">
            <div className="vault-breadcrumbs" aria-label="Current folder">
              <button type="button" onClick={() => void loadDirectory("")}>Documents</button>
              {pathSegments.map((segment, index) => (
                <span className="vault-breadcrumb-item" key={`${segment}-${index}`}>
                  <ChevronRight size={13} aria-hidden="true" />
                  <button type="button" onClick={() => void loadDirectory(pathSegments.slice(0, index + 1).join("/"))}>{segment}</button>
                </span>
              ))}
            </div>
            <button type="button" className="vault-verify-button" onClick={() => void verifyCurrent()} disabled={busy || loading || !listing || !listing.relativePath}>
              {busy ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
              Verify this folder
            </button>
          </div>
          {listing?.relativePath && <button type="button" className="vault-directory-up" onClick={navigateUp}><ChevronRight size={14} aria-hidden="true" /> Up one level</button>}
          <div className="vault-directory-list" aria-busy={loading}>
            {loading ? <p className="vault-directory-empty" role="status">Loading folders…</p> : listing?.directories.length ? listing.directories.map((entry) => (
              <button type="button" className="vault-directory-row" key={entry.relativePath} onClick={() => void loadDirectory(entry.relativePath)}>
                <Folder size={16} aria-hidden="true" /><span>{entry.name}</span><ChevronRight size={15} aria-hidden="true" />
              </button>
            )) : <p className="vault-directory-empty">No visible subfolders here.</p>}
          </div>
        </section>

        <footer className="vault-settings-footer">
          <div className="vault-settings-feedback" aria-live="polite" role={error ? "alert" : "status"}>
            {error || message || "Only empty private folders or existing Fieldnotes vaults can be selected."}
            {verified && !error && <code className="vault-verified-path">{verified.path}</code>}
          </div>
          <div className="vault-settings-actions">
            {settings?.selectedPath && <button type="button" className="vault-settings-secondary" onClick={() => void clearSelection()} disabled={busy}>Use configured vault</button>}
            <button type="button" className="vault-settings-secondary" onClick={close}>Close</button>
            <button type="button" className="vault-settings-primary" onClick={() => void saveCurrentFolder()} disabled={busy || !verified || error !== ""}>Use this folder after restart</button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
