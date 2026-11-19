import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";
import "@/styles/ag-grid.css";
import "@/styles/json-render.css";
import "@/styles/markdown.css";
import App from "@/app/App";
import { loadModelsSnapshot } from "@/lib/models-snapshot";
import { applyUiFont, readStoredUiFont } from "@/lib/ui-font";

// Before the first render, so the first paint already uses the chosen font.
applyUiFont(readStoredUiFont());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The models.dev snapshot is its own chunk: fetch it once the first render is
// done, so a model picker opened later finds it loaded.
const preloadModelsSnapshot = () => {
  loadModelsSnapshot().catch(() => {});
};
if ("requestIdleCallback" in window) window.requestIdleCallback(preloadModelsSnapshot);
else setTimeout(preloadModelsSnapshot, 1000);
