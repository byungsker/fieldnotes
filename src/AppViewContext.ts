import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { WorkspaceNavigation, WorkspaceRoute } from "./workspace-routing";

export type WorkspaceScreen = WorkspaceRoute & { activityId: string };

export type AppViewContextValue = {
  currentRoute: WorkspaceRoute;
  navigation: WorkspaceNavigation;
  renderWorkspace: (screen: WorkspaceScreen, navigation: WorkspaceNavigation) => ReactNode;
};

export const AppViewContext = createContext<AppViewContextValue | null>(null);

export function useAppViewContext(): AppViewContextValue {
  const value = useContext(AppViewContext);
  if (!value) throw new Error("Fieldnotes Stackflow activity must be inside AppViewContext.");
  return value;
}
