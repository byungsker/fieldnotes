import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@stackflow/plugin-basic-ui/index.css";
import "../packages/markdown-live-editor/styles.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
