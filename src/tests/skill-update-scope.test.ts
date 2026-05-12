import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createSkill, getSkillById, initDb } from "../be/db";
import { registerSkillUpdateTool } from "../tools/skills/skill-update";

const TEST_DB_PATH = "./test-skill-update-scope.sqlite";

const LEAD_ID = "aaaa0000-0000-4000-8000-000000000010";
const WORKER_ID = "bbbb0000-0000-4000-8000-000000000020";

type StructuredContent = {
  yourAgentId?: string;
  success: boolean;
  message: string;
  skill?: { id: string; scope: string; ownerAgentId: string | null };
};

async function callSkillUpdate(
  server: McpServer,
  callerAgentId: string | undefined,
  args: Record<string, unknown>,
): Promise<{ structuredContent: StructuredContent }> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools["skill-update"].handler;

  const extra = {
    sessionId: "test-session",
    requestInfo: {
      headers: {
        "x-agent-id": callerAgentId ?? "",
      },
    },
  };

  const result = await handler(args, extra);
  return result as { structuredContent: StructuredContent };
}

describe("skill-update scope promotion", () => {
  let server: McpServer;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }

    closeDb();
    initDb(TEST_DB_PATH);

    createAgent({ id: LEAD_ID, name: "Test Lead", isLead: true, status: "idle" });
    createAgent({ id: WORKER_ID, name: "Test Worker", isLead: false, status: "idle" });

    server = new McpServer({ name: "test-skill-update-scope", version: "1.0.0" });
    registerSkillUpdateTool(server);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // ignore
      }
    }
  });

  test("worker cannot promote their own skill to swarm scope", async () => {
    const skill = createSkill({
      name: "worker-skill-self-promote",
      description: "Worker tries to promote",
      content:
        "---\nname: worker-skill-self-promote\ndescription: Worker tries to promote\n---\n\nBody.",
      type: "personal",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    const result = await callSkillUpdate(server, WORKER_ID, {
      skillId: skill.id,
      scope: "swarm",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("lead");

    const stored = getSkillById(skill.id);
    expect(stored?.scope).toBe("agent");
    expect(stored?.ownerAgentId).toBe(WORKER_ID);
  });

  test("lead can promote a worker's agent-scope skill to swarm without changing ownerAgentId", async () => {
    const skill = createSkill({
      name: "worker-skill-lead-promote",
      description: "Lead promotes",
      content: "---\nname: worker-skill-lead-promote\ndescription: Lead promotes\n---\n\nBody.",
      type: "personal",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    const result = await callSkillUpdate(server, LEAD_ID, {
      skillId: skill.id,
      scope: "swarm",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.skill?.scope).toBe("swarm");
    expect(result.structuredContent.skill?.ownerAgentId).toBe(WORKER_ID);

    const stored = getSkillById(skill.id);
    expect(stored?.scope).toBe("swarm");
    expect(stored?.ownerAgentId).toBe(WORKER_ID);
  });

  test("lead demoting a swarm skill back to agent scope is allowed", async () => {
    const skill = createSkill({
      name: "swarm-skill-demote",
      description: "Demote test",
      content: "---\nname: swarm-skill-demote\ndescription: Demote test\n---\n\nBody.",
      type: "personal",
      scope: "swarm",
      ownerAgentId: WORKER_ID,
    });

    const result = await callSkillUpdate(server, LEAD_ID, {
      skillId: skill.id,
      scope: "agent",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.skill?.scope).toBe("agent");

    const stored = getSkillById(skill.id);
    expect(stored?.scope).toBe("agent");
  });

  test("omitting scope leaves it unchanged", async () => {
    const skill = createSkill({
      name: "scope-untouched",
      description: "No scope change",
      content: "---\nname: scope-untouched\ndescription: No scope change\n---\n\nBody.",
      type: "personal",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    const result = await callSkillUpdate(server, WORKER_ID, {
      skillId: skill.id,
      isEnabled: false,
    });

    expect(result.structuredContent.success).toBe(true);
    const stored = getSkillById(skill.id);
    expect(stored?.scope).toBe("agent");
    expect(stored?.isEnabled).toBe(false);
  });
});
