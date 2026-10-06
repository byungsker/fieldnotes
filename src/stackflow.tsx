import { useEffect } from "react";
import { basicUIPlugin, AppScreen } from "@stackflow/plugin-basic-ui";
import { basicRendererPlugin } from "@stackflow/plugin-renderer-basic";
import { historySyncPlugin } from "@stackflow/plugin-history-sync";
import { stackflow, useActivity, useFlow, useStack } from "@stackflow/react";
import type { ActivityComponentType } from "@stackflow/react";
import "@stackflow/plugin-basic-ui/index.css";
import { stackConfig } from "./stackflow.config";
import { useAppViewContext, type WorkspaceRoute, type WorkspaceScreen } from "./AppViewContext";

function ActivityScreen({ screen }: { screen: WorkspaceRoute }) {
  const app = useAppViewContext();
  const flow = useFlow();
  const stack = useStack();
  const activity = useActivity();
  const current = stack.activities.find((item) => item.isActive);
  const active = current?.id === activity.id;

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      const activityRoot = document.getElementById(`fieldnotes-activity-${activity.id}`);
      const target = screen.kind === "document"
        ? activityRoot?.querySelector<HTMLElement>(".editor-pane")
        : activityRoot?.querySelector<HTMLElement>(".workspace-title") ?? activityRoot?.querySelector<HTMLElement>("h1");
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, activity.id, screen.kind]);

  const workspaceScreen: WorkspaceScreen = { ...screen, activityId: activity.id } as WorkspaceScreen;

  return (
    <AppScreen className="fieldnotes-stack-screen">
      {app.renderWorkspace(workspaceScreen, flow, stack)}
    </AppScreen>
  );
}

const LibraryActivity: ActivityComponentType<"Library"> = () => (
  <ActivityScreen screen={{ kind: "library" }} />
);

const RecentActivity: ActivityComponentType<"Recent"> = () => (
  <ActivityScreen screen={{ kind: "recent" }} />
);

const FolderActivity: ActivityComponentType<"Folder"> = ({ params }) => {
  const app = useAppViewContext();
  const { selectFolderForRoute } = app;
  const activity = useActivity();
  const stack = useStack();
  const current = stack.activities.find((item) => item.isActive);
  const active = current?.id === activity.id;

  useEffect(() => {
    if (active) selectFolderForRoute(params.folderId);
  }, [active, selectFolderForRoute, params.folderId]);

  return <ActivityScreen screen={{ kind: "folder", folderId: params.folderId }} />;
};

const DocumentActivity: ActivityComponentType<"Document"> = ({ params }) => {
  const app = useAppViewContext();
  const { ensureDocumentForRoute } = app;
  const activity = useActivity();
  const stack = useStack();
  const current = stack.activities.find((item) => item.isActive);
  const active = current?.id === activity.id;

  useEffect(() => {
    if (active) void ensureDocumentForRoute(params.documentId);
  }, [active, ensureDocumentForRoute, params.documentId]);

  return <ActivityScreen screen={{ kind: "document", documentId: params.documentId }} />;
};

const NotFoundActivity: ActivityComponentType<"NotFound"> = () => (
  <ActivityScreen screen={{ kind: "not-found" }} />
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
    }),
  ],
});

export const Stack = stackflowOutput.Stack;
