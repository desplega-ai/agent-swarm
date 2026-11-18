import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { upsertScript } from "./script-helpers";

type Agent = { id: string; token: string };

async function registerWithToken(
  ctx: ScenarioContext,
  label: string,
  isLead = false,
): Promise<Agent> {
  // "zz-" keeps the lead out of first place in the by-name lead lookup.
  const name = `zz-perm-${label}-${ctx.nonce}`;
  const created = await ctx.api("POST", "/api/agents", {
    body: isLead ? { name, isLead: true } : { name, role: "worker", status: "online" },
  });
  expectStatus(created, [201], `register ${label}`);
  const id = asString(asRecord(created.json).id, `${label} id`);
  const minted = await ctx.api("POST", `/api/agents/${id}/token`, { body: {} });
  expectStatus(minted, [200], `mint ${label} token`);
  return { id, token: asString(asRecord(minted.json).plaintext, `${label} token`) };
}

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: permission check skill\n---\nStep one.`;
}

/**
 * Flow `agent-access-tokens`: an agent-bound token must hold the route's permission on
 * swarm-wide admin routes (heartbeat, MCP OAuth, MCP servers, repos, script endpoints,
 * skills, trackers). The shared key with an X-Agent-ID, and the lead's own token, still pass.
 */
export const platformAgentTokenPermissions: Scenario = {
  name: "platform-agent-token-permissions",
  order: 691,
  async run(ctx) {
    const worker = await registerWithToken(ctx, "worker");
    const other = await registerWithToken(ctx, "other");
    const lead = await registerWithToken(ctx, "lead", true);
    const asWorker = { apiKey: worker.token };
    const asLead = { apiKey: lead.token };
    const sharedKeyWorker = { agentId: worker.id };
    const cleanups: Array<() => Promise<unknown>> = [];
    try {
      // ── heartbeat ──────────────────────────────────────────────────────────
      for (const path of ["/api/heartbeat/sweep", "/api/heartbeat/checklist"]) {
        expectStatus(await ctx.api("POST", path, asWorker), [403], `${path} with a worker token`);
      }
      expectStatus(
        await ctx.api("POST", "/api/heartbeat/sweep", sharedKeyWorker),
        [200],
        "sweep with the shared key and a worker X-Agent-ID",
      );
      expectStatus(
        await ctx.api("POST", "/api/heartbeat/sweep", asLead),
        [200],
        "sweep with the lead token",
      );

      // ── MCP OAuth management ───────────────────────────────────────────────
      const missing = `perm-missing-${ctx.nonce}`;
      const oauthCalls = [
        ["POST", `/api/mcp-oauth/${missing}/refresh`, {}],
        ["DELETE", `/api/mcp-oauth/${missing}`, undefined],
        ["POST", `/api/mcp-oauth/${missing}/manual-client`, { clientId: "perm-client" }],
      ] as const;
      for (const [method, path, body] of oauthCalls) {
        expectStatus(
          await ctx.api(method, path, { ...asWorker, body }),
          [403],
          `${method} ${path} with a worker token`,
        );
        expectStatus(
          await ctx.api(method, path, { ...sharedKeyWorker, body }),
          [404],
          `${method} ${path} with the shared key reaches the handler`,
        );
      }
      expectStatus(
        await ctx.api("POST", `/api/mcp-oauth/${missing}/refresh`, { ...asLead, body: {} }),
        [404],
        "refresh with the lead token reaches the handler",
      );

      // ── MCP servers: install, uninstall, delete ────────────────────────────
      const createdServer = await ctx.api("POST", "/api/mcp-servers", {
        body: {
          name: `perm-mcp-${ctx.nonce}`,
          transport: "http",
          scope: "swarm",
          url: `https://perm-mcp-${ctx.nonce}.example.com/mcp`,
        },
      });
      expectStatus(createdServer, [201], "create an MCP server");
      const serverId = asString(asRecord(asRecord(createdServer.json).server).id, "server id");
      cleanups.push(() => ctx.api("DELETE", `/api/mcp-servers/${serverId}`));
      const install = `/api/mcp-servers/${serverId}/install`;
      expectStatus(
        await ctx.api("POST", install, { ...asWorker, body: { agentId: other.id } }),
        [403],
        "worker token installs an MCP server for another agent",
      );
      expectStatus(
        await ctx.api("POST", install, { ...asWorker, body: { agentId: worker.id } }),
        [200],
        "worker token installs an MCP server for itself",
      );
      expectStatus(
        await ctx.api("POST", install, { ...sharedKeyWorker, body: { agentId: other.id } }),
        [200],
        "shared key installs an MCP server for another agent",
      );
      expectStatus(
        await ctx.api("DELETE", `${install}/${other.id}`, asWorker),
        [403],
        "worker token uninstalls another agent's MCP server",
      );
      expectStatus(
        await ctx.api("DELETE", `${install}/${worker.id}`, asWorker),
        [200],
        "worker token uninstalls its own MCP server",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/mcp-servers/${serverId}`, asWorker),
        [403],
        "worker token deletes a server it does not own",
      );
      const deletedServer = await ctx.api("DELETE", `/api/mcp-servers/${serverId}`, asLead);
      expectStatus(deletedServer, [200], "lead token deletes the server");
      expect(asRecord(deletedServer.json).success === true, "server delete did not succeed");

      // ── repos ──────────────────────────────────────────────────────────────
      const createdRepo = await ctx.api("POST", "/api/repos", {
        body: {
          url: `https://git.example.invalid/e2e/perm-${ctx.nonce}.git`,
          name: `perm-repo-${ctx.nonce}`,
        },
      });
      expectStatus(createdRepo, [201], "create a repo");
      const repoId = asString(asRecord(createdRepo.json).id, "repo id");
      cleanups.push(() => ctx.api("DELETE", `/api/repos/${repoId}`));
      expectStatus(
        await ctx.api("DELETE", `/api/repos/${repoId}`, asWorker),
        [403],
        "worker token deletes a repo",
      );
      expect(
        ctx.db.get("SELECT id FROM swarm_repos WHERE id = ?", [repoId]),
        "a refused repo delete removed the row",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/repos/${repoId}`, sharedKeyWorker),
        [200],
        "shared key deletes a repo",
      );

      // ── script endpoints ───────────────────────────────────────────────────
      const script = await upsertScript(ctx, worker.id, {
        name: `perm-script-${ctx.nonce}`,
        source: `import { z } from "zod";
export const argsSchema = z.object({});
export default async function (_args: z.infer<typeof argsSchema>, _ctx: any) {
  return { ok: true };
}`,
      });
      const createdEndpoint = await ctx.api("POST", `/api/scripts/${script.id}/apis`, {
        body: { label: "perm" },
      });
      expectStatus(createdEndpoint, [201], "create a script endpoint");
      const endpointPath = `/api/scripts/${script.id}/apis/${asString(
        asRecord(createdEndpoint.json).id,
        "endpoint id",
      )}`;
      for (const [method, path, body] of [
        ["GET", `${endpointPath}/secret`, undefined],
        ["POST", `${endpointPath}/rotate`, undefined],
        ["PATCH", endpointPath, { label: "renamed" }],
        ["DELETE", endpointPath, undefined],
      ] as const) {
        expectStatus(
          await ctx.api(method, path, { ...asWorker, body }),
          [403],
          `${method} ${path} with a worker token`,
        );
      }
      const revealed = await ctx.api("GET", `${endpointPath}/secret`, asLead);
      expectStatus(revealed, [200], "lead token reveals the endpoint token");
      expect(
        typeof asRecord(revealed.json).token === "string",
        "lead reveal returned no endpoint token",
      );
      expectStatus(
        await ctx.api("DELETE", endpointPath, sharedKeyWorker),
        [200],
        "shared key deletes the endpoint",
      );

      // ── skills ─────────────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("POST", "/api/skills", {
          ...asWorker,
          body: { content: skillMarkdown(`perm-swarm-${ctx.nonce}`), scope: "swarm" },
        }),
        [403],
        "worker token creates a swarm skill",
      );
      expectStatus(
        await ctx.api("POST", "/api/skills", {
          ...asWorker,
          body: {
            content: skillMarkdown(`perm-default-${ctx.nonce}`),
            ownerAgentId: worker.id,
            systemDefault: true,
          },
        }),
        [403],
        "worker token creates a system-default skill",
      );
      expectStatus(
        await ctx.api("POST", "/api/skills/install-remote", {
          ...asWorker,
          body: { sourceRepo: "example/skills", isComplex: true },
        }),
        [403],
        "worker token installs a remote skill",
      );
      const ownSkill = await ctx.api("POST", "/api/skills", {
        ...asWorker,
        body: { content: skillMarkdown(`perm-own-${ctx.nonce}`), ownerAgentId: worker.id },
      });
      expectStatus(ownSkill, [201], "worker token creates its own agent skill");
      const ownId = asString(asRecord(asRecord(ownSkill.json).skill).id, "own skill id");
      cleanups.push(() => ctx.api("DELETE", `/api/skills/${ownId}`));
      const otherSkill = await ctx.api("POST", "/api/skills", {
        agentId: other.id,
        body: { content: skillMarkdown(`perm-other-${ctx.nonce}`), ownerAgentId: other.id },
      });
      expectStatus(otherSkill, [201], "shared key creates a skill for another agent");
      const otherId = asString(asRecord(asRecord(otherSkill.json).skill).id, "other skill id");
      cleanups.push(() => ctx.api("DELETE", `/api/skills/${otherId}`));

      expectStatus(
        await ctx.api("PUT", `/api/skills/${ownId}`, { ...asWorker, body: { isEnabled: true } }),
        [200],
        "worker token updates its own skill",
      );
      expectStatus(
        await ctx.api("PUT", `/api/skills/${ownId}`, { ...asWorker, body: { scope: "swarm" } }),
        [403],
        "worker token widens its own skill to swarm scope",
      );
      expectStatus(
        await ctx.api("PUT", `/api/skills/${ownId}/files/notes.md`, {
          ...asWorker,
          body: { content: "own file" },
        }),
        [200],
        "worker token writes a file on its own skill",
      );
      for (const [method, path, body] of [
        ["PUT", `/api/skills/${otherId}`, { isEnabled: false }],
        ["PUT", `/api/skills/${otherId}/files/notes.md`, { content: "not mine" }],
        ["POST", `/api/skills/${otherId}/files`, { files: [{ path: "a.md", content: "a" }] }],
        ["DELETE", `/api/skills/${otherId}/files/notes.md`, undefined],
        ["DELETE", `/api/skills/${otherId}`, undefined],
        ["POST", `/api/skills/${ownId}/install`, { agentId: other.id }],
        ["DELETE", `/api/skills/${otherId}/install/${other.id}`, undefined],
      ] as const) {
        expectStatus(
          await ctx.api(method, path, { ...asWorker, body }),
          [403],
          `${method} ${path} with a worker token`,
        );
      }
      expectStatus(
        await ctx.api("POST", `/api/skills/${otherId}/install`, {
          ...asWorker,
          body: { agentId: worker.id },
        }),
        [200],
        "worker token installs a skill for itself",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/skills/${otherId}/install/${worker.id}`, asWorker),
        [200],
        "worker token uninstalls a skill from itself",
      );
      expectStatus(
        await ctx.api("PUT", `/api/skills/${otherId}`, {
          ...sharedKeyWorker,
          body: { isEnabled: true },
        }),
        [200],
        "shared key updates another agent's skill",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/skills/${otherId}`, asLead),
        [200],
        "lead token deletes another agent's skill",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/skills/${ownId}`, asWorker),
        [200],
        "worker token deletes its own skill",
      );

      // ── trackers (disabled in the suite: the shared key gets the 503 contract) ──
      for (const [method, path, body] of [
        ["DELETE", "/api/trackers/linear/disconnect", undefined],
        ["POST", "/api/trackers/jira/webhook-register", { jqlFilter: "project = PERM" }],
        ["DELETE", "/api/trackers/jira/webhook/4242", undefined],
        ["DELETE", "/api/trackers/jira/disconnect", undefined],
      ] as const) {
        expectStatus(
          await ctx.api(method, path, { ...asWorker, body }),
          [403],
          `${method} ${path} with a worker token`,
        );
        expectStatus(
          await ctx.api(method, path, { ...sharedKeyWorker, body }),
          [503],
          `${method} ${path} with the shared key`,
        );
      }
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
      for (const agent of [worker, other, lead]) {
        await ctx.api("DELETE", `/api/agents/${agent.id}/token`).catch(() => undefined);
        await ctx.api("POST", "/close", { agentId: agent.id, body: {} }).catch(() => undefined);
      }
    }
  },
};
