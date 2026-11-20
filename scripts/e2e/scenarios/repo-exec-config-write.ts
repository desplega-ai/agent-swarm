import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import { Cleanup, callTool, expectToolError, expectToolOk, retireAgent } from "./platformb-helpers";

type Agent = { id: string; token: string };

function cookiePair(headers: Headers): string {
  const raw = headers.getSetCookie?.()[0] ?? headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function registerWithToken(
  ctx: ScenarioContext,
  label: string,
  isLead = false,
): Promise<Agent> {
  // "zz-" keeps the lead out of first place in the by-name lead lookup.
  const name = `zz-repo-exec-${label}-${ctx.nonce}`;
  const created = await ctx.api("POST", "/api/agents", {
    body: isLead ? { name, isLead: true } : { name, role: "worker", status: "online" },
  });
  expectStatus(created, [201], `register ${label}`);
  const id = asString(asRecord(created.json).id, `${label} id`);
  const minted = await ctx.api("POST", `/api/agents/${id}/token`, { body: {} });
  expectStatus(minted, [200], `mint ${label} token`);
  return { id, token: asString(asRecord(minted.json).plaintext, `${label} token`) };
}

type RepoRow = { url: string; clonePath: string; hooks: string | null; name: string };

/**
 * A repo's `url`, `clonePath` and `hooks` decide what a worker clones and runs before any model
 * step. A non-lead agent session token may not change them (HTTP and MCP) and may not create a
 * repo with hooks enabled. The lead token, the operator key and a worker on the shared key may.
 * A page session may not change them either. A `url`, `clonePath` or `defaultBranch` that starts
 * with "-" is refused for every caller.
 */
export const repoExecConfigWrite: Scenario = {
  name: "repo-exec-config-write",
  order: 503,
  async run(ctx) {
    const cleanup = new Cleanup();
    const repoIds: string[] = [];
    let worker: Agent | undefined;
    let lead: Agent | undefined;
    let workerConn: McpConnection | undefined;
    let leadConn: McpConnection | undefined;
    cleanup.add("close MCP connections", async () => {
      await workerConn?.close();
      await leadConn?.close();
    });
    cleanup.add("retire agents", async () => {
      for (const agent of [worker, lead]) {
        if (!agent) continue;
        await ctx.api("DELETE", `/api/agents/${agent.id}/token`).catch(() => undefined);
        await retireAgent(ctx, agent.id);
      }
    });
    cleanup.add("delete repos", async () => {
      for (const id of repoIds) await ctx.api("DELETE", `/api/repos/${id}`);
    });

    await cleanup.around(async () => {
      worker = await registerWithToken(ctx, "worker");
      lead = await registerWithToken(ctx, "lead", true);
      const asWorker = { apiKey: worker.token };
      const asLead = { apiKey: lead.token };
      const sharedKeyWorker = { agentId: worker.id };
      const base = `https://git.example.invalid/e2e/repo-exec-${ctx.nonce}`;
      const row = (id: string) =>
        ctx.db.get<RepoRow>(
          sql`SELECT url, "clonePath", hooks, name FROM swarm_repos WHERE id = ${id}`,
        );

      // ── operator create: hooks still default to enabled ────────────────────
      const created = await ctx.api("POST", "/api/repos", {
        body: { url: `${base}/main.git`, name: `repo-exec-main-${ctx.nonce}` },
      });
      expectStatus(created, [201], "operator creates a repo");
      const repoId = asString(asRecord(created.json).id, "repo id");
      repoIds.push(repoId);
      expect(
        asRecord(asRecord(created.json).hooks).enabled === true,
        "operator create no longer defaults hooks to enabled",
      );
      const before = row(repoId);
      expect(before, "created repo row is missing");

      // ── non-lead agent token: url, clonePath and hooks changes are refused ──
      const refusedUpdates = [
        ["url", { url: `${base}/other.git` }],
        ["clonePath", { clonePath: `/workspace/personal/repos/other-${ctx.nonce}` }],
        ["hooks", { hooks: { enabled: false } }],
        ["hooks null", { hooks: null }],
      ] as const;
      for (const [label, body] of refusedUpdates) {
        const refused = await ctx.api("PUT", `/api/repos/${repoId}`, { ...asWorker, body });
        expectStatus(refused, [403], `worker token changes ${label}`);
        expect(
          String(asRecord(refused.json).error).includes("url, clonePath or hooks"),
          `worker token ${label} refusal does not name the fields`,
        );
      }
      expect(
        JSON.stringify(row(repoId)) === JSON.stringify(before),
        "a refused update changed the repo row",
      );

      // ── non-lead agent token: other fields and unchanged resends still pass ─
      const otherFields = await ctx.api("PUT", `/api/repos/${repoId}`, {
        ...asWorker,
        body: {
          url: before!.url,
          clonePath: before!.clonePath,
          hooks: { enabled: true },
          defaultBranch: "develop",
        },
      });
      expectStatus(
        otherFields,
        [200],
        "worker token resends url/clonePath/hooks and edits a field",
      );
      expect(
        asRecord(otherFields.json).defaultBranch === "develop",
        "worker token defaultBranch edit did not land",
      );

      // ── shared key with a worker X-Agent-ID behaves as before ──────────────
      const sharedKey = await ctx.api("PUT", `/api/repos/${repoId}`, {
        ...sharedKeyWorker,
        body: { hooks: { enabled: false }, url: `${base}/shared.git` },
      });
      expectStatus(sharedKey, [200], "shared key worker changes hooks and url");
      expect(row(repoId)?.url === `${base}/shared.git`, "shared key url change did not land");

      // ── lead token changes them ────────────────────────────────────────────
      const leadUpdate = await ctx.api("PUT", `/api/repos/${repoId}`, {
        ...asLead,
        body: { url: `${base}/lead.git`, hooks: { enabled: true } },
      });
      expectStatus(leadUpdate, [200], "lead token changes url and hooks");
      expect(
        asRecord(asRecord(leadUpdate.json).hooks).enabled === true,
        "lead hooks change did not land",
      );

      // ── a leading "-" is refused for every caller ──────────────────────────
      expectStatus(
        await ctx.api("PUT", `/api/repos/${repoId}`, { body: { url: "--upload-pack=x" } }),
        [400],
        "operator sets a url that starts with -",
      );
      expectStatus(
        await ctx.api("PUT", `/api/repos/${repoId}`, { body: { clonePath: "-x" } }),
        [400],
        "operator sets a clonePath that starts with -",
      );
      expectStatus(
        await ctx.api("POST", "/api/repos", {
          body: { url: "-x", name: `repo-exec-dash-${ctx.nonce}` },
        }),
        [400],
        "operator creates a repo with a url that starts with -",
      );
      expectStatus(
        await ctx.api("PUT", `/api/repos/${repoId}`, {
          body: { defaultBranch: "--upload-pack=x" },
        }),
        [400],
        "operator sets a defaultBranch that starts with -",
      );
      expect(row(repoId)?.url === `${base}/lead.git`, "a refused dash url changed the row");

      // ── a page session is refused, even for an operator viewer ─────────────
      const page = await ctx.api("POST", "/api/pages", {
        agentId: worker.id,
        body: {
          slug: `repo-exec-page-${ctx.nonce}`,
          title: "Repo exec page",
          body: "<p>hi</p>",
          contentType: "text/html",
          authMode: "authed",
        },
      });
      expectStatus(page, [201], "worker creates a page");
      const pageId = asString(asRecord(page.json).id, "page id");
      cleanup.add("delete the page", async () => {
        await ctx.api("DELETE", `/api/pages/${pageId}`, { agentId: worker?.id });
      });
      const launch = await ctx.api("POST", `/api/pages/${pageId}/launch`, { agentId: worker.id });
      expectStatus(launch, [204], "launch a page session");
      const pageSession = {
        apiKey: null,
        headers: { Cookie: cookiePair(launch.headers), "X-Swarm-Page-Id": pageId },
      } as const;
      expectStatus(
        await ctx.api("PUT", `/@swarm/api/repos/${repoId}`, {
          ...pageSession,
          body: { url: `${base}/page.git` },
        }),
        [403],
        "page session changes url",
      );
      expect(row(repoId)?.url === `${base}/lead.git`, "a refused page change changed the row");

      // ── non-lead agent token create ────────────────────────────────────────
      const workerCreate = await ctx.api("POST", "/api/repos", {
        ...asWorker,
        body: { url: `${base}/worker.git`, name: `repo-exec-worker-${ctx.nonce}` },
      });
      expectStatus(workerCreate, [201], "worker token creates a repo without hooks");
      const workerRepoId = asString(asRecord(workerCreate.json).id, "worker repo id");
      repoIds.push(workerRepoId);
      expect(
        asRecord(asRecord(workerCreate.json).hooks).enabled === false,
        "worker token create stored hooks enabled",
      );
      expect(
        JSON.parse(row(workerRepoId)?.hooks ?? "{}").enabled === false,
        "worker token create stored hooks enabled in the row",
      );
      const workerHooksCreate = await ctx.api("POST", "/api/repos", {
        ...asWorker,
        body: {
          url: `${base}/worker-hooks.git`,
          name: `repo-exec-worker-hooks-${ctx.nonce}`,
          hooks: { enabled: true },
        },
      });
      expectStatus(workerHooksCreate, [403], "worker token creates a repo with hooks enabled");
      expect(
        !ctx.db.get(
          sql`SELECT id FROM swarm_repos WHERE name = ${`repo-exec-worker-hooks-${ctx.nonce}`}`,
        ),
        "a refused create inserted a row",
      );

      // ── MCP update-repo uses the same rule ─────────────────────────────────
      workerConn = await ctx.connectMcp(worker.id, { apiKey: worker.token });
      leadConn = await ctx.connectMcp(lead.id, { apiKey: lead.token });
      expectToolError(
        await callTool(workerConn, "update-repo", { id: repoId, hooks: { enabled: false } }),
        "url, clonePath or hooks",
        "worker token update-repo changes hooks",
      );
      expectToolOk(
        await callTool(workerConn, "update-repo", { id: repoId, defaultBranch: "main" }),
        "worker token update-repo edits defaultBranch",
      );
      expectToolOk(
        await callTool(leadConn, "update-repo", {
          id: repoId,
          clonePath: `/workspace/personal/repos/lead-${ctx.nonce}`,
        }),
        "lead token update-repo changes clonePath",
      );
      expect(
        row(repoId)?.clonePath === `/workspace/personal/repos/lead-${ctx.nonce}`,
        "lead MCP clonePath change did not land",
      );
      const dashTool = await callTool(leadConn, "update-repo", { id: repoId, url: "-x" });
      expect(dashTool.isError, "update-repo accepted a url that starts with -");
      expect(row(repoId)?.url === `${base}/lead.git`, "MCP dash url changed the row");
    });
  },
};
