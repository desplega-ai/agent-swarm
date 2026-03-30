import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getAgentById, getLatestContextVersion, initDb } from "../be/db";
import { registerUpdateProfileTool } from "../tools/update-profile";

const TEST_DB_PATH = "./test-update-profile-auth.sqlite";

const LEAD_ID = "aaaa0000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb0000-0000-4000-8000-000000000002";
const OTHER_WORKER_ID = "cccc0000-0000-4000-8000-000000000003";
const NONEXISTENT_ID = "dddd0000-0000-4000-8000-000000000099";

type StructuredContent = {
  yourAgentId?: string;
  success: boolean;
  message: string;
  agent?: { id: string; role?: string; description?: string };
};

/**
 * Call the update-profile tool handler directly via the MCP server's internal registry.
 * This bypasses the MCP transport layer but exercises the full tool handler logic
 * including authorization checks.
 */
async function callUpdateProfile(
  server: McpServer,
  callerAgentId: string | undefined,
  args: Record<string, unknown>,
): Promise<{ structuredContent: StructuredContent }> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools["update-profile"].handler;

  // The handler receives (args, extra) where extra includes requestInfo headers.
  // createToolRegistrar extracts agentId from extra.requestInfo.headers["x-agent-id"].
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

describe("update-profile authorization", () => {
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
    createAgent({ id: OTHER_WORKER_ID, name: "Other Worker", isLead: false, status: "idle" });

    server = new McpServer({ name: "test-update-profile-auth", version: "1.0.0" });
    registerUpdateProfileTool(server);
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

  // ===================================================================
  // 1. Lead can update another agent's profile (happy path)
  // ===================================================================
  test("lead can update another agent's profile", async () => {
    const result = await callUpdateProfile(server, LEAD_ID, {
      agentId: WORKER_ID,
      role: "Senior Developer",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain(WORKER_ID);
    expect(result.structuredContent.agent?.role).toBe("Senior Developer");

    // Verify DB was updated
    const agent = getAgentById(WORKER_ID);
    expect(agent?.role).toBe("Senior Developer");
  });

  // ===================================================================
  // 2. Non-lead is rejected when providing agentId (targeting another agent)
  // ===================================================================
  test("non-lead is rejected when targeting another agent", async () => {
    const result = await callUpdateProfile(server, WORKER_ID, {
      agentId: OTHER_WORKER_ID,
      role: "Hacked Role",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("Only lead agents");

    // Verify DB was NOT updated
    const agent = getAgentById(OTHER_WORKER_ID);
    expect(agent?.role).not.toBe("Hacked Role");
  });

  // ===================================================================
  // 3. Self-update via explicit agentId (matching own ID) works without lead check
  // ===================================================================
  test("self-update via explicit own agentId works for non-lead", async () => {
    const result = await callUpdateProfile(server, OTHER_WORKER_ID, {
      agentId: OTHER_WORKER_ID,
      description: "I updated myself",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("own");

    // Verify DB was updated
    const agent = getAgentById(OTHER_WORKER_ID);
    expect(agent?.description).toBe("I updated myself");
  });

  // ===================================================================
  // 4. Invalid agentId returns appropriate error
  // ===================================================================
  test("invalid agentId returns error when lead updates non-existent agent", async () => {
    const result = await callUpdateProfile(server, LEAD_ID, {
      agentId: NONEXISTENT_ID,
      role: "Ghost Role",
    });

    // The tool should fail because the target agent doesn't exist in the DB
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("not found");
  });

  // ===================================================================
  // 5. changeSource is correct for remote vs self updates
  // ===================================================================
  test("changeSource is 'lead_coaching' for remote updates", async () => {
    const result = await callUpdateProfile(server, LEAD_ID, {
      agentId: WORKER_ID,
      soulMd: `# SOUL.md — Updated by Lead\n\nYou are a specialized agent in the swarm. Your role is to execute tasks with precision and care. You follow instructions carefully and report progress accurately. You collaborate with other agents effectively.${"x".repeat(50)}`,
    });

    expect(result.structuredContent.success).toBe(true);

    // Verify the context version has the correct changeSource
    const version = getLatestContextVersion(WORKER_ID, "soulMd");
    expect(version).not.toBeNull();
    expect(version!.changeSource).toBe("lead_coaching");
    expect(version!.changedByAgentId).toBe(LEAD_ID);
  });

  test("changeSource is 'self_edit' for self updates", async () => {
    const result = await callUpdateProfile(server, WORKER_ID, {
      soulMd: `# SOUL.md — Updated by Myself\n\nI am a worker agent in the swarm. My role is to implement features, fix bugs, and ship working code. I follow existing codebase conventions and test my changes thoroughly.${"x".repeat(50)}`,
    });

    expect(result.structuredContent.success).toBe(true);

    // Verify the context version has the correct changeSource
    const version = getLatestContextVersion(WORKER_ID, "soulMd");
    expect(version).not.toBeNull();
    expect(version!.changeSource).toBe("self_edit");
    expect(version!.changedByAgentId).toBe(WORKER_ID);
  });

  test("changeSource is 'self_edit' when explicit agentId matches caller", async () => {
    const result = await callUpdateProfile(server, WORKER_ID, {
      agentId: WORKER_ID,
      identityMd: `# IDENTITY.md — Self Update\n\nName: Test Worker\nRole: Implementation Engineer\nExpertise: TypeScript, testing, bug fixes\nWorking style: thorough investigation before coding, test-driven.${"x".repeat(50)}`,
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("own");

    const version = getLatestContextVersion(WORKER_ID, "identityMd");
    expect(version).not.toBeNull();
    expect(version!.changeSource).toBe("self_edit");
  });
});
