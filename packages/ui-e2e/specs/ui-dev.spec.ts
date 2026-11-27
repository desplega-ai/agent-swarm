import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { expect, test } from "../fixtures";

// `bun run ui:dev` starts its own Vite dev server pre-connected to this worker's API. A browser
// with empty storage opens the printed URL: no /setup redirect, no identity dialog, and the
// page frame plus its Browser SDK calls go through the dev server's same-origin proxy.
const repoRoot = resolve(import.meta.dirname, "../../..");

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function startUiDev(
  args: string[],
  env: Record<string, string>,
): Promise<{ child: ChildProcess; url: string; stderr: () => string }> {
  const child = spawn("bun", ["scripts/ui-dev/index.ts", ...args, "--json"], {
    cwd: repoRoot,
    env: { ...process.env, MCP_BASE_URL: "", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`ui:dev not ready: ${stderr.slice(-800)}`)),
      90_000,
    );
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("\n")) return;
      clearTimeout(timer);
      done(String(JSON.parse(stdout.trim()).url));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`ui:dev exited ${code}: ${stderr.slice(-800)}`));
    });
  });
  return { child, url, stderr: () => stderr };
}

test("ui:dev opens an app and an authed HTML page pre-connected, with empty storage", async ({
  browser,
  api,
  seed,
  swarm,
}) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(150_000);
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-ui-dev",
    definition: {
      models: {},
      queries: {},
      defaultPage: "main",
      pages: {
        main: {
          root: "stack",
          elements: {
            stack: { type: "Stack", props: {}, children: ["title"] },
            title: { type: "Text", props: { content: "e2e ui-dev heading" } },
          },
        },
      },
    },
  });
  // Pages belong to an agent: the shared `api` fixture sends no X-Agent-ID.
  const created = await fetch(`${swarm.apiUrl}/api/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${swarm.apiKey}`,
      "X-Agent-ID": seed!.agents.lead,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: "e2e ui-dev authed page",
      contentType: "text/html",
      authMode: "authed",
      body: `<!doctype html><html><body><h1>ui-dev frame</h1><p id="kv">kv pending</p><script>
      swarmSdk.kv.set("probe", "ok")
        .then(() => swarmSdk.kv.get("probe"))
        .then((r) => { document.getElementById("kv").textContent = "kv " + JSON.stringify(r); })
        .catch((e) => { document.getElementById("kv").textContent = "kv error " + e; });
    </script></body></html>`,
    }),
  });
  expect(created.status).toBe(201);
  const page = (await created.json()) as { id: string };

  const env = { AGENT_SWARM_API_KEY: swarm.apiKey, API_KEY: swarm.apiKey };
  const common = ["--api-url", swarm.apiUrl, "--as-email", "e2e-user@gmail.com"];
  const appDev = await startUiDev(
    ["--app", app.id, "--port", String(await freePort()), ...common],
    env,
  );
  const pageDev = await startUiDev(
    ["--page", page.id, "--port", String(await freePort()), ...common],
    env,
  );
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));

    await tab.goto(appDev.url);
    await expect(tab.getByText("e2e ui-dev heading")).toBeVisible({ timeout: 60_000 });
    expect(new URL(tab.url()).pathname).toBe(`/apps/${app.id}`);

    await tab.goto(pageDev.url);
    const frame = tab.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "ui-dev frame" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(frame.locator("#kv")).toContainText('"ok"', { timeout: 20_000 });
    expect(new URL(tab.url()).pathname).toBe(`/pages/${page.id}`);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    appDev.child.kill("SIGTERM");
    pageDev.child.kill("SIGTERM");
    // Raw fetch: both deletes answer 204, which the `api` fixture cannot parse.
    const headers = { Authorization: `Bearer ${swarm.apiKey}`, "X-Agent-ID": seed!.agents.lead };
    await fetch(`${swarm.apiUrl}/api/apps/${app.id}`, { method: "DELETE", headers });
    await fetch(`${swarm.apiUrl}/api/pages/${page.id}`, { method: "DELETE", headers });
  }
});

test("ui:dev --api local serves a copied app and authed page from the fixtures", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Local mode reads nothing from a source API: the fixtures name the targets.
  const appDev = await startUiDev(
    [
      "--api",
      "local",
      "--fixture",
      "scripts/ui-dev/fixtures/sample-app.json",
      "--port",
      String(await freePort()),
    ],
    {},
  );
  const pageDev = await startUiDev(
    [
      "--api",
      "local",
      "--fixture",
      "scripts/ui-dev/fixtures/sample-page.json",
      "--port",
      String(await freePort()),
    ],
    {},
  );
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));

    await tab.goto(appDev.url);
    await expect(tab.getByRole("heading", { name: "ui-dev sample app" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(tab.getByText("Sample item 12")).toBeVisible();
    const action = tab.waitForResponse(
      (res) => res.request().method() === "POST" && /\/actions\/ping$/.test(res.url()),
    );
    await tab.getByRole("button", { name: "Ping" }).click();
    expect((await action).status()).toBe(200);

    await tab.goto(pageDev.url);
    const frame = tab.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "ui-dev sample page" })).toBeVisible({
      timeout: 60_000,
    });
    // The fixture's KV entry (41) was copied, and the page's own increment goes to the copy.
    await expect(frame.locator("#visits")).toContainText("42", { timeout: 20_000 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    appDev.child.kill("SIGTERM");
    pageDev.child.kill("SIGTERM");
  }
});
