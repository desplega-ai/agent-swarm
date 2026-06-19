import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createSkill, initDb, installSkill } from "../be/db";
import { registerSkillTool } from "../tools/skills/skill";

const TEST_DB_PATH = `./test-skill-tool-${process.pid}.sqlite`;
const CALLER_AGENT_ID = "bbbb0000-0000-4000-8000-000000000021";
const OTHER_AGENT_ID = "bbbb0000-0000-4000-8000-000000000022";

type StructuredContent = {
  yourAgentId?: string;
  success: boolean;
  message: string;
  skillName?: string;
  skillId?: string;
  matchedBy?: "exact" | "fuzzy";
  truncated?: boolean;
  originalChars?: number;
  returnedChars?: number;
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function callSkill(
  server: McpServer,
  args: Record<string, unknown>,
  agentId = CALLER_AGENT_ID,
): Promise<{
  structuredContent: StructuredContent;
  content: Array<{ type: string; text: string }>;
}> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools.Skill.handler;

  const result = await handler(args, {
    sessionId: "test-session",
    requestInfo: {
      headers: {
        "x-agent-id": agentId,
      },
    },
  });
  return result as {
    structuredContent: StructuredContent;
    content: Array<{ type: string; text: string }>;
  };
}

describe("Skill tool", () => {
  let server: McpServer;

  beforeEach(async () => {
    delete process.env.MAX_SKILL_CHARS;
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    createAgent({ id: CALLER_AGENT_ID, name: "SkillToolCaller", isLead: false, status: "idle" });
    createAgent({ id: OTHER_AGENT_ID, name: "SkillToolOther", isLead: false, status: "idle" });

    server = new McpServer({ name: "skill-tool-test", version: "1.0.0" });
    registerSkillTool(server);
  });

  afterEach(async () => {
    delete process.env.MAX_SKILL_CHARS;
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("loads an installed skill by normalized exact name", async () => {
    const skill = createSkill({
      name: "work-on-task",
      description: "Task lifecycle",
      content: "# Work on Task\n\nFollow the lifecycle.",
      type: "personal",
      scope: "agent",
      ownerAgentId: CALLER_AGENT_ID,
    });
    installSkill(CALLER_AGENT_ID, skill.id);

    const result = await callSkill(server, { name: "/work_on_task" });

    expect(result.structuredContent).toMatchObject({
      yourAgentId: CALLER_AGENT_ID,
      success: true,
      skillName: "work-on-task",
      skillId: skill.id,
      matchedBy: "exact",
      truncated: false,
    });
    expect(result.content[0].text).toBe(skill.content);
  });

  test("falls back to fuzzy matching within available skills", async () => {
    const skill = createSkill({
      name: "browser-use-cloud",
      description: "Drive a real cloud browser through blocked pages",
      content: "# Browser Use Cloud\n\nUse the browser API.",
      type: "personal",
      scope: "agent",
      ownerAgentId: CALLER_AGENT_ID,
    });
    installSkill(CALLER_AGENT_ID, skill.id);

    const result = await callSkill(server, { name: "blocked pages" });

    expect(result.structuredContent).toMatchObject({
      success: true,
      skillName: "browser-use-cloud",
      matchedBy: "fuzzy",
    });
    expect(result.content[0].text).toBe(skill.content);
  });

  test("does not load another agent's uninstalled personal skill", async () => {
    createSkill({
      name: "private-skill",
      description: "Private to another agent",
      content: "# Private",
      type: "personal",
      scope: "agent",
      ownerAgentId: OTHER_AGENT_ID,
    });

    const result = await callSkill(server, { name: "private-skill" });

    expect(result.structuredContent).toMatchObject({
      success: false,
    });
    expect(result.content[0].text).toContain('Skill "private-skill" not found for this agent.');
  });

  test("truncates loaded content using MAX_SKILL_CHARS", async () => {
    process.env.MAX_SKILL_CHARS = "10";
    const skill = createSkill({
      name: "large-skill",
      description: "Large skill",
      content: "0123456789abcdef",
      type: "personal",
      scope: "agent",
      ownerAgentId: CALLER_AGENT_ID,
    });
    installSkill(CALLER_AGENT_ID, skill.id);

    const result = await callSkill(server, { name: "large-skill" });

    expect(result.content[0].text).toBe("0123456789");
    expect(result.structuredContent).toMatchObject({
      success: true,
      truncated: true,
      originalChars: 16,
      returnedChars: 10,
    });
  });
});
