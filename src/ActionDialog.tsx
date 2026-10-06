import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";

export type ActionDialogConfig =
  | {
      kind: "confirm";
      title: string;
      description: string;
      confirmLabel: string;
      cancelLabel?: string;
      destructive?: boolean;
    }
  | {
      kind: "prompt";
      title: string;
      description?: string;
      label: string;
      initialValue: string;
      submitLabel: string;
      maxLength?: number;
    };

export type ActionDialogResult = boolean | string | null;

const NO_PENDING_RESULT = Symbol("no pending dialog result");

function PromptForm({
  config,
  promptRef,
  onCancel,
  onSubmit,
}: {
  config: Extract<ActionDialogConfig, { kind: "prompt" }>;
  promptRef: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(config.initialValue);
  return (
    <form
      className="action-dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <label htmlFor="action-dialog-input">{config.label}</label>
      <input
        ref={promptRef}
        id="action-dialog-input"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        maxLength={config.maxLength}
        autoComplete="off"
        required
      />
      <div className="action-dialog-actions">
        <button className="dialog-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="dialog-primary" type="submit">{config.submitLabel}</button>
      </div>
    </form>
  );
}

export function ActionDialog({
  config,
  onResolve,
}: {
  config: ActionDialogConfig | null;
  onResolve: (result: ActionDialogResult) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const promptRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const historyEntryRef = useRef(false);
  const closingRef = useRef(false);
  const pendingResultRef = useRef<ActionDialogResult | typeof NO_PENDING_RESULT>(NO_PENDING_RESULT);
  const onResolveRef = useRef(onResolve);

  useEffect(() => {
    onResolveRef.current = onResolve;
  }, [onResolve]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const layoutHeight = Math.min(document.documentElement.clientHeight || window.innerHeight, window.innerHeight);
      const visualHeight = viewport?.height ?? layoutHeight;
      const height = Math.min(visualHeight, layoutHeight);
      document.documentElement.style.setProperty("--fieldnotes-visual-height", `${height}px`);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.documentElement.style.removeProperty("--fieldnotes-visual-height");
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (config) {
      if (!dialog.open) {
        closingRef.current = false;
        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
        window.requestAnimationFrame(() => {
          if (config.kind === "prompt") promptRef.current?.focus();
          else cancelRef.current?.focus();
        });
      }
      if (!historyEntryRef.current) {
        window.history.pushState({ ...(window.history.state ?? {}), fieldnotesDialog: true }, "", window.location.href);
        historyEntryRef.current = true;
      }
      return;
    }

    if (dialog.open) dialog.close();
    openerRef.current?.focus({ preventScroll: true });
    openerRef.current = null;
  }, [config]);

  useEffect(() => {
    const onPopState = () => {
      if (!historyEntryRef.current) return;
      historyEntryRef.current = false;
      closingRef.current = true;
      const pending = pendingResultRef.current;
      pendingResultRef.current = NO_PENDING_RESULT;
      onResolveRef.current(pending === NO_PENDING_RESULT ? null : pending);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const complete = (result: ActionDialogResult) => {
    if (closingRef.current) return;
    if (historyEntryRef.current) {
      closingRef.current = true;
      pendingResultRef.current = result;
      window.history.back();
      return;
    }
    onResolve(result);
  };

  return (
    <dialog
      ref={dialogRef}
      className="action-dialog"
      aria-labelledby="action-dialog-title"
      aria-describedby={config?.description ? "action-dialog-description" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        complete(null);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) complete(null);
      }}
    >
      {config && (
        <div className="action-dialog-panel">
          <div className="action-dialog-grabber" aria-hidden="true" />
          <header className="action-dialog-header">
            <h2 id="action-dialog-title">{config.title}</h2>
            <button className="action-dialog-close" type="button" onClick={() => complete(null)} aria-label="Close dialog">
              <X size={18} />
            </button>
          </header>
          {config.description && <p id="action-dialog-description" className="action-dialog-description">{config.description}</p>}
          {config.kind === "confirm" ? (
            <div className="action-dialog-actions">
              <button ref={cancelRef} className="dialog-secondary" type="button" onClick={() => complete(false)}>
                {config.cancelLabel ?? "Cancel"}
              </button>
              <button className={config.destructive ? "dialog-primary destructive" : "dialog-primary"} type="button" onClick={() => complete(true)}>
                {config.confirmLabel}
              </button>
            </div>
          ) : (
            <PromptForm
              key={config.title}
              config={config}
              promptRef={promptRef}
              onCancel={() => complete(null)}
              onSubmit={(value) => complete(value)}
            />
          )}
        </div>
      )}
    </dialog>
  );
}
