import { runCli } from "../cli";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { minimalEnv, repoRoot, reservedPort } from "../sut";
import { registerAgent } from "./knowledge-helpers";

type Run = { code: number; stdout: string; stderr: string };

/** `bun run ui:dev` against this SUT. `held` runs while the dev server is up, then SIGTERM. */
export async function uiDev(
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
 * ready line, the same-origin proxy, the slug lookup, usage errors and teardown. Then
 * `agent-swarm ui-dev` (no checkout) against a stand-in dashboard host: the injected
 * connection, the key kept off the UI host, the same proxy, and the old-dashboard refusal.
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
        { ...env, VITE_ALLOWED_HOSTS: "*" },
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
          // The keyed bundle refuses a DNS-rebound Host, even with VITE_ALLOWED_HOSTS=* set.
          const rebound = await fetch(url, { headers: { Host: `rebind.example:${port}` } });
          expect(rebound.status === 403, `foreign Host HTTP ${rebound.status}`);

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

      // `agent-swarm ui-dev`: the dashboard bundle comes from APP_URL, a stand-in host here.
      const uiHeaders: (string | null)[] = [];
      const shellHtml = (marker: boolean) =>
        `<!doctype html><html><head>${marker ? '<meta name="agent-swarm-ui-runtime-config" content="1" />' : ""}<script async src="https://plausible.io/js/pa-x.js"></script><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>`;
      const uiHost = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          uiHeaders.push(req.headers.get("authorization") ?? req.headers.get("cookie"));
          const path = new URL(req.url).pathname;
          if (path.startsWith("/assets/")) {
            return new Response("export {};", { headers: { "content-type": "text/javascript" } });
          }
          // A permissive CORS grant on the UI host must not survive the proxy.
          return new Response(shellHtml(!path.startsWith("/old")), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "access-control-allow-origin": "*",
              "access-control-allow-credentials": "true",
            },
          });
        },
      });
      try {
        const cliPort = await reservedPort();
        const cliEnv = { ...env, APP_URL: `http://127.0.0.1:${uiHost.port}` };
        const cliRun = await runCli(
          [
            "ui-dev",
            "--app",
            appId,
            "--api-url",
            ctx.baseUrl,
            "--port",
            String(cliPort),
            "--as-email",
            email,
            "--json",
          ],
          {
            env: cliEnv,
            timeoutMs: 60_000,
            whileRunning: async ({ stdout }) => {
              const deadline = Date.now() + 30_000;
              while (!stdout().includes("\n") && Date.now() < deadline) await Bun.sleep(100);
              const ready = asRecord(JSON.parse(stdout().trim()));
              const url = new URL(asString(ready.url, "cli ready url"));
              expect(
                url.origin === `http://127.0.0.1:${cliPort}`,
                `cli ready origin: ${url.origin}`,
              );
              expect(url.pathname === `/apps/${appId}`, `cli ready path: ${url.pathname}`);
              expect(ready.userId === userId, `cli ready userId ${String(ready.userId)}`);
              expect(
                !JSON.stringify(ready).includes(ctx.apiKey),
                "the cli ready line carries the key",
              );

              const shellRes = await fetch(url, { headers: { Origin: "https://evil.example" } });
              const shell = await shellRes.text();
              expect(shell.includes('id="root"'), "cli dashboard shell HTML");
              const cors = [...shellRes.headers.keys()].filter((h) =>
                h.startsWith("access-control-"),
              );
              expect(cors.length === 0, `cli shell keeps CORS headers: ${cors.join(", ")}`);
              // DNS rebinding: a foreign Host gets 403 and no key; localhost:<port> is served.
              const rebound = await fetch(url, {
                headers: { Host: `rebind.example:${cliPort}` },
              });
              const reboundBody = await rebound.text();
              expect(rebound.status === 403, `cli foreign Host HTTP ${rebound.status}`);
              expect(!reboundBody.includes(ctx.apiKey), "the 403 body carries the key");
              const local = await fetch(url, { headers: { Host: `localhost:${cliPort}` } });
              expect(local.status === 200, `cli localhost Host HTTP ${local.status}`);
              expect(
                (await local.text()).includes("window.__AGENT_SWARM_UI_CONFIG__="),
                "cli serves localhost:<port>",
              );
              expect(
                shell.includes("window.__AGENT_SWARM_UI_CONFIG__="),
                "cli injects the connection",
              );
              expect(
                shell.includes(userId) && shell.includes('"VITE_AGENT_PREVIEW":"1"'),
                "cli config user and preview",
              );
              expect(
                shell.includes(`"VITE_API_URL":"${url.origin}"`),
                "cli config API is its own origin",
              );
              expect(!shell.includes("plausible"), "cli strips Plausible");

              const asset = await fetch(`${url.origin}/assets/index.js`, {
                headers: { Authorization: `Bearer ${ctx.apiKey}`, Cookie: "page_session_x=1" },
              });
              expect(asset.status === 200, `cli asset HTTP ${asset.status}`);
              expect(
                uiHeaders.every((h) => h === null),
                "the key or cookie reached the UI host",
              );

              const health = await fetch(`${url.origin}/health`);
              expect(health.status === 200, `cli proxied /health HTTP ${health.status}`);
              const body = await fetch(`${url.origin}/p/${pageId}`);
              expect((await body.text()).includes(marker), "cli proxied page body");
            },
          },
        );
        expect(
          cliRun.exitCode === 0,
          `ui-dev exit ${cliRun.exitCode}: ${cliRun.stderr.slice(-800)}`,
        );

        const old = await runCli(
          [
            "ui-dev",
            "--app",
            appId,
            "--api-url",
            ctx.baseUrl,
            "--port",
            String(await reservedPort()),
          ],
          {
            env: { ...cliEnv, APP_URL: `http://127.0.0.1:${uiHost.port}/old` },
          },
        );
        expect(old.exitCode === 2, `ui-dev on an old dashboard: exit ${old.exitCode}`);
        expect(old.stderr.includes("predates ui-dev"), `ui-dev old dashboard: ${old.stderr}`);
      } finally {
        await uiHost.stop(true);
      }
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`);
      await ctx.api("DELETE", `/api/pages/${pageId}`, { agentId: owner });
    }
  },
};
