import { useEffect, useRef, useState } from "react";
import { parseVisualizationUiEvent, type VisualizationNote, type VisualizationTrashNote, type VisualizationUiEvent, type VisualizationValue } from "../../shared/visualization.ts";
import { acquireVisualizationSlot } from "./visualization-worker-slots.ts";
import { boundedVisualizationFrameHeight, INITIAL_VISUALIZATION_FRAME_HEIGHT } from "./visualization-frame-height.ts";

type RunnerStatus = {
  requestId?: unknown;
  eventId?: unknown;
  type: unknown;
  message?: unknown;
  event?: unknown;
  height?: unknown;
};

interface SandboxedVisualizationProps {
  javascript: string;
  notes: VisualizationNote[];
  trash: VisualizationTrashNote[];
  state: Record<string, VisualizationValue>;
  onAction: (event: VisualizationUiEvent) => Promise<Record<string, unknown> | void>;
}

function SandboxedVisualization({ javascript, notes, trash, state, onAction }: SandboxedVisualizationProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const readyRef = useRef(false);
  const connectedRef = useRef(false);
  const requestIdRef = useRef(0);
  const pendingRef = useRef<{ requestId: number; javascript: string; notes: VisualizationNote[]; trash: VisualizationTrashNote[]; state: Record<string, VisualizationValue> } | null>(null);
  const onActionRef = useRef(onAction);
  const pendingActionIdsRef = useRef(new Set<number>());
  const releaseSlotRef = useRef<{ requestId: number; release: () => void } | null>(null);
  const responseTimeoutRef = useRef<{ requestId: number; timer: number } | null>(null);
  const [status, setStatus] = useState("Starting isolated preview…");
  const [frameHeight, setFrameHeight] = useState(INITIAL_VISUALIZATION_FRAME_HEIGHT);
  const [parentOrigin] = useState(() => window.location.origin);
  onActionRef.current = onAction;

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    let handshakeTimer: number | undefined;
    const sendPing = () => {
      frame.contentWindow?.postMessage({ type: "fieldnotes-view-ping" }, "*");
    };
    const onRunnerReady = (event: MessageEvent) => {
      if (connectedRef.current || event.source !== frame.contentWindow || event.origin !== "null"
        || event.data?.type !== "fieldnotes-view-runner-ready") return;
      connectedRef.current = true;
      if (handshakeTimer !== undefined) window.clearInterval(handshakeTimer);
      handshakeTimer = undefined;
      portRef.current?.close();
      const channel = new MessageChannel();
      const port = channel.port1;
      portRef.current = port;
      readyRef.current = false;
      port.onmessage = (event: MessageEvent<RunnerStatus>) => {
        const message = event.data;
        if (!message || typeof message.type !== "string") return;
        if (message.type === "ready") {
          readyRef.current = true;
          const pending = pendingRef.current;
          if (pending) port.postMessage({ type: "run", ...pending });
          return;
        }
        if (message.type === "action") {
          if (message.requestId !== requestIdRef.current || typeof message.eventId !== "number" || !Number.isSafeInteger(message.eventId)) return;
          const eventId = message.eventId;
          const action = parseVisualizationUiEvent(message.event);
          if (!action) {
            port.postMessage({ type: "action-result", requestId: message.requestId, eventId, ok: false, message: "Unsupported view action." });
            setStatus("Unsupported view action.");
            return;
          }
          if (pendingActionIdsRef.current.has(eventId)) return;
          pendingActionIdsRef.current.add(eventId);
          setStatus("Applying a user action…");
          void onActionRef.current(action)
            .then(() => {
              if (portRef.current === port && message.requestId === requestIdRef.current) {
                port.postMessage({ type: "action-result", requestId: message.requestId, eventId, ok: true, message: "Action completed." });
                setStatus("Preview updated");
              }
            })
            .catch((caught: unknown) => {
              const errorMessage = caught instanceof Error ? caught.message : "The requested action failed.";
              if (portRef.current === port && message.requestId === requestIdRef.current) {
                port.postMessage({ type: "action-result", requestId: message.requestId, eventId, ok: false, message: errorMessage.slice(0, 240) });
                setStatus("");
              }
            })
            .finally(() => pendingActionIdsRef.current.delete(eventId));
          return;
        }
        if (message.type === "resize") {
          if (message.requestId !== requestIdRef.current) return;
          const height = boundedVisualizationFrameHeight(message.height);
          if (height !== null) setFrameHeight(height);
          return;
        }
        if (message.requestId !== requestIdRef.current) return;
        if (["complete", "error", "timeout"].includes(message.type) && releaseSlotRef.current?.requestId === message.requestId) {
          releaseSlotRef.current.release();
          releaseSlotRef.current = null;
        }
        if (["complete", "error", "timeout"].includes(message.type) && responseTimeoutRef.current?.requestId === message.requestId) {
          window.clearTimeout(responseTimeoutRef.current.timer);
          responseTimeoutRef.current = null;
        }
        if (message.type === "complete") setStatus("Preview updated");
        else if (message.type === "timeout") setStatus("Preview stopped after 700 ms.");
        else setStatus(typeof message.message === "string" && message.message ? message.message : "Preview could not render this result.");
      };
      port.start();
      // The runner has an opaque origin by design, so the initial port is sent to this frame reference.
      frame.contentWindow?.postMessage({ type: "fieldnotes-view-connect" }, "*", [channel.port2]);
    };
    frame.addEventListener("load", sendPing);
    window.addEventListener("message", onRunnerReady);
    sendPing();
    // A cached iframe may finish loading before this passive effect subscribes to `load`.
    // Retry only during the short handshake window so the ready message cannot be lost.
    let handshakeAttempts = 0;
    handshakeTimer = window.setInterval(() => {
      if (connectedRef.current || handshakeAttempts >= 20) {
        if (handshakeTimer !== undefined) window.clearInterval(handshakeTimer);
        handshakeTimer = undefined;
        return;
      }
      handshakeAttempts += 1;
      sendPing();
    }, 100);
    return () => {
      if (handshakeTimer !== undefined) window.clearInterval(handshakeTimer);
      portRef.current?.postMessage({ type: "cancel" });
      portRef.current?.close();
      portRef.current = null;
      releaseSlotRef.current?.release();
      releaseSlotRef.current = null;
      readyRef.current = false;
      connectedRef.current = false;
      frame.removeEventListener("load", sendPing);
      window.removeEventListener("message", onRunnerReady);
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const requestId = ++requestIdRef.current;
    const payload = { requestId, javascript, notes, trash, state };
    setFrameHeight(INITIAL_VISUALIZATION_FRAME_HEIGHT);
    pendingRef.current = payload;
    setStatus("Waiting for an isolated preview slot…");
    if (responseTimeoutRef.current) window.clearTimeout(responseTimeoutRef.current.timer);
    void acquireVisualizationSlot(abort.signal).then((releaseSlot) => {
      if (abort.signal.aborted) {
        releaseSlot();
        return;
      }
      releaseSlotRef.current = { requestId, release: releaseSlot };
      setStatus("Running in an isolated worker…");
      if (readyRef.current) portRef.current?.postMessage({ type: "run", ...payload });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setStatus(error instanceof Error ? error.message : "Preview could not start.");
    });
    const timer = window.setTimeout(() => {
      if (!abort.signal.aborted && requestIdRef.current === requestId) {
        setStatus("Preview runner did not respond.");
        portRef.current?.postMessage({ type: "cancel", requestId });
        if (releaseSlotRef.current?.requestId === requestId) {
          releaseSlotRef.current.release();
          releaseSlotRef.current = null;
        }
      }
      if (responseTimeoutRef.current?.requestId === requestId) responseTimeoutRef.current = null;
    }, 2_000);
    responseTimeoutRef.current = { requestId, timer };
    return () => {
      abort.abort();
      window.clearTimeout(timer);
      if (responseTimeoutRef.current?.requestId === requestId) responseTimeoutRef.current = null;
      if (readyRef.current) portRef.current?.postMessage({ type: "cancel", requestId });
      if (pendingRef.current?.requestId === requestId) pendingRef.current = null;
      if (releaseSlotRef.current?.requestId === requestId) {
        releaseSlotRef.current.release();
        releaseSlotRef.current = null;
      }
    };
  }, [javascript, notes, state, trash]);

  return (
    <div className="mle-fieldnotes-custom-preview">
      <p className="mle-fieldnotes-view-status" role="status">{status}</p>
      <p className="mle-fieldnotes-preview-hint">Scroll the page to see the rest of the dashboard.</p>
      <iframe
        ref={iframeRef}
        title="Custom Fieldnotes visualization"
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        src={`/visualization-runner.html?parentOrigin=${encodeURIComponent(parentOrigin)}`}
        style={{ height: `${frameHeight}px` }}
      />
    </div>
  );
}

export { SandboxedVisualization };
