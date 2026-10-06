import { useEffect } from "react";
import { basicUIPlugin, AppScreen } from "@stackflow/plugin-basic-ui";
import { basicRendererPlugin } from "@stackflow/plugin-renderer-basic";
import { historySyncPlugin } from "@stackflow/plugin-history-sync";
import { stackflow, useActivity, useFlow, useStack } from "@stackflow/react";
import type { ActivityComponentType, Actions } from "@stackflow/react";
import { createMemoryHistory } from "history";
import { AppViewContext, useAppViewContext, type AppViewContextValue, type WorkspaceScreen } from "./AppViewContext";
import { stackConfig } from "./stackflow.config";
import { workspaceRoutesEqual, type WorkspaceRoute } from "./workspace-routing";

const mobileHistory = createMemoryHistory({
  initialEntries: [window.location.pathname],
});

function replaceFlowRoute(flow: Actions, route: WorkspaceRoute): void {
  switch (route.kind) {
    case "library": flow.replace("Library", {}); break;
    case "recent": flow.replace("Recent", {}); break;
    case "folder": flow.replace("Folder", { folderId: route.folderId }); break;
    case "document": flow.replace("Document", { documentId: route.documentId }); break;
    case "not-found": flow.replace("NotFound", {}); break;
  }
}

function ActivityScreen({ route }: { route: WorkspaceRoute }) {
  const app = useAppViewContext();
  const flow = useFlow();
  const stack = useStack();
  const activity = useActivity();
  const currentRouteKind = app.currentRoute.kind;
  const restoreMobileListScroll = app.restoreMobileListScroll;
  const active = stack.activities.find((item) => item.isActive)?.id === activity.id;

  useEffect(() => {
    if (active && !workspaceRoutesEqual(route, app.currentRoute)) {
      replaceFlowRoute(flow, app.currentRoute);
    }
  }, [active, app.currentRoute, flow, route]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      const activityRoot = document.getElementById(`fieldnotes-activity-${activity.id}`);
      if (currentRouteKind === "library" || currentRouteKind === "folder") {
        restoreMobileListScroll(activity.id);
      }
      const target = currentRouteKind === "document"
        ? activityRoot?.querySelector<HTMLElement>(".editor-pane")
        : activityRoot?.querySelector<HTMLElement>(".workspace-title") ?? activityRoot?.querySelector<HTMLElement>("h1");
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, activity.id, currentRouteKind, restoreMobileListScroll]);

  const workspaceScreen = { ...app.currentRoute, activityId: activity.id, isActive: active } as WorkspaceScreen;

  return (
    <AppScreen className="fieldnotes-stack-screen">
      {app.renderWorkspace(workspaceScreen, app.navigation)}
    </AppScreen>
  );
}

const LibraryActivity: ActivityComponentType<"Library"> = () => (
  <ActivityScreen route={{ kind: "library" }} />
);

const RecentActivity: ActivityComponentType<"Recent"> = () => (
  <ActivityScreen route={{ kind: "recent" }} />
);

const FolderActivity: ActivityComponentType<"Folder"> = ({ params }) => (
  <ActivityScreen route={{ kind: "folder", folderId: params.folderId }} />
);

const DocumentActivity: ActivityComponentType<"Document"> = ({ params }) => (
  <ActivityScreen route={{ kind: "document", documentId: params.documentId }} />
);

const NotFoundActivity: ActivityComponentType<"NotFound"> = () => (
  <ActivityScreen route={{ kind: "not-found" }} />
);

const stackflowOutput = stackflow({
  config: stackConfig,
  components: {
    Library: LibraryActivity,
    Recent: RecentActivity,
    Folder: FolderActivity,
    Document: DocumentActivity,
    NotFound: NotFoundActivity,
  },
  plugins: [
    basicRendererPlugin(),
    basicUIPlugin({ theme: "cupertino", rootClassName: "fieldnotes-stack" }),
    historySyncPlugin({
      config: stackConfig,
      fallbackActivity: () => "NotFound",
      history: mobileHistory,
    }),
  ],
});

const Stack = stackflowOutput.Stack;

export function MobileWorkspace({ value }: { value: AppViewContextValue }) {
  return (
    <div className="mobile-workspace-root" data-fieldnotes-renderer="mobile-stackflow">
      <AppViewContext.Provider value={value}>
        <Stack />
      </AppViewContext.Provider>
    </div>
  );
}
