import { type ReactNode, useEffect, useState } from "react";
import {
  clearStoredApiKey,
  getStoredApiKey,
  setStoredApiKey,
  setUnauthorizedHandler,
} from "./api.ts";
import { navigate, useHashRoute } from "./hooks.ts";
import AnalyticsPage from "./pages/AnalyticsPage.tsx";
import ConfigsPage from "./pages/ConfigsPage.tsx";
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
      title={`Switch to the ${next} theme`}
    >
      ◐
    </button>
  );
}

function LoginScreen({
  error,
  onUnlock,
}: {
  error: string | null;
  onUnlock: (key: string) => void;
}): ReactNode {
  const [key, setKey] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setLocalError("Paste the evals API key.");
      return;
    }
    onUnlock(trimmed);
  };
  const displayedError = localError ?? error;
  return (
    <main className="auth-shell">
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-brand">
          <img src="/logo.png" width={28} height={28} alt="swarm logo" />
          <h1>
            swarm <span className="accent">evals</span>
          </h1>
        </div>
        <label htmlFor="evals-api-key">Master key</label>
        <input
          id="evals-api-key"
          type="password"
          autoComplete="current-password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            setLocalError(null);
          }}
        />
        {displayedError ? <p className="auth-error">{displayedError}</p> : null}
        <button type="submit">Log in</button>
      </form>
    </main>
  );
}

export default function App(): ReactNode {
  const { parts } = useHashRoute();
  const [apiKey, setApiKey] = useState(() => getStoredApiKey());
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setApiKey(null);
      setAuthError("Invalid key — please log in again.");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

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

  if (!apiKey) {
    return (
      <LoginScreen
        error={authError}
        onUnlock={(key) => {
          setStoredApiKey(key);
          setApiKey(key);
          setAuthError(null);
        }}
      />
    );
  }

  let page: ReactNode;
  if (parts[0] === "scenarios") {
    page = <ScenariosPage scenarioId={parts[1] ?? null} />;
  } else if (parts[0] === "configs") {
    page = <ConfigsPage configId={parts[1] ?? null} />;
  } else if (parts[0] === "analytics") {
    page = <AnalyticsPage />;
  } else if (parts[0] === "runs" && parts[1] && !legacyCell) {
    const attemptId = parts[2] === "attempts" && parts[3] ? parts[3] : null;
    page = <RunDetailsPage runId={parts[1]} attemptId={attemptId} />;
  } else {
    page = <RunsPage />;
  }

  const section =
    parts[0] === "scenarios"
      ? "scenarios"
      : parts[0] === "configs"
        ? "configs"
        : parts[0] === "analytics"
          ? "analytics"
          : "runs";

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
            Runs
          </a>
          <a className={section === "analytics" ? "pill active" : "pill"} href="#/analytics">
            Analytics
          </a>
          <a className={section === "scenarios" ? "pill active" : "pill"} href="#/scenarios">
            Scenarios
          </a>
          <a className={section === "configs" ? "pill active" : "pill"} href="#/configs">
            Configs
          </a>
        </nav>
        <button
          type="button"
          className="logout-button"
          onClick={() => {
            clearStoredApiKey();
            setApiKey(null);
            setAuthError(null);
          }}
        >
          Log out
        </button>
        <ThemeToggle />
      </header>
      <main className="app-main">{page}</main>
    </>
  );
}
