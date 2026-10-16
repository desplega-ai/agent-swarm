import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createSkill, initDb } from "../be/db";
import { skillsSeeder } from "../be/seed-skills";
import { registerSkillGetTool } from "../tools/skills/skill-get";

const TEST_DB_PATH = "./test-skill-get-name-resolution.sqlite";

const CALLER_ID = "aaaa0000-0000-4000-8000-000000000031";
const OTHER_ID = "bbbb0000-0000-4000-8000-000000000032";
const THIRD_ID = "cccc0000-0000-4000-8000-000000000033";

type StructuredContent = {
  success: boolean;
  message: string;
  skill?: { id: string; ownerAgentId: string | null };
};

async function callSkillGet(
  server: McpServer,
  callerAgentId: string | undefined,
  args: Record<string, unknown>,
): Promise<StructuredContent> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const result = await tools["skill-get"].handler(args, {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId ?? "" } },
  });
  return (result as { structuredContent: StructuredContent }).structuredContent;
}

function swarmSkill(name: string, ownerAgentId: string | null) {
  return createSkill({
    name,
    description: `${name} description`,
    content: `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody.`,
    type: "personal",
    scope: "swarm",
    ownerAgentId: ownerAgentId ?? undefined,
  });
}

describe("skill-get swarm name resolution", () => {
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
    for (const [id, name] of [
      [CALLER_ID, "Caller"],
      [OTHER_ID, "Other"],
      [THIRD_ID, "Third"],
    ] as const) {
      await createAgent({ id, name, isLead: false, status: "idle" });
    }
    server = new McpServer({ name: "test-skill-get-name-resolution", version: "1.0.0" });
    registerSkillGetTool(server);
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

  test("an owned-only swarm skill resolves by name", async () => {
    const owned = await swarmSkill("owned-only-skill", OTHER_ID);

    const withCaller = await callSkillGet(server, CALLER_ID, { name: "owned-only-skill" });
    expect(withCaller.success).toBe(true);
    expect(withCaller.skill?.id).toBe(owned.id);

    const anonymous = await callSkillGet(server, undefined, { name: "owned-only-skill" });
    expect(anonymous.success).toBe(true);
    expect(anonymous.skill?.id).toBe(owned.id);
  });

  test("the ownerless row beats owned rows, including the caller's own", async () => {
    // Live shape: qa-loom has an ownerless row and an agent-owned twin.
    const owned = await swarmSkill("shadowed-skill", CALLER_ID);
    const ownerless = await swarmSkill("shadowed-skill", null);
    expect(owned.createdAt <= ownerless.createdAt).toBe(true);

    const result = await callSkillGet(server, CALLER_ID, { name: "shadowed-skill" });
    expect(result.success).toBe(true);
    expect(result.skill?.id).toBe(ownerless.id);
  });

  test("the caller's own row beats another agent's row", async () => {
    await swarmSkill("two-owner-skill", OTHER_ID);
    const mine = await swarmSkill("two-owner-skill", CALLER_ID);

    const result = await callSkillGet(server, CALLER_ID, { name: "two-owner-skill" });
    expect(result.success).toBe(true);
    expect(result.skill?.id).toBe(mine.id);
  });

  test("two foreign-owned rows return an error naming both ids", async () => {
    const first = await swarmSkill("foreign-pair-skill", OTHER_ID);
    const second = await swarmSkill("foreign-pair-skill", THIRD_ID);

    const result = await callSkillGet(server, CALLER_ID, { name: "foreign-pair-skill" });
    expect(result.success).toBe(false);
    expect(result.message).toContain(first.id);
    expect(result.message).toContain(second.id);
    expect(result.message).toContain("skillId");

    const byId = await callSkillGet(server, CALLER_ID, { skillId: second.id });
    expect(byId.success).toBe(true);
    expect(byId.skill?.id).toBe(second.id);
  });

  test("the seed path still matches ownerless rows only", async () => {
    await swarmSkill("seed-owned-only", OTHER_ID);

    const item = { key: "seed-owned-only", contentHash: "" } as never;
    expect(await skillsSeeder.upstreamHash(item)).toBeNull();

    await swarmSkill("seed-owned-only", null);
    expect(await skillsSeeder.upstreamHash(item)).not.toBeNull();
  });
});
