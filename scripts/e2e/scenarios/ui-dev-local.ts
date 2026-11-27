import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { repoRoot, reservedPort } from "../sut";
import { registerAgent } from "./knowledge-helpers";
import { upsertScript } from "./script-helpers";
import { uiDev } from "./ui-dev-remote";

const APP_FIXTURE = "scripts/ui-dev/fixtures/sample-app.json";
const PAGE_FIXTURE = "scripts/ui-dev/fixtures/sample-page.json";
/** More rows than one list page (1,000): the copy must go through the export route. */
const ROWS = 1_100;

type Ready = Record<string, unknown>;

async function local(ready: Ready) {
  const apiUrl = asString(ready.apiUrl, "local apiUrl");
  const key = (await Bun.file(asString(ready.apiKeyFile, "apiKeyFile")).text()).trim();
  const get = async (path: string) => {
    const res = await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status === 200, `local GET ${path}: HTTP ${res.status}`);
    return asRecord(await res.json());
  };
  return { apiUrl, key, get };
}

async function kvKeys(get: (path: string) => Promise<Record<string, unknown>>, pageId: string) {
  const listed = await get(`/api/kv/_/${encodeURIComponent(`task:page:${pageId}`)}`);
  return asRecords(listed, "entries")
    .map((entry) => `${entry.key}=${JSON.stringify(entry.value)}`)
    .sort();
}

/** Write a page's KV entry the only way the API allows: as the page, through its session. */
async function seedPageKv(ctx: ScenarioContext, pageId: string, userId: string, key: string) {
  const launch = await fetch(`${ctx.baseUrl}/api/pages/${pageId}/launch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.apiKey}`, "X-Swarm-User-Id": userId },
  });
  expect(launch.status === 204, `launch the source page: HTTP ${launch.status}`);
  const cookie = launch.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const put = await fetch(`${ctx.baseUrl}/@swarm/api/kv/${key}`, {
    method: "PUT",
    headers: { Cookie: cookie, "X-Swarm-Page-Id": pageId, "Content-Type": "application/json" },
    body: JSON.stringify({ value: { from: "source", key } }),
  });
  expect(put.status === 200, `seed source page KV ${key}: HTTP ${put.status}`);
}

/**
 * `bun run ui:dev --api local`: a throwaway API with the target copied in. From the committed
 * fixtures (synthetic app and page bundles), then from this SUT standing in for prod: equal app
 * row counts past the list cap, a resolving script action, an identical page body and KV keys,
 * and the password page downgraded to authed with a warning. Usage errors exit 2.
 */
export const uiDevLocal: Scenario = {
  name: "ui-dev-local",
  order: 694.5,
  async run(ctx) {
    const env = { AGENT_SWARM_API_KEY: ctx.apiKey };
    const stateRoot = await mkdtemp(join(tmpdir(), "ui-dev-local-"));
    const owner = await registerAgent(ctx, "ui-dev-local-owner");
    const email = `ui-dev-local-${ctx.nonce}@e2e.invalid`;
    const user = await ctx.api("POST", "/api/users", {
      body: { name: `ui-dev local ${ctx.nonce}`, email, status: "active" },
    });
    expectStatus(user, [200], "create the source dashboard user");
    const userId = asString(asRecord(asRecord(user.json).user).id, "user id");
    const cleanup: [string, string][] = [];
    const scriptName = `e2e-ui-dev-local-${ctx.nonce}`;
    try {
      const run = async (args: string[], held: (ready: Ready) => Promise<void>) => {
        const port = await reservedPort();
        const stateDir = join(stateRoot, String(port));
        let seen = false;
        const result = await uiDev(
          ["--api", "local", ...args, "--port", String(port), "--state-dir", stateDir, "--json"],
          env,
          async (ready) => {
            seen = true;
            expect(ready.mode === "local", `ready mode ${String(ready.mode)}`);
            expect(ready.stateDir === stateDir, `ready stateDir ${String(ready.stateDir)}`);
            expect(!JSON.stringify(ready).includes(ctx.apiKey), "the ready line carries a key");
            const url = new URL(asString(ready.url, "ready url"));
            expect(url.origin === `http://127.0.0.1:${port}`, `ready origin ${url.origin}`);
            expect(ready.apiUrl !== ctx.baseUrl, "local mode proxies to its own API");
            await held(ready);
          },
        );
        expect(
          seen,
          `ui:dev ${args.join(" ")} printed no ready line: ${result.stderr.slice(-800)}`,
        );
        expect(result.code === 0, `ui:dev ${args.join(" ")}: exit ${result.code}`);
        return result;
      };

      // 1. Committed fixtures.
      const appFixture = asRecord(await Bun.file(join(repoRoot, APP_FIXTURE)).json());
      const fixtureAppId = asString(asRecord(appFixture.app).id, "fixture app id");
      let fixtureApi = "";
      await run(["--fixture", APP_FIXTURE], async (ready) => {
        const target = asRecord(ready.target);
        expect(target.kind === "app" && target.id === fixtureAppId, "fixture app target");
        expect(new URL(String(ready.url)).pathname === `/apps/${fixtureAppId}`, "app url path");
        expect(String(ready.source).startsWith("fixture:"), `source ${String(ready.source)}`);
        const api = await local(ready);
        fixtureApi = api.apiUrl;
        const rows = await api.get(`/api/apps/${fixtureAppId}/models/item/rows?limit=1`);
        const want = asRecords(asRecord(appFixture.rows), "item").length;
        expect(rows.total === want, `fixture rows ${String(rows.total)} of ${want}`);
        const action = await fetch(`${api.apiUrl}/api/apps/${fixtureAppId}/actions/ping`, {
          method: "POST",
          headers: { Authorization: `Bearer ${api.key}`, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(action.status === 200, `local action run: HTTP ${action.status}`);
        // The dev server's own origin reaches the local API, not the SUT.
        const proxied = await fetch(new URL(`/api/apps/${fixtureAppId}`, String(ready.url)), {
          headers: { Authorization: `Bearer ${api.key}` },
        });
        expect(proxied.status === 200, `proxied local app HTTP ${proxied.status}`);
      });
      const stopped = await fetch(`${fixtureApi}/health`).then(
        () => false,
        () => true,
      );
      expect(stopped, "the local API stopped with ui:dev");

      const pageFixture = asRecord(await Bun.file(join(repoRoot, PAGE_FIXTURE)).json());
      await run(["--fixture", PAGE_FIXTURE], async (ready) => {
        const target = asRecord(ready.target);
        expect(target.kind === "page" && target.contentType === "text/html", "fixture page");
        const api = await local(ready);
        const page = await api.get(`/api/pages/${asString(target.id, "page id")}`);
        expect(page.body === asRecord(pageFixture.page).body, "fixture page body");
        const keys = await kvKeys(api.get, String(target.id));
        const want = asRecords(pageFixture, "kv")
          .map((entry) => `${entry.key}=${JSON.stringify(entry.value)}`)
          .sort();
        expect(JSON.stringify(keys) === JSON.stringify(want), `fixture KV ${keys.join(", ")}`);
      });

      // 2. This SUT stands in for prod.
      const script = await upsertScript(ctx, owner, {
        name: scriptName,
        scope: "agent",
        description: "ui-dev local fixture",
        intent: "Exercise the local copy",
        source: "export default async function () {\n  return { ok: true };\n}\n",
      });
      const created = await ctx.api("POST", "/api/apps", {
        agentId: owner,
        body: {
          name: `E2E ui-dev local ${ctx.nonce}`,
          definition: {
            models: { item: { columns: { n: { kind: "number" } } } },
            queries: {},
            actions: { go: { kind: "script", scriptId: script.id } },
            pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
            defaultPage: "main",
          },
        },
      });
      expectStatus(created, [201], "create the source app");
      const appId = asString(asRecord(asRecord(created.json).app).id, "source app id");
      cleanup.push(["app", appId]);
      for (let start = 0; start < ROWS; start += 500) {
        const length = Math.min(500, ROWS - start);
        const rows = Array.from({ length }, (_, i) => ({ values: { n: start + i } }));
        const bulk = await ctx.api("POST", `/api/apps/${appId}/models/item/rows/bulk`, {
          body: { rows },
        });
        expectStatus(bulk, [200], "bulk create source rows");
      }
      await run(["--app", appId, "--api-url", ctx.baseUrl, "--as-email", email], async (ready) => {
        expect(asRecord(ready.target).id === appId, "the local app keeps the source id");
        expect(ready.source === ctx.baseUrl, `source ${String(ready.source)}`);
        expect(ready.userEmail === email, `local user ${String(ready.userEmail)}`);
        const api = await local(ready);
        const rows = await api.get(`/api/apps/${appId}/models/item/rows?limit=1`);
        expect(rows.total === ROWS, `local rows ${String(rows.total)} of ${ROWS}`);
        const app = asRecord((await api.get(`/api/apps/${appId}`)).app);
        const action = asRecord(asRecord(asRecord(app.definition).actions).go);
        await api.get(`/api/scripts/${asString(action.scriptId, "local scriptId")}`);
      });

      const slug = `e2e-ui-dev-local-${ctx.nonce}`;
      const body = `<!doctype html><html><body><h1>local ${ctx.nonce}</h1></body></html>`;
      const page = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: {
          slug,
          title: "ui-dev local page",
          contentType: "text/html",
          authMode: "authed",
          body,
        },
      });
      expectStatus(page, [201], "create the source page");
      const pageId = asString(asRecord(page.json).id, "source page id");
      cleanup.push(["page", pageId]);
      for (const key of ["alpha", "beta"]) await seedPageKv(ctx, pageId, userId, key);
      await run(["--page", slug, "--api-url", ctx.baseUrl, "--as-email", email], async (ready) => {
        const target = asRecord(ready.target);
        expect(target.authMode === "authed", `local authMode ${String(target.authMode)}`);
        const api = await local(ready);
        const localId = asString(target.id, "local page id");
        const copy = await api.get(`/api/pages/${localId}`);
        expect(copy.body === body && copy.slug === slug, "the page body and slug are copied");
        const source = await ctx.api(
          "GET",
          `/api/kv/_/${encodeURIComponent(`task:page:${pageId}`)}`,
        );
        const want = asRecords(asRecord(source.json), "entries")
          .map((entry) => `${entry.key}=${JSON.stringify(entry.value)}`)
          .sort();
        const keys = await kvKeys(api.get, localId);
        expect(
          want.length === 2 && JSON.stringify(keys) === JSON.stringify(want),
          `local KV ${keys.join(", ")} vs source ${want.join(", ")}`,
        );
      });

      const locked = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: {
          title: "ui-dev local password page",
          contentType: "text/html",
          authMode: "password",
          password: `pw-${ctx.nonce}`,
          body,
        },
      });
      expectStatus(locked, [201], "create the password page");
      const lockedId = asString(asRecord(locked.json).id, "password page id");
      cleanup.push(["page", lockedId]);
      await run(["--page", lockedId, "--api-url", ctx.baseUrl], async (ready) => {
        expect(asRecord(ready.target).authMode === "authed", "a password page copies as authed");
        const warnings = (ready.warnings as unknown[]).map(String);
        expect(
          warnings.some((w) => w.includes("password")),
          `password warning: ${JSON.stringify(warnings)}`,
        );
      });

      // 3. Usage errors exit 2 before any API boots.
      const usage: [string[], string][] = [
        [
          ["--api", "local", "--fixture", APP_FIXTURE, "--app", appId],
          "--fixture names the target",
        ],
        [["--api", "staging", "--app", appId], "--api must be prod or local"],
        [["--fixture", APP_FIXTURE], "need --api local"],
        [
          ["--api", "local", "--fixture", "scripts/ui-dev/fixtures/missing.json"],
          "cannot read fixture",
        ],
      ];
      for (const [args, message] of usage) {
        const result = await uiDev(args, env);
        expect(result.code === 2, `ui:dev ${args.join(" ")}: exit ${result.code}`);
        expect(result.stderr.includes(message), `ui:dev ${args.join(" ")}: ${result.stderr}`);
      }
    } finally {
      for (const [kind, id] of cleanup) {
        await ctx.api("DELETE", `/api/${kind}s/${id}`, { agentId: owner });
      }
      await ctx.api("DELETE", `/api/scripts/${encodeURIComponent(scriptName)}?scope=agent`, {
        agentId: owner,
      });
      await rm(stateRoot, { recursive: true, force: true });
    }
  },
};
