import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";

const stored = localStorage.getItem("evals-theme");
const theme =
  stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
document.documentElement.dataset.theme = theme;

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
