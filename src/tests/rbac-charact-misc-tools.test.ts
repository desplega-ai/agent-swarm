/**
 * RBAC characterization tests — misc MCP tool gates (DES-445, Phase 1).
 *
 * Pins TODAY'S exact authorization behavior (soft-failure shape + message
 * strings) at the inline `isLead` gates in cancel-task (lead-or-creator,
 * previously zero-coverage), inject-learning, context-history, context-diff,
 * memory-delete, credential-bindings, script-connections, and the kv-delete /
 * kv-incr namespace guards, so the Phase-4 migration to `can()` can prove
 * behavior parity. MUST pass both before and after the refactor.
 *
 * Already-covered gates NOT duplicated here: kv-set (kv-tool.test.ts:178),
 * update-profile (update-profile-auth.test.ts), manage-user
 * (mcp-tools-user.test.ts), set-config (swarm-config-reserved-keys.test.ts),
 * skill-update/promote (skill-update-scope.test.ts), assertOwnsTask family
 * (task-tools-ownership.test.ts).
 *
 * Pattern: src/tests/update-profile-auth.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createContextVersion,
  createTaskExtended,
  getDb,
  getKv,
  getTaskById,
  initDb,
  upsertKv,
} from "../be/db";
import { getMemoryStore } from "../be/memory";
import { registerCancelTaskTool } from "../tools/cancel-task";
import { registerContextDiffTool } from "../tools/context-diff";
import { registerContextHistoryTool } from "../tools/context-history";
import { registerCredentialBindingsTool } from "../tools/credential-bindings";
import { registerInjectLearningTool } from "../tools/inject-learning";
import { registerKvDeleteTool } from "../tools/kv/kv-delete";
import { registerKvIncrTool } from "../tools/kv/kv-incr";
import { registerMemoryDeleteTool } from "../tools/memory-delete";
import { registerScriptConnectionsTool } from "../tools/script-connections";

const TEST_DB_PATH = "./test-rbac-charact-misc-tools.sqlite";

const LEAD_ID = "aaaa3000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb3000-0000-4000-8000-000000000002";
const OTHER_WORKER_ID = "cccc3000-0000-4000-8000-000000000003";

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
let savedOpenAiKey: string | undefined;

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

  // Best-effort: keep inject-learning's embedding side path offline.
  // (embed() is try/caught and best-effort in the handler either way.)
  savedOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  // The SqliteMemoryStore singleton caches `ftsInitialized` process-wide. When
  // an earlier test file constructed it against ITS database, the flag stays
  // true here, and `store.delete()` runs `DELETE FROM memory_fts` against THIS
  // fresh DB without re-checking the schema → "no such table: memory_fts".
  // Create the FTS table (same DDL as SqliteMemoryStore.ensureFtsTable) so the
  // memory-delete characterization below is order-independent under `bun test`.
  getDb().run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED,
      name,
      content,
      tokenize='porter unicode61'
    )
  `);

  createAgent({ id: LEAD_ID, name: "Charact Lead", isLead: true, status: "idle" });
  createAgent({ id: WORKER_ID, name: "Charact Worker", isLead: false, status: "idle" });
  createAgent({ id: OTHER_WORKER_ID, name: "Charact Other Worker", isLead: false, status: "idle" });

  server = new McpServer({ name: "test-rbac-charact-misc-tools", version: "1.0.0" });
  registerCancelTaskTool(server);
  registerInjectLearningTool(server);
  registerContextHistoryTool(server);
  registerContextDiffTool(server);
  registerMemoryDeleteTool(server);
  registerCredentialBindingsTool(server);
  registerScriptConnectionsTool(server);
  registerKvDeleteTool(server);
  registerKvIncrTool(server);
});

afterAll(async () => {
  if (savedOpenAiKey !== undefined) {
    process.env.OPENAI_API_KEY = savedOpenAiKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
  closeDb();
  await removeDbFiles();
});

describe("cancel-task lead-or-creator gate (characterization)", () => {
  // cancel-task.ts:74 — lead OR task creator (previously zero denial coverage)
  test("worker who is neither lead nor creator cannot cancel a task", async () => {
    const task = createTaskExtended("charact cancel deny", {
      agentId: OTHER_WORKER_ID,
      creatorAgentId: LEAD_ID,
    });

    const result = await callTool("cancel-task", WORKER_ID, { taskId: task.id });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Only the lead or task creator can cancel tasks.",
    );
    // DB not mutated
    expect(getTaskById(task.id)?.status).toBe("pending");
  });

  test("lead can cancel any task", async () => {
    const task = createTaskExtended("charact cancel lead allow", {
      agentId: OTHER_WORKER_ID,
      creatorAgentId: OTHER_WORKER_ID,
    });

    const result = await callTool("cancel-task", LEAD_ID, { taskId: task.id });

    expect(result.structuredContent.success).toBe(true);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
  });

  test("task creator (non-lead) can cancel their own task", async () => {
    const task = createTaskExtended("charact cancel creator allow", {
      agentId: OTHER_WORKER_ID,
      creatorAgentId: WORKER_ID,
    });

    const result = await callTool("cancel-task", WORKER_ID, { taskId: task.id });

    expect(result.structuredContent.success).toBe(true);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
  });
});

describe("inject-learning gate (characterization)", () => {
  // inject-learning.ts:48 — lead only
  test("worker cannot inject learnings", async () => {
    const result = await callTool("inject-learning", WORKER_ID, {
      agentId: OTHER_WORKER_ID,
      learning: "workers should not be able to do this",
      category: "best-practice",
    });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Only the lead agent can inject learnings into worker memory.",
    );
  });

  test("lead can inject a learning into a worker's memory", async () => {
    const result = await callTool("inject-learning", LEAD_ID, {
      agentId: WORKER_ID,
      learning: "characterization allow-path learning",
      category: "best-practice",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.memoryId).toBeDefined();
  });
});

describe("context-history / context-diff gates (characterization)", () => {
  // context-history.ts:83 — viewing another agent's history requires lead
  test("worker cannot view another agent's context history", async () => {
    const result = await callTool("context-history", WORKER_ID, { agentId: LEAD_ID });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Permission denied. Only the lead can view other agents' context history.",
    );
  });

  test("worker can view their own context history", async () => {
    const result = await callTool("context-history", WORKER_ID, {});

    expect(result.structuredContent.success).toBe(true);
  });

  test("lead can view another agent's context history", async () => {
    const result = await callTool("context-history", LEAD_ID, { agentId: WORKER_ID });

    expect(result.structuredContent.success).toBe(true);
  });

  // context-diff.ts:95 — diffing another agent's context requires lead
  test("worker cannot diff another agent's context version", async () => {
    const version = createContextVersion({
      agentId: LEAD_ID,
      field: "soulMd",
      content: "# Lead soul v1",
      version: 1,
      changeSource: "self_edit",
      contentHash: "charact-hash-lead-1",
    });

    const result = await callTool("context-diff", WORKER_ID, { versionId: version.id });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Permission denied. Only the lead can diff other agents' context.",
    );
  });

  test("lead can diff another agent's context version", async () => {
    const version = createContextVersion({
      agentId: WORKER_ID,
      field: "soulMd",
      content: "# Worker soul v1",
      version: 1,
      changeSource: "self_edit",
      contentHash: "charact-hash-worker-1",
    });

    const result = await callTool("context-diff", LEAD_ID, { versionId: version.id });

    expect(result.structuredContent.success).toBe(true);
  });
});

describe("memory-delete gate (characterization)", () => {
  // memory-delete.ts:54,56 — owner OR (lead AND scope=swarm)
  test("worker cannot delete another agent's memory", async () => {
    const memory = getMemoryStore().store({
      agentId: LEAD_ID,
      scope: "agent",
      name: "charact lead memory",
      content: "private to lead",
      source: "manual",
    });

    const result = await callTool("memory-delete", WORKER_ID, { memoryId: memory.id });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Permission denied. You can only delete your own memories, or swarm memories if you are the lead.",
    );
    // DB not mutated
    expect(getMemoryStore().peek(memory.id)).not.toBeNull();
  });

  test("owner can delete their own memory", async () => {
    const memory = getMemoryStore().store({
      agentId: WORKER_ID,
      scope: "agent",
      name: "charact worker memory",
      content: "worker's own",
      source: "manual",
    });

    const result = await callTool("memory-delete", WORKER_ID, { memoryId: memory.id });

    expect(result.structuredContent.success).toBe(true);
    expect(getMemoryStore().peek(memory.id)).toBeNull();
  });

  test("lead can delete another agent's swarm-scoped memory", async () => {
    const memory = getMemoryStore().store({
      agentId: WORKER_ID,
      scope: "swarm",
      name: "charact swarm memory",
      content: "swarm-visible",
      source: "manual",
    });

    const result = await callTool("memory-delete", LEAD_ID, { memoryId: memory.id });

    expect(result.structuredContent.success).toBe(true);
    expect(getMemoryStore().peek(memory.id)).toBeNull();
  });

  test("lead cannot delete another agent's agent-scoped memory", async () => {
    // Characterizes the composite rule's other edge: lead + non-swarm scope = deny.
    const memory = getMemoryStore().store({
      agentId: WORKER_ID,
      scope: "agent",
      name: "charact private worker memory",
      content: "private to worker",
      source: "manual",
    });

    const result = await callTool("memory-delete", LEAD_ID, { memoryId: memory.id });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Permission denied. You can only delete your own memories, or swarm memories if you are the lead.",
    );
    expect(getMemoryStore().peek(memory.id)).not.toBeNull();
  });
});

describe("credential-bindings / script-connections gates (characterization)", () => {
  // credential-bindings/tool.ts:60 — lead only
  test("worker cannot manage credential bindings", async () => {
    const result = await callTool("credential-bindings", WORKER_ID, { action: "list" });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Only the lead can manage credential bindings.");
  });

  test("lead can list credential bindings", async () => {
    const result = await callTool("credential-bindings", LEAD_ID, { action: "list" });

    expect(result.structuredContent.success).toBe(true);
  });

  // script-connections/tool.ts:63 — lead only
  test("worker cannot manage script connections", async () => {
    const result = await callTool("script-connections", WORKER_ID, { action: "list" });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Only the lead can manage script connections.");
  });

  test("lead can list script connections", async () => {
    const result = await callTool("script-connections", LEAD_ID, { action: "list" });

    expect(result.structuredContent.success).toBe(true);
  });
});

describe("kv-delete / kv-incr namespace gates (characterization)", () => {
  // kv-delete.ts:17 — cross-agent task:agent:* writes require lead
  // (kv-set's identical guard is covered by kv-tool.test.ts:178)
  test("worker cannot kv-delete in another agent's namespace", async () => {
    const namespace = `task:agent:${OTHER_WORKER_ID}`;
    upsertKv({ namespace, key: "charact-del", value: "keep-me", valueType: "string" });

    const result = await callTool("kv-delete", WORKER_ID, { key: "charact-del", namespace });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "writes to another agent's namespace require lead",
    );
    // DB not mutated
    expect(getKv(namespace, "charact-del")).not.toBeNull();
  });

  test("lead can kv-delete in another agent's namespace", async () => {
    const namespace = `task:agent:${OTHER_WORKER_ID}`;
    upsertKv({ namespace, key: "charact-del-lead", value: "x", valueType: "string" });

    const result = await callTool("kv-delete", LEAD_ID, { key: "charact-del-lead", namespace });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.deleted).toBe(true);
    expect(getKv(namespace, "charact-del-lead")).toBeNull();
  });

  // kv-incr.ts:17 — cross-agent task:agent:* writes require lead
  test("worker cannot kv-incr in another agent's namespace", async () => {
    const namespace = `task:agent:${OTHER_WORKER_ID}`;

    const result = await callTool("kv-incr", WORKER_ID, { key: "charact-incr", namespace });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "writes to another agent's namespace require lead",
    );
    // DB not mutated (entry was never created)
    expect(getKv(namespace, "charact-incr")).toBeNull();
  });

  test("lead can kv-incr in another agent's namespace", async () => {
    const namespace = `task:agent:${OTHER_WORKER_ID}`;

    const result = await callTool("kv-incr", LEAD_ID, { key: "charact-incr-lead", namespace });

    expect(result.structuredContent.success).toBe(true);
    expect(getKv(namespace, "charact-incr-lead")).not.toBeNull();
  });
});
