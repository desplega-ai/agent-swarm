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
 *   3. agent-fs attachment resolution uses the registering agent's explicit
 *      org/drive and credentials
 *   4. missing files and wrong drives both block attachment + task writes
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
  getDbClient,
  getTaskAttachments,
  getTaskById,
  initDb,
  startTask,
  upsertSwarmConfig,
} from "../be/db";
import { registerStoreProgressTool } from "../tools/store-progress";

const TEST_DB_PATH = "./test-store-progress-attachments-handler.sqlite";
const ORIGINAL_FETCH = globalThis.fetch;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StoreProgressResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: {
    success: boolean;
    message: string;
    task?: {
      id: string;
      status: string;
      finishedAt?: string;
    };
    wasNoOp?: boolean;
    wasForcedOverwrite?: boolean;
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
  let requestedAgentFsUrls: string[] = [];

  async function configureAgentFsTransport() {
    await upsertSwarmConfig({
      scope: "global",
      key: "AGENT_FS_API_URL",
      value: "https://agent-fs.test",
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "AGENT_FS_API_KEY",
      value: "caller-agent-key",
      isSecret: true,
    });
  }

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    const agent = await createAgent({
      name: "Handler Attachments Worker",
      description: "Agent for handler-level attachment tests",
      role: "worker",
      isLead: false,
      status: "busy",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;
    await configureAgentFsTransport();
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requestedAgentFsUrls.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer caller-agent-key");
      const missing = url.includes("genuinely-absent.md") || url.includes("/drives/wrong-drive/");
      return new Response(missing ? "File not found" : "ok", {
        status: missing ? 404 : 200,
        headers: missing ? undefined : { "content-length": "2" },
      });
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
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
    const task = await createTaskExtended("handler in-progress baseline", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);

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
    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("url");
    expect(rows[0].url).toBe("https://example.com/baseline");
  });

  test("inserts attachment row on an ALREADY-COMPLETED task (PR #542 regression)", async () => {
    const task = await createTaskExtended("handler post-completion attachment", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);
    const completed = await completeTask(task.id, "done");
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
    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("url");
    expect(rows[0].name).toBe("post-completion link");
  });

  test("agent-fs attachment with optional orgId + driveId round-trips through the handler", async () => {
    requestedAgentFsUrls = [];
    const task = await createTaskExtended("handler agent-fs with org/drive", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);

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
    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("agent-fs");
    expect(rows[0].path).toBe("/thoughts/doc.md");
    expect(rows[0].orgId).toBe("org-abc");
    expect(rows[0].driveId).toBe("drive-xyz");
    expect(requestedAgentFsUrls).toEqual([
      "https://agent-fs.test/orgs/org-abc/drives/drive-xyz/files/thoughts/doc.md/raw",
    ]);
  });

  test("agent-fs attachment without a resolvable org/drive hard-fails before registration", async () => {
    await getDbClient().run("DELETE FROM swarm_config");
    const task = await createTaskExtended("handler agent-fs without org/drive", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);

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

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("both orgId and driveId must resolve");
    const rows = await getTaskAttachments(task.id);
    expect(rows).toHaveLength(0);
  });

  describe("agent-fs orgId/driveId auto-resolve from swarm config", () => {
    // Per-test cleanup so config rows from one case don't leak into the next.
    async function clearSwarmConfig() {
      await getDbClient().run("DELETE FROM swarm_config");
      await configureAgentFsTransport();
    }

    test("missing orgId/driveId fills in from global swarm config", async () => {
      await clearSwarmConfig();
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });

      const task = await createTaskExtended("handler agent-fs auto-resolve global", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      await startTask(task.id);

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
      const rows = await getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].kind).toBe("agent-fs");
      expect(rows[0].orgId).toBe("global-org");
      expect(rows[0].driveId).toBe("global-drive");
    });

    test("agent-scoped config wins over global (scope precedence)", async () => {
      await clearSwarmConfig();
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agentId,
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "agent-org",
      });
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agentId,
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "agent-drive",
      });

      const task = await createTaskExtended("handler agent-fs auto-resolve agent-scope", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      await startTask(task.id);

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
      const rows = await getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].orgId).toBe("agent-org");
      expect(rows[0].driveId).toBe("agent-drive");
    });

    test("a genuinely absent file hard-fails without registering or completing the task", async () => {
      await clearSwarmConfig();
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "correct-org",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "correct-drive",
      });

      const task = await createTaskExtended("handler agent-fs genuinely absent", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      await startTask(task.id);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "genuinely-absent.md",
              path: "/thoughts/genuinely-absent.md",
            },
          ],
          status: "completed",
          output: "must not land",
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toContain("driveId=correct-drive");
      expect(result.structuredContent.message).toContain("File not found");
      const rows = await getTaskAttachments(task.id);
      expect(rows).toHaveLength(0);
      expect((await getTaskById(task.id))?.status).toBe("in_progress");
    });

    test("per-row IDs always win — config defaults never overwrite explicit values", async () => {
      await clearSwarmConfig();
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });

      const task = await createTaskExtended("handler agent-fs per-row wins", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      await startTask(task.id);

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
      const rows = await getTaskAttachments(task.id);
      expect(rows.length).toBe(1);
      expect(rows[0].orgId).toBe("row-org");
      expect(rows[0].driveId).toBe("row-drive");
    });

    test("a partial explicit scope hard-fails instead of mixing with config defaults", async () => {
      await clearSwarmConfig();
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "global-org",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "global-drive",
      });

      const task = await createTaskExtended("handler agent-fs partial fill", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      await startTask(task.id);

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

      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toContain("both orgId and driveId must resolve");
      const rows = await getTaskAttachments(task.id);
      expect(rows).toHaveLength(0);
    });

    test("an existing path on the wrong explicit drive hard-fails instead of falling back", async () => {
      await clearSwarmConfig();
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_ORG_ID",
        value: "correct-org",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "AGENT_FS_DEFAULT_DRIVE_ID",
        value: "correct-drive",
      });

      const task = await createTaskExtended("handler agent-fs wrong drive", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      await startTask(task.id);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "exists.md",
              path: "/thoughts/exists.md",
              orgId: "correct-org",
              driveId: "wrong-drive",
            },
          ],
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toContain("driveId=wrong-drive");
      expect(result.structuredContent.message).toContain("File not found");
      expect(result.structuredContent.message).not.toContain("driveId=correct-drive");
      expect(await getTaskAttachments(task.id)).toHaveLength(0);
    });

    test("verifies every attachment with its own scope before inserting the batch", async () => {
      await clearSwarmConfig();
      requestedAgentFsUrls = [];
      const task = await createTaskExtended("handler agent-fs mixed-scope batch", {
        agentId,
        source: "mcp",
        priority: 50,
      });
      await startTask(task.id);

      const tool = buildServer();
      const result = (await tool.handler(
        {
          taskId: task.id,
          attachments: [
            {
              kind: "agent-fs",
              name: "first.md",
              path: "/thoughts/first.md",
              orgId: "correct-org",
              driveId: "correct-drive",
            },
            {
              kind: "agent-fs",
              name: "second.md",
              path: "/thoughts/second.md",
              orgId: "correct-org",
              driveId: "wrong-drive",
            },
          ],
        },
        buildMeta(),
      )) as StoreProgressResult;

      expect(result.structuredContent.success).toBe(false);
      expect(requestedAgentFsUrls).toContain(
        "https://agent-fs.test/orgs/correct-org/drives/correct-drive/files/thoughts/first.md/raw",
      );
      expect(requestedAgentFsUrls).toContain(
        "https://agent-fs.test/orgs/correct-org/drives/wrong-drive/files/thoughts/second.md/raw",
      );
      expect(await getTaskAttachments(task.id)).toHaveLength(0);
    });
  });

  test("status='completed' on a terminal task still no-ops but attachments append", async () => {
    // Lead's other shape: re-issue completion with attachments piggy-backed.
    // The no-op short-circuit must still fire for the status write (no
    // duplicate completion / follow-up), but attachments are append-only and
    // dedup-safe so they land.
    const task = await createTaskExtended("handler retry completion with attachments", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);
    await completeTask(task.id, "first");

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

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("Discarded write");
    expect(result.structuredContent.message).toContain("force: true");
    expect(result.structuredContent.wasNoOp).toBeUndefined();
    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].url).toBe("https://example.com/retry");
  });

  test("successful completion returns a bounded confirmation for an oversized task", async () => {
    const oversizedTaskText = "H".repeat(58_661);
    const task = await createTaskExtended(oversizedTaskText, {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);

    const tool = buildServer();
    const result = (await tool.handler(
      {
        taskId: task.id,
        status: "completed",
        output: "O".repeat(4_023),
      },
      buildMeta(),
    )) as StoreProgressResult;

    const wireChars = JSON.stringify(result).length;
    expect(wireChars).toBeLessThan(1_000);
    expect(result.structuredContent.task).toEqual({
      id: task.id,
      status: "completed",
      finishedAt: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(oversizedTaskText);
  });
});
