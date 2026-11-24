import { join } from "node:path";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";

// biome-ignore lint/suspicious/noExplicitAny: the cases mutate parsed example JSON in place.
type Json = Record<string, any>;

async function skillExample(heading: string): Promise<Json> {
  const doc = await Bun.file(
    join(import.meta.dir, "../../../templates/skills/apps/content.md"),
  ).text();
  const start = doc.indexOf(`### Example: ${heading}`);
  const block = /```json\n([\s\S]*?)\n```/.exec(doc.slice(start));
  expect(start >= 0 && block, `apps skill example "${heading}" not found`);
  return JSON.parse(block![1]!);
}

type Listener = (event: { source: unknown; data: unknown; ports?: MessagePort[] }) => void;

/**
 * Runs the served page SDK in a stub window: no DOM, only what the
 * `window.appContext` block touches (location, parent, message listeners).
 */
function runPageSdk(script: string, search: string, embedded: boolean) {
  const listeners: Listener[] = [];
  const posted: unknown[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const win: Record<string, unknown> = {
    addEventListener: (_type: string, fn: Listener) => listeners.push(fn),
    removeEventListener: (_type: string, fn: Listener) => {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  win.parent = embedded ? parent : win;
  const location = { pathname: "/p/0123", search };
  new Function("window", "location", script)(win, location);
  return {
    win,
    posted,
    deliver: (event: { source: unknown; data: unknown; ports?: MessagePort[] }) => {
      for (const fn of [...listeners]) fn(event);
    },
    parent,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * `window.appContext`: PageFrame's bridge props validate (actions, expose,
 * on.message), and the SDK served on `/p/<id>` exposes `appContext` only inside
 * an app frame, completes the handshake only for its parent, and carries
 * actions and state over the handed-over port.
 */
export const knowledgeAppsAppContext: Scenario = {
  name: "knowledge-apps-app-context",
  order: 556,
  async run(ctx) {
    const example = await skillExample("Page inside an app");
    const created: string[] = [];
    const pages: string[] = [];
    const owner = await registerAgent(ctx, "app-context-owner");
    try {
      const scriptName = `e2e-app-context-${ctx.nonce}`;
      let response = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: owner,
        body: {
          name: scriptName,
          scope: "agent",
          description: "PageFrame action fixture",
          intent: "Return spans for a trace",
          source: "export default async function main() {\n  return { spans: [] };\n}\n",
        },
      });
      expectStatus(response, [200], "upsert the action script");
      response = await ctx.api("GET", "/api/scripts?scope=agent&includeScratch=true");
      expectStatus(response, [200], "list scripts");
      const script = asRecords(response.json, "scripts").find(
        (row) => row.name === scriptName && row.scopeId === owner,
      );
      expect(script, `script ${scriptName} is listed`);
      example.actions.traceDetail.scriptId = asString(script!.id, "script id");

      response = await ctx.api("POST", "/api/apps", {
        body: { name: `E2E app context ${ctx.nonce}`, definition: example },
      });
      expectStatus(response, [201], "the apps skill PageFrame example validates");
      created.push(String(asRecord(asRecord(response.json).app).id));

      const frame = (d: Json) => d.pages.trace.elements.frame;
      const cases: [string, (d: Json) => void, string, RegExp][] = [
        [
          "actions must be declared",
          (d) => frame(d).props.actions.push("nope"),
          "pages.trace.elements.frame.props.actions.1",
          /unknown app action "nope"/,
        ],
        [
          "task actions cannot be called from a page",
          (d) => {
            d.actions.work = { kind: "task", prompt: "do it" };
            frame(d).props.actions = ["work"];
          },
          "pages.trace.elements.frame.props.actions.0",
          /only script actions/,
        ],
        [
          "on.message needs an id",
          (d) => delete frame(d).props.id,
          "pages.trace.elements.frame.props.id",
          /required with on.message/,
        ],
        [
          "exposed state must be declared",
          (d) => frame(d).props.expose.push("/app/nope"),
          "pages.trace.elements.frame.props.expose.1",
          /undeclared app state "nope"/,
        ],
      ];
      for (const [label, mutate, path, message] of cases) {
        const definition = structuredClone(example);
        mutate(definition);
        response = await ctx.api("POST", "/api/apps", {
          body: { name: `E2E app context bad ${ctx.nonce}`, definition },
        });
        expectStatus(response, [400], label);
        const issues = asRecords(response.json, "issues");
        expect(
          issues.some((found) => found.path === path && message.test(String(found.message))),
          `${label}: expected ${path} ${message}, got ${JSON.stringify(issues).slice(0, 400)}`,
        );
      }

      // ── The served SDK ──────────────────────────────────────────────────────
      response = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: {
          slug: `e2e-app-context-${ctx.nonce}`,
          title: `App context ${ctx.nonce}`,
          contentType: "text/html",
          authMode: "public",
          body: "<!doctype html><html><head></head><body>hi</body></html>",
        },
      });
      expectStatus(response, [201], "create the page");
      const pageId = asString(asRecord(response.json).id, "page id");
      pages.push(pageId);
      response = await ctx.api("GET", `/p/${pageId}`, { apiKey: null });
      expectStatus(response, [200], "serve the page");
      const sdk = [...response.text.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1] ?? "")
        .find((text) => text.includes("class SwarmSDK"));
      expect(sdk, "the page SDK is injected");

      // Positive and negative controls: no app marker, or top level, means null.
      expect(
        runPageSdk(sdk!, "", true).win.appContext === null,
        "no __swarm_app: appContext is null",
      );
      expect(
        runPageSdk(sdk!, "?__swarm_app=a1", false).win.appContext === null,
        "a top-level window: appContext is null",
      );

      const page = runPageSdk(sdk!, "?__swarm_app=a1&traceId=t1", true);
      const appContext = page.win.appContext as Json;
      expect(
        appContext && typeof appContext.action === "function",
        "inside an app: appContext is an object",
      );
      expect(
        JSON.stringify(page.posted) === JSON.stringify([{ type: "swarm-app:hello", appId: "a1" }]),
        `the page says hello to its parent: ${JSON.stringify(page.posted)}`,
      );

      // An init from anything but the parent is ignored.
      const stranger = new MessageChannel();
      page.deliver({
        source: {},
        data: { type: "swarm-app:init", snapshot: { route: { page: "x" } } },
        ports: [stranger.port2],
      });
      await tick();
      expect(appContext.route === null, "an init from a non-parent source is ignored");

      const channel = new MessageChannel();
      const requests: Json[] = [];
      channel.port1.onmessage = (event) => {
        const request = event.data as Json;
        requests.push(request);
        if (request.type === "swarm-app:action") {
          channel.port1.postMessage({
            type: "swarm-app:result",
            id: request.id,
            result: { status: "ok", result: { spans: 3 } },
          });
        }
      };
      page.deliver({
        source: page.parent,
        data: {
          type: "swarm-app:init",
          snapshot: {
            app: { id: "a1" },
            route: { page: "trace", params: { traceId: "t1" } },
            params: { traceId: "t1" },
            theme: { mode: "dark", preset: null },
            state: { "/app/window": "1h" },
          },
        },
        ports: [channel.port2],
      });
      await appContext.ready;
      expect(appContext.params.traceId === "t1", "params arrive with the init snapshot");
      expect(appContext.theme.mode === "dark", "theme arrives with the init snapshot");

      const result = await appContext.action("traceDetail", { traceId: "t1" });
      expect(
        result.status === "ok" && result.result.spans === 3,
        `action round trip: ${JSON.stringify(result)}`,
      );

      const seen: unknown[] = [];
      appContext.on("state", (state: unknown) => seen.push(state));
      channel.port1.postMessage({
        type: "swarm-app:update",
        snapshot: {
          ...{ app: { id: "a1" }, route: null, params: {}, theme: null },
          state: { "/app/window": "24h" },
        },
      });
      await tick();
      expect(
        JSON.stringify(seen) === JSON.stringify([{ "/app/window": "24h" }]),
        `a state update fires on("state"): ${JSON.stringify(seen)}`,
      );

      appContext.navigate("span", { spanId: "s1" });
      appContext.emit("open", { spanId: "s1" });
      await tick();
      const kinds = requests.map((request) => request.type);
      expect(
        JSON.stringify(kinds) ===
          JSON.stringify(["swarm-app:action", "swarm-app:navigate", "swarm-app:emit"]),
        `navigate and emit travel on the port: ${JSON.stringify(kinds)}`,
      );
      channel.port1.close();
      stranger.port1.close();
    } finally {
      for (const id of created) await ctx.api("DELETE", `/api/apps/${id}`);
      for (const id of pages) await ctx.api("DELETE", `/api/pages/${id}`, { agentId: owner });
    }
  },
};
