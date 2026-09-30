import { createRoot } from "react-dom/client";
import BenchmarkPage from "./pages/BenchmarkPage.tsx";
import "./styles.css";

// Public entry for /benchmark (Phase 10): its own bundle, so none of the logged-in
// app (and none of its scenario ids) ships to an anonymous visitor.
const stored = localStorage.getItem("evals-theme");
const theme =
  stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
document.documentElement.dataset.theme = theme;

const root = document.getElementById("root");
if (root) createRoot(root).render(<BenchmarkPage />);
