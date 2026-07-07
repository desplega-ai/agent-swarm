/**
 * RBAC characterization tests — skills + mcp-servers MCP tool gates (DES-445, Phase 1).
 *
 * These tests pin TODAY'S exact authorization behavior (soft-failure shape +
 * message strings) at every inline `isLead` gate in src/tools/skills/ and
 * src/tools/mcp-servers/, so the Phase-4 migration to `can()` can prove
 * behavior parity. They MUST pass both before and after the refactor —
 * do not "fix" a message here without flagging the parity break.
 *
 * Pattern: src/tests/update-profile-auth.test.ts (real McpServer +
 * _registeredTools handler extraction; identity via
 * extra.requestInfo.headers["x-agent-id"]).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createMcpServer,
  createSkill,
  getMcpServerById,
  getSkillById,
  initDb,
  installMcpServer,
  installSkill,
} from "../be/db";
import {
  registerMcpServerCreateTool,
  registerMcpServerDeleteTool,
  registerMcpServerInstallTool,
  registerMcpServerUninstallTool,
  registerMcpServerUpdateTool,
} from "../tools/mcp-servers";
import {
  registerSkillCreateTool,
  registerSkillDeleteTool,
  registerSkillInstallRemoteTool,
  registerSkillInstallTool,
  registerSkillUninstallTool,
} from "../tools/skills";

const TEST_DB_PATH = "./test-rbac-charact-skills.sqlite";

const LEAD_ID = "aaaa1000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb1000-0000-4000-8000-000000000002";
const OTHER_WORKER_ID = "cccc1000-0000-4000-8000-000000000003";

type Structured = {
  yourAgentId?: string;
  success: boolean;
  message: string;
  [key: string]: unknown;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: Structured;
};

let server: McpServer;

async function callTool(
  name: string,
  callerAgentId: string | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);

  const extra = {
    sessionId: "test-session",
    requestInfo: {
      headers: {
        "x-agent-id": callerAgentId ?? "",
      },
    },
  };

  return (await handler(args, extra)) as ToolResult;
}

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Characterization test skill ${name}\n---\n\nBody.`;

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File doesn't exist
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);

  createAgent({ id: LEAD_ID, name: "Charact Lead", isLead: true, status: "idle" });
  createAgent({ id: WORKER_ID, name: "Charact Worker", isLead: false, status: "idle" });
  createAgent({ id: OTHER_WORKER_ID, name: "Charact Other Worker", isLead: false, status: "idle" });

  server = new McpServer({ name: "test-rbac-charact-skills", version: "1.0.0" });
  registerSkillCreateTool(server);
  registerSkillInstallTool(server);
  registerSkillInstallRemoteTool(server);
  registerSkillUninstallTool(server);
  registerSkillDeleteTool(server);
  registerMcpServerCreateTool(server);
  registerMcpServerInstallTool(server);
  registerMcpServerUninstallTool(server);
  registerMcpServerDeleteTool(server);
  registerMcpServerUpdateTool(server);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("skill tool gates (characterization)", () => {
  // skill-create.ts:47 — swarm-scope create requires lead
  test("worker cannot create a swarm-scope skill", async () => {
    const result = await callTool("skill-create", WORKER_ID, {
      content: skillMd("charact-swarm-deny"),
      scope: "swarm",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Only lead agents can create swarm-scope skills directly.",
    );
    expect(result.content[0]?.text).toContain('Use "skill-publish"');
  });

  test("lead can create a swarm-scope skill", async () => {
    const result = await callTool("skill-create", LEAD_ID, {
      content: skillMd("charact-swarm-allow"),
      scope: "swarm",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("Created and installed skill");
  });

  // skill-install.ts:40 — cross-agent install requires lead
  test("worker cannot install a skill for another agent", async () => {
    const skill = createSkill({
      name: "charact-install-deny",
      description: "d",
      content: skillMd("charact-install-deny"),
      type: "personal",
      scope: "agent",
      ownerAgentId: LEAD_ID,
    });

    const result = await callTool("skill-install", WORKER_ID, {
      skillId: skill.id,
      agentId: OTHER_WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Permission denied.");
    expect(result.content[0]?.text).toBe("Only leads can install skills for other agents.");
  });

  test("lead can install a skill for another agent", async () => {
    const skill = createSkill({
      name: "charact-install-allow",
      description: "d",
      content: skillMd("charact-install-allow"),
      type: "personal",
      scope: "agent",
      ownerAgentId: LEAD_ID,
    });

    const result = await callTool("skill-install", LEAD_ID, {
      skillId: skill.id,
      agentId: WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("Installed skill");
  });

  // skill-install-remote.ts:46 — remote install requires lead (gate fires before any fetch)
  test("worker cannot install remote skills", async () => {
    const result = await callTool("skill-install-remote", WORKER_ID, {
      sourceRepo: "acme/skills",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Only lead agents can install remote skills.");
  });

  test("lead can install a remote skill (isComplex path, no network fetch)", async () => {
    const result = await callTool("skill-install-remote", LEAD_ID, {
      sourceRepo: "acme/charact-remote-allow",
      isComplex: true,
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("Installed remote skill");
  });

  // skill-uninstall.ts:35 — cross-agent uninstall requires lead
  test("worker cannot uninstall a skill for another agent", async () => {
    const result = await callTool("skill-uninstall", WORKER_ID, {
      skillId: "irrelevant",
      agentId: OTHER_WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Permission denied.");
    expect(result.content[0]?.text).toBe("Only leads can uninstall skills for other agents.");
  });

  test("lead can uninstall a skill for another agent", async () => {
    const skill = createSkill({
      name: "charact-uninstall-allow",
      description: "d",
      content: skillMd("charact-uninstall-allow"),
      type: "personal",
      scope: "agent",
      ownerAgentId: LEAD_ID,
    });
    installSkill(OTHER_WORKER_ID, skill.id);

    const result = await callTool("skill-uninstall", LEAD_ID, {
      skillId: skill.id,
      agentId: OTHER_WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toBe("Skill uninstalled.");
  });

  // skill-delete.ts:46 — delete requires owner OR lead
  test("worker cannot delete a skill they don't own", async () => {
    const skill = createSkill({
      name: "charact-delete-deny",
      description: "d",
      content: skillMd("charact-delete-deny"),
      type: "personal",
      scope: "agent",
      ownerAgentId: LEAD_ID,
    });

    const result = await callTool("skill-delete", WORKER_ID, { skillId: skill.id });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Permission denied.");
    expect(result.content[0]?.text).toBe("Only the owning agent or lead can delete this skill.");
    // DB not mutated
    expect(getSkillById(skill.id)).not.toBeNull();
  });

  test("owner can delete their own skill", async () => {
    const skill = createSkill({
      name: "charact-delete-owner",
      description: "d",
      content: skillMd("charact-delete-owner"),
      type: "personal",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    const result = await callTool("skill-delete", WORKER_ID, { skillId: skill.id });

    expect(result.structuredContent.success).toBe(true);
    expect(getSkillById(skill.id)).toBeNull();
  });

  test("lead can delete another agent's skill", async () => {
    const skill = createSkill({
      name: "charact-delete-lead",
      description: "d",
      content: skillMd("charact-delete-lead"),
      type: "personal",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    const result = await callTool("skill-delete", LEAD_ID, { skillId: skill.id });

    expect(result.structuredContent.success).toBe(true);
    expect(getSkillById(skill.id)).toBeNull();
  });
});

describe("mcp-server tool gates (characterization)", () => {
  // mcp-server-create.ts:88 — swarm/global scope requires lead
  test("worker cannot create a swarm-scope MCP server", async () => {
    const result = await callTool("mcp-server-create", WORKER_ID, {
      name: "charact-mcp-swarm-deny",
      transport: "stdio",
      command: "echo",
      scope: "swarm",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Only lead agents can create swarm-scope MCP servers.",
    );
  });

  test("worker cannot create a global-scope MCP server", async () => {
    const result = await callTool("mcp-server-create", WORKER_ID, {
      name: "charact-mcp-global-deny",
      transport: "stdio",
      command: "echo",
      scope: "global",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Only lead agents can create global-scope MCP servers.",
    );
  });

  test("lead can create a swarm-scope MCP server", async () => {
    const result = await callTool("mcp-server-create", LEAD_ID, {
      name: "charact-mcp-swarm-allow",
      transport: "stdio",
      command: "echo",
      scope: "swarm",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("Created and installed MCP server");
  });

  // mcp-server-install.ts:41 — cross-agent install requires lead
  test("worker cannot install an MCP server for another agent", async () => {
    const result = await callTool("mcp-server-install", WORKER_ID, {
      mcpServerId: "irrelevant",
      agentId: OTHER_WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Permission denied.");
    expect(result.content[0]?.text).toBe("Only leads can install MCP servers for other agents.");
  });

  test("lead can install an MCP server for another agent", async () => {
    const mcpServer = createMcpServer({
      name: "charact-mcp-install-allow",
      transport: "stdio",
      scope: "agent",
      ownerAgentId: LEAD_ID,
      command: "echo",
    });

    const result = await callTool("mcp-server-install", LEAD_ID, {
      mcpServerId: mcpServer.id,
      agentId: WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toContain("Installed MCP server");
  });

  // mcp-server-uninstall.ts:36 — cross-agent uninstall requires lead
  test("worker cannot uninstall an MCP server for another agent", async () => {
    const result = await callTool("mcp-server-uninstall", WORKER_ID, {
      mcpServerId: "irrelevant",
      agentId: OTHER_WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Permission denied.");
    expect(result.content[0]?.text).toBe("Only leads can uninstall MCP servers for other agents.");
  });

  test("lead can uninstall an MCP server for another agent", async () => {
    const mcpServer = createMcpServer({
      name: "charact-mcp-uninstall-allow",
      transport: "stdio",
      scope: "agent",
      ownerAgentId: LEAD_ID,
      command: "echo",
    });
    installMcpServer(OTHER_WORKER_ID, mcpServer.id);

    const result = await callTool("mcp-server-uninstall", LEAD_ID, {
      mcpServerId: mcpServer.id,
      agentId: OTHER_WORKER_ID,
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.message).toBe("MCP server uninstalled.");
  });

  // mcp-server-delete.ts:43 — delete requires owner OR lead
  test("worker cannot delete an MCP server they don't own", async () => {
    const mcpServer = createMcpServer({
      name: "charact-mcp-delete-deny",
      transport: "stdio",
      scope: "agent",
      ownerAgentId: LEAD_ID,
      command: "echo",
    });

    const result = await callTool("mcp-server-delete", WORKER_ID, { id: mcpServer.id });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Permission denied.");
    expect(result.content[0]?.text).toBe(
      "Only the owning agent or lead can delete this MCP server.",
    );
    // DB not mutated
    expect(getMcpServerById(mcpServer.id)).not.toBeNull();
  });

  test("lead can delete another agent's MCP server", async () => {
    const mcpServer = createMcpServer({
      name: "charact-mcp-delete-lead",
      transport: "stdio",
      scope: "agent",
      ownerAgentId: WORKER_ID,
      command: "echo",
    });

    const result = await callTool("mcp-server-delete", LEAD_ID, { id: mcpServer.id });

    expect(result.structuredContent.success).toBe(true);
    expect(getMcpServerById(mcpServer.id)).toBeNull();
  });

  // mcp-server-update.ts:62 — update requires owner OR lead
  test("worker cannot update an MCP server they don't own", async () => {
    const mcpServer = createMcpServer({
      name: "charact-mcp-update-deny",
      transport: "stdio",
      scope: "agent",
      ownerAgentId: LEAD_ID,
      command: "echo",
    });

    const result = await callTool("mcp-server-update", WORKER_ID, {
      id: mcpServer.id,
      name: "hacked-name",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Permission denied.");
    expect(result.content[0]?.text).toBe(
      "Only the owning agent or lead can update this MCP server.",
    );
    // DB not mutated
    expect(getMcpServerById(mcpServer.id)?.name).toBe("charact-mcp-update-deny");
  });

  test("owner can update their own MCP server", async () => {
    const mcpServer = createMcpServer({
      name: "charact-mcp-update-owner",
      transport: "stdio",
      scope: "agent",
      ownerAgentId: WORKER_ID,
      command: "echo",
    });

    const result = await callTool("mcp-server-update", WORKER_ID, {
      id: mcpServer.id,
      description: "updated by owner",
    });

    expect(result.structuredContent.success).toBe(true);
  });

  test("lead can update another agent's MCP server", async () => {
    const mcpServer = createMcpServer({
      name: "charact-mcp-update-lead",
      transport: "stdio",
      scope: "agent",
      ownerAgentId: WORKER_ID,
      command: "echo",
    });

    const result = await callTool("mcp-server-update", LEAD_ID, {
      id: mcpServer.id,
      description: "updated by lead",
    });

    expect(result.structuredContent.success).toBe(true);
  });
});
