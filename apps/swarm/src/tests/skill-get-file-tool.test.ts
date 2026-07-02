import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createSkill, initDb, upsertSkillFile } from "../be/db";
import { registerSkillGetFileTool } from "../tools/skills/skill-get-file";

const TEST_DB_PATH = `./test-skill-get-file-tool-${process.pid}.sqlite`;
const CALLER_AGENT_ID = "bbbb0000-0000-4000-8000-000000000020";

type StructuredContent = {
  yourAgentId?: string;
  success: boolean;
  message: string;
  file?: { skillId: string; path: string; content: string };
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function callSkillGetFile(
  server: McpServer,
  args: Record<string, unknown>,
): Promise<{
  structuredContent: StructuredContent;
  content: Array<{ type: string; text: string }>;
}> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools["skill-get-file"].handler;

  const result = await handler(args, {
    sessionId: "test-session",
    requestInfo: {
      headers: {
        "x-agent-id": CALLER_AGENT_ID,
      },
    },
  });
  return result as {
    structuredContent: StructuredContent;
    content: Array<{ type: string; text: string }>;
  };
}

describe("skill-get-file tool", () => {
  let server: McpServer;
  let skillId: string;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);

    server = new McpServer({ name: "skill-get-file-test", version: "1.0.0" });
    registerSkillGetFileTool(server);

    const skill = createSkill({
      name: "tool-file-skill",
      description: "Tool file skill",
      content: "---\nname: tool-file-skill\ndescription: Tool file skill\n---\n\nBody.",
      type: "personal",
      scope: "agent",
      isComplex: true,
    });
    skillId = skill.id;
    upsertSkillFile(skill.id, {
      path: "references/guide.md",
      content: "# Guide",
      mimeType: "text/markdown",
    });
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("fetches a bundled skill file by skillId and path", async () => {
    const result = await callSkillGetFile(server, {
      skillId,
      path: "references/guide.md",
    });

    expect(result.structuredContent).toMatchObject({
      yourAgentId: CALLER_AGENT_ID,
      success: true,
      file: {
        skillId,
        path: "references/guide.md",
        content: "# Guide",
      },
    });
    expect(result.content[0].text).toContain("# Guide");
  });

  test("returns structured failure for missing file", async () => {
    const result = await callSkillGetFile(server, {
      skillId,
      path: "references/missing.md",
    });

    expect(result.structuredContent).toMatchObject({
      success: false,
      message: "Skill file not found.",
    });
  });
});
