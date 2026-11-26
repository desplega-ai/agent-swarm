import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "../fixtures";

// `agent-swarm app-shot` drives its own Chromium against the built dashboard and this
// worker's API, the same way a swarm worker runs it against APP_URL after an app write.
const repoRoot = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

type ShotResult = {
  ok: boolean;
  shots: { label: string; file: string; settled: boolean }[];
  consoleErrors: string[];
  failedRequests: string[];
  problems: string[];
};

async function appShot(args: string[], env: Record<string, string>) {
  const out = await run("bun", ["src/cli.tsx", "app-shot", ...args, "--json", "--no-upload"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    timeout: 50_000,
  }).catch((err: { code?: number; stdout?: string; stderr?: string }) => err);
  const stdout = out.stdout ?? "";
  return {
    code: "code" in out ? (out.code ?? 0) : 0,
    stderr: out.stderr ?? "",
    result: JSON.parse(stdout) as ShotResult,
  };
}

test("app-shot renders an app as the calling agent and reports failures", async ({
  api,
  seed,
  swarm,
  baseURL,
}) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(120_000);
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-app-shot",
    definition: {
      models: {},
      queries: {},
      defaultPage: "main",
      pages: {
        main: {
          state: { shown: false },
          root: "stack",
          elements: {
            stack: { type: "Stack", props: {}, children: ["title", "reveal"] },
            title: { type: "Text", props: { content: "e2e app-shot heading" } },
            reveal: { type: "Button", props: { label: "Reveal", variant: "secondary" } },
          },
        },
      },
    },
  });
  const out = mkdtempSync(join(tmpdir(), "app-shot-"));
  const env = {
    APP_URL: baseURL ?? "",
    MCP_BASE_URL: swarm.apiUrl,
    API_KEY: swarm.apiKey,
    AGENT_SWARM_API_KEY: swarm.apiKey,
  };
  try {
    const ok = await appShot(
      [app.id, "--out", out, "--click", 'role=button[name="Reveal"]', "--timeout", "20000"],
      env,
    );
    expect(ok.result.problems).toEqual([]);
    expect(ok.result.ok).toBe(true);
    expect(ok.code).toBe(0);
    expect(ok.result.shots.map((shot) => shot.label)).toEqual(["initial", "click-1"]);
    for (const shot of ok.result.shots) {
      expect(existsSync(shot.file)).toBe(true);
      expect(statSync(shot.file).size).toBeGreaterThan(5_000);
    }
    // The page never held the real key: the proxy route adds it.
    expect(JSON.stringify(ok.result)).not.toContain(swarm.apiKey);

    const missing = await appShot(
      ["00000000-0000-4000-8000-000000000000", "--out", out, "--timeout", "5000"],
      env,
    );
    expect(missing.code).toBe(1);
    expect(missing.result.ok).toBe(false);
    expect(missing.result.problems.join("\n")).toContain("HTTP 404");
  } finally {
    rmSync(out, { recursive: true, force: true });
    await api.delete(`/api/apps/${app.id}`);
  }
});

test("app-shot forwards page iframe calls without the agent key", async ({
  api,
  seed,
  swarm,
  baseURL,
}) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(120_000);
  // The embedded page calls the fake API origin itself. Forwarded with the key it would
  // read 404 (an unknown app); forwarded bare it must read 401.
  const probe = "00000000-0000-4000-8000-0000000000a1";
  const pageRes = await fetch(`${swarm.apiUrl}/api/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${swarm.apiKey}`,
      "Content-Type": "application/json",
      "X-Agent-ID": seed?.agents.lead ?? "",
    },
    body: JSON.stringify({
      title: "e2e app-shot iframe probe",
      contentType: "text/html",
      authMode: "public",
      body: `<!doctype html><html><body><p id="s">probe running</p><script>
fetch("/api/apps/${probe}").then((r) => { document.getElementById("s").textContent = "probe done " + r.status; });
</script></body></html>`,
    }),
  });
  expect(pageRes.status).toBe(201);
  const { id: pageId } = (await pageRes.json()) as { id: string };
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-app-shot-iframe",
    definition: {
      models: {},
      queries: {},
      defaultPage: "main",
      pages: {
        main: {
          root: "frame",
          elements: { frame: { type: "PageFrame", props: { pageId } } },
        },
      },
    },
  });
  const out = mkdtempSync(join(tmpdir(), "app-shot-"));
  try {
    const shot = await appShot(
      [
        app.id,
        "--out",
        out,
        "--wait-for",
        "iframe >> internal:control=enter-frame >> text=/probe done/",
        "--timeout",
        "20000",
      ],
      {
        APP_URL: baseURL ?? "",
        MCP_BASE_URL: swarm.apiUrl,
        API_KEY: swarm.apiKey,
        AGENT_SWARM_API_KEY: swarm.apiKey,
        // A worker's own AGENT_ID would scope the page read to that agent (403 here).
        AGENT_ID: "",
      },
    );
    // The dashboard's own calls still carry the key: the app loads.
    expect(shot.result.problems).toEqual([]);
    expect(shot.result.ok).toBe(true);
    expect(shot.result.failedRequests).toContain(`GET /api/apps/${probe}: HTTP 401`);
  } finally {
    rmSync(out, { recursive: true, force: true });
    await api.delete(`/api/apps/${app.id}`);
    // 204, no JSON body for the api fixture to parse.
    await fetch(`${swarm.apiUrl}/api/pages/${pageId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${swarm.apiKey}`, "X-Agent-ID": seed?.agents.lead ?? "" },
    });
  }
});
