/**
 * Regression coverage for the `store-progress` MCP tool handler — specifically
 * the path that inserts `task_attachments` rows.
 *
 * The Phase 1 + Phase 2a follow-up handler gated the insert behind `!isTerminal`
 * (alongside the no-op short-circuit for status writes), which meant any call
 * to `store-progress(taskId, attachments=[...])` against an already-completed
 * task silently dropped every attachment while still returning `success: true`.
 * The Lead's full smoke battery targets completed parent tasks, so the
 * regression made Phase 1 storage look broken in production.
 *
 * These tests pull the handler straight out of the SDK registry (same pattern
 * as `create-page-tool.test.ts`) and exercise:
 *   1. attachment insert on an in-progress task (smoke baseline)
 *   2. attachment insert on a COMPLETED task — the regression scenario
 *   3. agent-fs attachment with optional `orgId` + `driveId` round-trips
 *   4. agent-fs attachment without `orgId` / `driveId` still inserts (both
 *      shapes mandated by the task brief)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskAttachments,
  initDb,
  startTask,
  upsertSwarmConfig,
} from "../be/db";
import { registerStoreProgressTool } from "../tools/store-progress";

const TEST_DB_PATH = "./test-store-progress-attachments-handler.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StoreProgressResult = {
  structuredContent: {
    success: boolean;
    message: string;
    wasNoOp?: boolean;
    yourAgentId?: string;
  };
};

function buildServer() {
  const server = new McpServer({
    name: "store-progress-handler-test",
    version: "1.0.0",
  });
  registerStoreProgressTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["store-progress"];
  if (!tool) throw new Error("store-progress tool not registered");
  return tool;
}

describe("store-progress handler — attachments insert path", () => {
  let agentId: string;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    const agent = createAgent({
      name: "Handler Attachments Worker",
      description: "Agent for handler-level attachment tests",
      role: "worker",
      isLead: false,
      status: "busy",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  function buildMeta() {
    return {
      sessionId: `session-${crypto.randomUUID()}`,
      requestInfo: { headers: { "x-agent-id": agentId } },
    };
  }

  test("inserts attachment row on an in-progress task (baseline)", async () => {
    const task = createTaskExtended("handler in-progress baseline", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    startTask(task.id, agentId);

    const tool = buildServer();
    const result = (await tool.handler(
      {
        taskId: task.id,
        progress: "smoke",
        attachments: [{ kind: "url", name: "example", url: "https://example.com/baseline" }],
      },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    const rows = getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("url");
    expect(rows[0].url).toBe("https://example.com/baseline");
  });

  test("inserts attachment row on an ALREADY-COMPLETED task (PR #542 regression)", async () => {
    const task = createTaskExtended("handler post-completion attachment", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    startTask(task.id, agentId);
    const completed = completeTask(task.id, "done");
    expect(completed?.status).toBe("completed");

    // Lead's smoke shape: just a minimal URL attachment, no status field, no
    // progress text. Pre-fix this returned `success: true` and inserted zero
    // rows. Post-fix the row is appended in place.
    const tool = buildServer();
    const result = (await tool.handler(
      {
        taskId: task.id,
        attachments: [{ kind: "url", name: "post-completion link", url: "https://example.com/x" }],
      },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    const rows = getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("url");
    expect(rows[0].name).toBe("post-completion link");
  });

  test("agent-fs attachment with optional orgId + driveId round-trips through the handler", async () => {
    const task = createTaskExtended("handler agent-fs with org/drive", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    startTask(task.id, agentId);

    const tool = buildServer();
    const result = (await tool.handler(
      {
        taskId: task.id,
        attachments: [
          {
            kind: "agent-fs",
            name: "doc.md",
            path: "/thoughts/doc.md",
            orgId: "org-abc",
            driveId: "drive-xyz",
            intent: "linkable artifact",
          },
        ],
      },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    const rows = getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("agent-fs");
    expect(rows[0].path).toBe("/thoughts/doc.md");
    expect(rows[0].orgId).toBe("org-abc");
    expect(rows[0].driveId).toBe("drive-xyz");
  });

  test("agent-fs attachment WITHOUT orgId / driveId still inserts (legacy shape)", async () => {
    const task = createTaskExtended("handler agent-fs without org/drive", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    startTask(task.id, agentId);

    const tool = buildServer();
    const result = (await tool.handler(
      {
        taskId: task.id,
        attachments: [
          {
            kind: "agent-fs",
            name: "legacy.md",
            path: "/thoughts/legacy.md",
          },
        ],
      },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    const rows = getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("agent-fs");
    expect(rows[0].path).toBe("/thoughts/legacy.md");
    expect(rows[0].orgId).toBeUndefined();
    expect(rows[0].driveId).toBeUndefined();
  });

  describe("agent-fs orgId/driveId auto-resolve from swarm config", () => {
    // Per-test cleanup so config rows from one case don't leak into the next.
    function clearSwarmConfig() {
      getDb().run("DELETE FROM swarm_config");
    }

    test("missing orgId/driveId fills in from global swarm config", async () => {
      clearSwarmConfig();
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });

      const task = createTaskExtended("handler agent-fs auto-resolve global", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      startTask(task.id, agentId);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "doc.md",
              path: "/thoughts/auto.md",
            },
          ],
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(true);
      const rows = getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].kind).toBe("agent-fs");
      expect(rows[0].orgId).toBe("global-org");
      expect(rows[0].driveId).toBe("global-drive");
    });

    test("agent-scoped config wins over global (scope precedence)", async () => {
      clearSwarmConfig();
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });
      upsertSwarmConfig({
        scope: "agent",
        scopeId: agentId,
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "agent-org",
      });
      upsertSwarmConfig({
        scope: "agent",
        scopeId: agentId,
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "agent-drive",
      });

      const task = createTaskExtended("handler agent-fs auto-resolve agent-scope", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      startTask(task.id, agentId);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "scoped.md",
              path: "/thoughts/scoped.md",
            },
          ],
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(true);
      const rows = getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].orgId).toBe("agent-org");
      expect(rows[0].driveId).toBe("agent-drive");
    });

    test("missing config + missing row IDs leaves null IDs (no throw, renderer falls back)", async () => {
      clearSwarmConfig();

      const task = createTaskExtended("handler agent-fs no config no ids", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      startTask(task.id, agentId);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "no-ids.md",
              path: "/thoughts/no-ids.md",
            },
          ],
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(true);
      const rows = getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].orgId).toBeUndefined();
      expect(rows[0].driveId).toBeUndefined();
    });

    test("per-row IDs always win — config defaults never overwrite explicit values", async () => {
      clearSwarmConfig();
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });

      const task = createTaskExtended("handler agent-fs per-row wins", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      startTask(task.id, agentId);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "explicit.md",
              path: "/thoughts/explicit.md",
              orgId: "row-org",
              driveId: "row-drive",
            },
          ],
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(true);
      const rows = getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].orgId).toBe("row-org");
      expect(rows[0].driveId).toBe("row-drive");
    });

    test("partial row IDs — only the missing one is filled from config", async () => {
      clearSwarmConfig();
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });

      const task = createTaskExtended("handler agent-fs partial fill", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      startTask(task.id, agentId);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "partial.md",
              path: "/thoughts/partial.md",
              orgId: "row-org",
              // driveId omitted on purpose
            },
          ],
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(true);
      const rows = getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].orgId).toBe("row-org");
      expect(rows[0].driveId).toBe("global-drive");
    });
  });

  test("status='completed' on a terminal task still no-ops but attachments append", async () => {
    // Lead's other shape: re-issue completion with attachments piggy-backed.
    // The no-op short-circuit must still fire for the status write (no
    // duplicate completion / follow-up), but attachments are append-only and
    // dedup-safe so they land.
    const task = createTaskExtended("handler retry completion with attachments", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    startTask(task.id, agentId);
    completeTask(task.id, "first");

    const tool = buildServer();
    const result = (await tool.handler(
      {
        taskId: task.id,
        status: "completed",
        output: "second (ignored)",
        attachments: [
          { kind: "url", name: "after first completion", url: "https://example.com/retry" },
        ],
      },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.wasNoOp).toBe(true);
    const rows = getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].url).toBe("https://example.com/retry");
  });
});
