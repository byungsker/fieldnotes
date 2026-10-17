import React from "react";
import { createRoot } from "react-dom/client";
import { WorkspacePage } from "../pages/workspace";
import "@stackflow/plugin-basic-ui/index.css";
import "../../packages/markdown-live-editor/styles.css";
import "../pages/workspace/index.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WorkspacePage />
  </React.StrictMode>,
);
