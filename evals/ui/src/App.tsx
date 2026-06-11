import { type ReactNode, useEffect, useState } from "react";
import { navigate, useHashRoute } from "./hooks.ts";
import RunDetailsPage from "./pages/RunDetailsPage.tsx";
import RunsPage from "./pages/RunsPage.tsx";
import ScenariosPage from "./pages/ScenariosPage.tsx";

function ThemeToggle(): ReactNode {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  const next = theme === "dark" ? "light" : "dark";
  const toggle = () => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("evals-theme", next);
    setTheme(next);
  };
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      title={`switch to ${next} theme`}
    >
      ◐
    </button>
  );
}

export default function App(): ReactNode {
  const { parts } = useHashRoute();

  // Legacy redirect: #/runs/:id/cells/:scenarioId/:configId → first attempt of the cell
  // (attempt ids are deterministic `${runId}_${scenarioId}_${configId}_${index}`).
  const legacyCell =
    parts[0] === "runs" && parts[2] === "cells" && parts[1] && parts[3] && parts[4]
      ? { runId: parts[1], scenarioId: parts[3], configId: parts[4] }
      : null;
  useEffect(() => {
    if (legacyCell) {
      navigate(
        `#/runs/${legacyCell.runId}/attempts/${legacyCell.runId}_${legacyCell.scenarioId}_${legacyCell.configId}_0`,
      );
    }
  }, [legacyCell]);

  let page: ReactNode;
  if (parts[0] === "scenarios") {
    page = <ScenariosPage scenarioId={parts[1] ?? null} />;
  } else if (parts[0] === "runs" && parts[1] && !legacyCell) {
    const attemptId = parts[2] === "attempts" && parts[3] ? parts[3] : null;
    page = <RunDetailsPage runId={parts[1]} attemptId={attemptId} />;
  } else {
    page = <RunsPage />;
  }

  const section = parts[0] === "scenarios" ? "scenarios" : "runs";

  return (
    <>
      <header className="app-header">
        <a className="brand" href="#/runs">
          <img src="/logo.png" width={22} height={22} alt="swarm logo" />
          <span className="wordmark">
            swarm <span className="accent">evals</span>
          </span>
        </a>
        <nav className="nav-pills">
          <a className={section === "runs" ? "pill active" : "pill"} href="#/runs">
            runs
          </a>
          <a className={section === "scenarios" ? "pill active" : "pill"} href="#/scenarios">
            scenarios
          </a>
        </nav>
        <ThemeToggle />
      </header>
      <main className="app-main">{page}</main>
    </>
  );
}
