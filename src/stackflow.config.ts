import { defineConfig } from "@stackflow/config";

declare module "@stackflow/config" {
  interface Register {
    Library: Record<string, never>;
    Recent: Record<string, never>;
    Folder: { folderId: string };
    Document: { documentId: string };
    NotFound: Record<string, never>;
  }
}

export const stackConfig = defineConfig({
  activities: [
    { name: "Library", route: "/" },
    { name: "Recent", route: "/recent" },
    { name: "Folder", route: "/folders/:folderId" },
    { name: "Document", route: "/notes/:documentId" },
    { name: "NotFound", route: "/404" },
  ],
  initialActivity: () => "Library",
  transitionDuration: 280,
});
