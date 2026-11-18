// A plain agent (own `aseph_` token) writes memories only as itself, and cannot create swarm-scope
// skills, change skills it does not own, or install skills for another agent over HTTP. The lead
// and the operator keep access.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, createUser, registerLead, retireAgent } from "./core-helpers";
import { registerWorker } from "./workflow-helpers";

async function token(ctx: ScenarioContext, agentId: string): Promise<string> {
  const response = await ctx.api("POST", `/api/agents/${agentId}/token`, { body: {} });
  expectStatus(response, [200], "mint an agent token");
  return asString(asRecord(response.json).plaintext, "token plaintext");
}

const skillMarkdown = (name: string) => `---\nname: ${name}\ndescription: authz e2e\n---\n\nbody\n`;

export const authzMemorySkills: Scenario = {
  name: "authz-memory-skills",
  order: 365,
  async run(ctx) {
    const a = await registerWorker(ctx, "ms-a");
    const b = await registerWorker(ctx, "ms-b");
    const leadId = await registerLead(ctx, "ms");
    const tokenA = await token(ctx, a);
    const tokenLead = await token(ctx, leadId);
    const asA = (method: string, path: string, body?: Record<string, unknown>) =>
      ctx.api(method, path, { apiKey: tokenA, body });
    const asLead = (method: string, path: string, body?: Record<string, unknown>) =>
      ctx.api(method, path, { apiKey: tokenLead, body });
    const skillIds: string[] = [];

    try {
      // ── Memory: as itself only ────────────────────────────────────────────────────────
      const memoryCount = (name: string) =>
        ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_memory WHERE name = ?", [name])
          ?.n ?? -1;
      const foreign = `authz-mem-foreign-${ctx.nonce}`;
      const own = `authz-mem-own-${ctx.nonce}`;
      expectStatus(
        await asA("POST", "/api/memory/index", {
          agentId: b,
          scope: "agent",
          source: "manual",
          name: foreign,
          content: "planted in another agent's scope",
        }),
        [403],
        "A writes a memory as another agent",
      );
      expect(memoryCount(foreign) === 0, "the denied memory write stored nothing");
      expectStatus(
        await asA("POST", "/api/memory/index", {
          agentId: a,
          scope: "agent",
          source: "manual",
          name: own,
          content: "my own memory",
        }),
        [202],
        "A writes a memory as itself",
      );
      for (const scope of ["agent", "swarm"]) {
        const name = `authz-mem-default-${scope}-${ctx.nonce}`;
        expectStatus(
          await asA("POST", "/api/memory/index", {
            scope,
            source: "manual",
            name,
            content: "a memory with no owner in the request body",
          }),
          [202],
          `A writes ${scope}-scope memory without specifying an agentId`,
        );
        const stored = ctx.db.get<{ agentId: string; scope: string }>(
          "SELECT agentId, scope FROM agent_memory WHERE name = ?",
          [name],
        );
        expect(stored?.agentId === a && stored.scope === scope, "memory is bound to A");
      }
      expectStatus(
        await asLead("POST", "/api/memory/index", {
          agentId: b,
          scope: "agent",
          source: "manual",
          name: `authz-mem-lead-${ctx.nonce}`,
          content: "the lead may write for an agent",
        }),
        [202],
        "the lead writes a memory for another agent",
      );
      await createUser(ctx, "memory-admin"); // Keep an admin when demoting the viewer fixture.
      const viewerId = await createUser(ctx, "memory-viewer");
      expectStatus(
        await ctx.api("PUT", `/api/users/${viewerId}/roles`, { body: { roles: ["viewer"] } }),
        [200],
        "assign a non-admin role with neither memory permission",
      );
      const minted = await ctx.api("POST", `/api/users/${viewerId}/mcp-tokens`, { body: {} });
      expectStatus(minted, [200], "mint a viewer token");
      const deniedName = `authz-mem-viewer-${ctx.nonce}`;
      const denied = await ctx.api("POST", "/api/memory/index", {
        apiKey: asString(asRecord(minted.json).plaintext, "viewer token"),
        body: {
          name: deniedName,
          content: "ordinary memory",
          scope: "agent",
          source: "manual",
          agentId: a,
        },
      });
      expectStatus(denied, [403], "a user without either permission cannot index memory");
      expect(
        asRecord(denied.json).error === "Forbidden: admission: missing permission 'memory.index'",
        "the route denies the viewer at admission",
      );
      expect(memoryCount(deniedName) === 0, "the denied viewer write stored nothing");

      // ── Skills over HTTP ──────────────────────────────────────────────────────────────
      const leadSkillName = `authz-lead-skill-${ctx.nonce}`;
      const created = await asLead("POST", "/api/skills", {
        content: skillMarkdown(leadSkillName),
        scope: "swarm",
        type: "personal",
        ownerAgentId: leadId,
      });
      expectStatus(created, [201], "the lead creates a swarm skill");
      const leadSkillId = asString(asRecord(asRecord(created.json).skill).id, "skill id");
      skillIds.push(leadSkillId);

      expectStatus(
        await asA("POST", "/api/skills", {
          content: skillMarkdown(`authz-a-swarm-${ctx.nonce}`),
          scope: "swarm",
          type: "personal",
          ownerAgentId: a,
        }),
        [403],
        "A creates a swarm-scope skill",
      );
      expectStatus(
        await asA("POST", "/api/skills", {
          content: skillMarkdown(`authz-a-for-b-${ctx.nonce}`),
          scope: "agent",
          type: "personal",
          ownerAgentId: b,
        }),
        [403],
        "A creates a skill owned by another agent",
      );
      const ownCreated = await asA("POST", "/api/skills", {
        content: skillMarkdown(`authz-a-own-${ctx.nonce}`),
        scope: "agent",
        type: "personal",
        ownerAgentId: a,
      });
      expectStatus(ownCreated, [201], "A creates its own agent-scope skill");
      const ownSkillId = asString(asRecord(asRecord(ownCreated.json).skill).id, "own skill id");
      skillIds.push(ownSkillId);

      expectStatus(
        await asA("PUT", `/api/skills/${leadSkillId}`, { isEnabled: false }),
        [403],
        "A updates the lead's skill",
      );
      expectStatus(
        await asA("PUT", `/api/skills/${leadSkillId}/files/notes.md`, { content: "x" }),
        [403],
        "A writes a file into the lead's skill",
      );
      expectStatus(
        await asA("DELETE", `/api/skills/${leadSkillId}`),
        [403],
        "A deletes the lead's skill",
      );
      expectStatus(
        await asA("PUT", `/api/skills/${ownSkillId}`, { scope: "swarm" }),
        [403],
        "A promotes its own skill to swarm scope",
      );
      expectStatus(
        await asA("PUT", `/api/skills/${ownSkillId}`, { scope: "global" }),
        [403],
        "A moves its own skill to global scope",
      );
      expect(
        ctx.db.get<{ systemDefault: number; scope: string }>(
          "SELECT systemDefault, scope FROM skills WHERE id = ?",
          [ownSkillId],
        )?.systemDefault === 0,
        "the denied promotion left the skill unshared",
      );
      // The shared key with X-Agent-ID is the agent, not the operator (flag off).
      const asShared = (method: string, path: string, body?: Record<string, unknown>) =>
        ctx.api(method, path, { agentId: a, body });
      expectStatus(
        await asShared("POST", "/api/skills", {
          content: skillMarkdown(`authz-shared-swarm-${ctx.nonce}`),
          scope: "swarm",
          type: "personal",
          ownerAgentId: a,
        }),
        [403],
        "shared key + X-Agent-ID of a worker creates a swarm skill",
      );
      expectStatus(
        await asShared("PUT", `/api/skills/${leadSkillId}`, { isEnabled: false }),
        [403],
        "shared key + X-Agent-ID of a worker updates the lead's skill",
      );
      expectStatus(
        await asShared("PUT", `/api/skills/${ownSkillId}`, { systemDefault: true }),
        [403],
        "shared key + X-Agent-ID of a worker marks its skill systemDefault",
      );
      // skill-sync-remote over MCP has the same gate as the HTTP route.
      const mcpA = await ctx.connectMcp(a, { apiKey: tokenA });
      try {
        const syncAll = await callTool(mcpA, "skill-sync-remote", {});
        expect(
          syncAll.isError && syncAll.text.includes("Forbidden"),
          `a worker syncs all remote skills over MCP: ${syncAll.text.slice(0, 200)}`,
        );
        const syncLeads = await callTool(mcpA, "skill-sync-remote", { skillId: leadSkillId });
        expect(
          syncLeads.isError && syncLeads.text.includes("Forbidden"),
          `a worker syncs the lead's skill over MCP: ${syncLeads.text.slice(0, 200)}`,
        );
      } finally {
        await mcpA.close();
      }
      expectStatus(
        await asA("POST", "/api/skills/sync-remote", {}),
        [403],
        "a worker syncs all remote skills over HTTP",
      );
      expectStatus(
        await asA("PUT", `/api/skills/${ownSkillId}`, { isEnabled: false }),
        [200],
        "A updates its own skill",
      );
      expectStatus(
        await asA("POST", `/api/skills/${leadSkillId}/install`, { agentId: b }),
        [403],
        "A installs a skill for another agent",
      );
      expectStatus(
        await asA("POST", `/api/skills/${leadSkillId}/install`, { agentId: a }),
        [200],
        "A installs a skill for itself",
      );
      expectStatus(
        await asA("DELETE", `/api/skills/${leadSkillId}/install/${b}`),
        [403],
        "A uninstalls a skill for another agent",
      );
      expect(
        ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skills WHERE id = ?", [leadSkillId])
          ?.n === 1,
        "the denied delete kept the lead's skill",
      );

      // The lead and the operator keep access.
      expectStatus(
        await asLead("PUT", `/api/skills/${ownSkillId}`, { isEnabled: true }),
        [200],
        "the lead updates A's skill",
      );
      const markedDefault = await asLead("PUT", `/api/skills/${ownSkillId}`, {
        systemDefault: true,
      });
      expectStatus(markedDefault, [200], "the lead marks A's skill systemDefault");
      expect(
        asRecord(asRecord(markedDefault.json).skill).systemDefault === true,
        "skill is default",
      );

      for (const changes of [{ scope: "swarm" }, { ownerAgentId: b }, { description: "edited" }]) {
        expectStatus(
          await asA("PUT", `/api/skills/${ownSkillId}`, { ...changes, systemDefault: false }),
          [403],
          `clearing the flag does not allow changing ${Object.keys(changes).join(", ")}`,
        );
      }
      expectStatus(
        await asA("PUT", `/api/skills/${ownSkillId}`, { systemDefault: "false" }),
        [400],
        "systemDefault must be a boolean",
      );
      const flagOmitted = await asA("PUT", `/api/skills/${ownSkillId}`, { isEnabled: false });
      expectStatus(flagOmitted, [200], "A updates its skill without changing systemDefault");
      expect(
        asRecord(asRecord(flagOmitted.json).skill).systemDefault === true,
        "the flag is unchanged",
      );

      const clearedDefault = await asA("PUT", `/api/skills/${ownSkillId}`, {
        systemDefault: false,
      });
      expectStatus(clearedDefault, [200], "A clears systemDefault on its own skill");
      expect(
        asRecord(asRecord(clearedDefault.json).skill).systemDefault === false,
        "the update returns the cleared flag",
      );
      const fetchedSkill = await asA("GET", `/api/skills/${ownSkillId}`);
      expectStatus(fetchedSkill, [200], "A fetches its own skill after clearing the flag");
      expect(asRecord(fetchedSkill.json).systemDefault === false, "the cleared flag persists");
      expectStatus(
        await asA("PUT", `/api/skills/${ownSkillId}`, { systemDefault: true }),
        [403],
        "A cannot mark its own skill systemDefault again",
      );

      const catalog = await asA("GET", "/api/skills");
      expectStatus(catalog, [200], "A lists skills");
      const seeded = asRecords(catalog.json, "skills").find(
        (skill) => skill.systemDefault === true && skill.ownerAgentId === null,
      );
      expect(seeded, "the catalog has an ownerless system default");
      const seededId = asString(seeded.id, "seeded skill id");
      expectStatus(
        await asA("PUT", `/api/skills/${seededId}`, { systemDefault: false }),
        [403],
        "A cannot clear systemDefault on an ownerless skill",
      );
      expectStatus(
        await asLead("POST", `/api/skills/${leadSkillId}/install`, { agentId: b }),
        [200],
        "the lead installs a skill for another agent",
      );
      expectStatus(
        await ctx.api("PUT", `/api/skills/${ownSkillId}`, { body: { isEnabled: true } }),
        [200],
        "the operator updates a skill",
      );
    } finally {
      for (const id of skillIds) await ctx.api("DELETE", `/api/skills/${id}`);
      await retireAgent(ctx, leadId);
    }
  },
};
