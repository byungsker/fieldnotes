import { createContext, useContext } from "react";
import type { Stack } from "@stackflow/core";
import type { Actions } from "@stackflow/react";
import type { ReactNode } from "react";

type ScreenActivity = { activityId: string };
export type WorkspaceRoute =
  | { kind: "library" }
  | { kind: "recent" }
  | { kind: "folder"; folderId: string }
  | { kind: "document"; documentId: string }
  | { kind: "not-found" };
export type WorkspaceScreen = WorkspaceRoute & ScreenActivity;

export type AppViewContextValue = {
  renderWorkspace: (screen: WorkspaceScreen, flow: Actions, stack: Stack) => ReactNode;
  ensureDocumentForRoute: (id: string) => Promise<void>;
  selectFolderForRoute: (id: string) => void;
};

export const AppViewContext = createContext<AppViewContextValue | null>(null);

export function useAppViewContext(): AppViewContextValue {
  const value = useContext(AppViewContext);
  if (!value) throw new Error("Fieldnotes Stackflow activity must be inside AppViewContext.");
  return value;
}
