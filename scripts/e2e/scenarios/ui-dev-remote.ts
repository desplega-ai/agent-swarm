import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { minimalEnv, repoRoot, reservedPort } from "../sut";
import { registerAgent } from "./knowledge-helpers";

type Run = { code: number; stdout: string; stderr: string };

/** `bun run ui:dev` against this SUT. `held` runs while the dev server is up, then SIGTERM. */
async function uiDev(
  args: string[],
  env: Record<string, string>,
  held?: (ready: Record<string, unknown>) => Promise<void>,
): Promise<Run> {
  const child = Bun.spawn(["bun", "scripts/ui-dev/index.ts", ...args], {
    cwd: repoRoot,
    env: { ...minimalEnv(), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let stdout = "";
  const kill = setTimeout(() => child.kill("SIGKILL"), 150_000);
  try {
    if (held) {
      while (!stdout.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += new TextDecoder().decode(value);
      }
      if (stdout.includes("\n")) {
        try {
          await held(asRecord(JSON.parse(stdout.trim())));
        } finally {
          child.kill("SIGTERM");
        }
      }
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += new TextDecoder().decode(value);
    }
    return { code: await child.exited, stdout, stderr: await stderr };
  } finally {
    clearTimeout(kill);
  }
}

/**
 * `bun run ui:dev` (scripts/ui-dev): a dashboard dev server pre-connected to an API as a fixed
 * user. The browser render runs in packages/ui-e2e/specs/ui-dev.spec.ts; this checks the
 * ready line, the same-origin proxy, the slug lookup, usage errors and teardown.
 */
export const uiDevRemote: Scenario = {
  name: "ui-dev-remote",
  order: 694,
  async run(ctx) {
    const owner = await registerAgent(ctx, "ui-dev-owner");
    const email = `ui-dev-${ctx.nonce}@e2e.invalid`;
    const user = await ctx.api("POST", "/api/users", {
      body: { name: `ui-dev ${ctx.nonce}`, email, status: "active" },
    });
    expectStatus(user, [200], "create the dashboard user");
    const userId = asString(asRecord(asRecord(user.json).user).id, "user id");

    const app = await ctx.api("POST", "/api/apps", {
      agentId: owner,
      body: {
        name: `E2E ui-dev ${ctx.nonce}`,
        definition: {
          models: {},
          queries: {},
          actions: {},
          pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
          defaultPage: "main",
        },
      },
    });
    expectStatus(app, [201], "create the app");
    const appId = asString(asRecord(asRecord(app.json).app).id, "app id");

    const marker = `ui-dev-marker-${ctx.nonce}`;
    const slug = `e2e-ui-dev-${ctx.nonce}`;
    const page = await ctx.api("POST", "/api/pages", {
      agentId: owner,
      body: {
        slug,
        title: `ui-dev page ${ctx.nonce}`,
        contentType: "text/html",
        authMode: "public",
        body: `<!doctype html><html><body><h1>${marker}</h1></body></html>`,
      },
    });
    expectStatus(page, [201], "create the page");
    const pageId = asString(asRecord(page.json).id, "page id");

    // No MCP_BASE_URL: --api-url must be loopback, which the SUT is.
    const env = { AGENT_SWARM_API_KEY: ctx.apiKey };
    try {
      const port = await reservedPort();
      const appRun = await uiDev(
        [
          "--app",
          appId,
          "--api-url",
          ctx.baseUrl,
          "--port",
          String(port),
          "--as-email",
          email,
          "--json",
        ],
        env,
        async (ready) => {
          const url = new URL(asString(ready.url, "ready url"));
          expect(url.origin === `http://127.0.0.1:${port}`, `ready url origin: ${url.origin}`);
          expect(url.pathname === `/apps/${appId}`, `ready url path: ${url.pathname}`);
          expect(asRecord(ready.target).kind === "app", "target kind app");
          expect(ready.userId === userId, `ready userId ${String(ready.userId)}`);
          expect(!JSON.stringify(ready).includes(ctx.apiKey), "the ready line carries the key");

          const shell = await fetch(url);
          expect(shell.status === 200, `dashboard shell HTTP ${shell.status}`);
          expect((await shell.text()).includes('id="root"'), "dashboard shell HTML");

          // The API sits behind the dev server's own origin.
          const health = await fetch(`${url.origin}/health`);
          expect(health.status === 200, `proxied /health HTTP ${health.status}`);
          const body = await fetch(`${url.origin}/p/${pageId}`);
          expect(body.status === 200, `proxied /p/<id> HTTP ${body.status}`);
          expect((await body.text()).includes(marker), "proxied page body");
          expect(
            (body.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'self'"),
            "page CSP lets the same origin frame it",
          );
          // A dashboard route under /pages is not proxied.
          const pagesRoute = await fetch(`${url.origin}/pages/${pageId}`);
          expect((await pagesRoute.text()).includes('id="root"'), "/pages/<id> stays the SPA");
        },
      );
      expect(appRun.code === 0, `ui:dev --app exit ${appRun.code}: ${appRun.stderr.slice(-800)}`);
      const free = await fetch(`http://127.0.0.1:${port}/`).then(
        () => false,
        () => true,
      );
      expect(free, "the dev server stopped with ui:dev");

      const pagePort = await reservedPort();
      const pageRun = await uiDev(
        ["--page", slug, "--api-url", ctx.baseUrl, "--port", String(pagePort), "--json"],
        env,
        async (ready) => {
          expect(
            new URL(asString(ready.url, "ready url")).pathname === `/pages/${pageId}`,
            "the slug resolves to the page id",
          );
          const target = asRecord(ready.target);
          expect(target.contentType === "text/html", "page contentType");
          expect(target.authMode === "public", "page authMode");
        },
      );
      expect(
        pageRun.code === 0,
        `ui:dev --page exit ${pageRun.code}: ${pageRun.stderr.slice(-800)}`,
      );

      const usage: [string[], string][] = [
        [["--app", appId, "--page", pageId, "--api-url", ctx.baseUrl], "exactly one of"],
        [["--page", "0".repeat(32), "--api-url", ctx.baseUrl], "not found"],
        [
          [
            "--app",
            appId,
            "--api-url",
            ctx.baseUrl,
            "--as-email",
            `nobody-${ctx.nonce}@e2e.invalid`,
          ],
          "no swarm user",
        ],
        [
          ["--app", appId, "--api-url", "https://example.invalid"],
          "must be $MCP_BASE_URL or a loopback",
        ],
      ];
      for (const [args, message] of usage) {
        const run = await uiDev(args, env);
        expect(run.code === 2, `ui:dev ${args.join(" ")}: exit ${run.code}`);
        expect(run.stderr.includes(message), `ui:dev ${args.join(" ")}: ${run.stderr}`);
      }
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`);
      await ctx.api("DELETE", `/api/pages/${pageId}`, { agentId: owner });
    }
  },
};
