/**
 * RBAC permission-audit writer tests (DES-445, Phase 6).
 *
 * Covers the batched writer in src/be/rbac-audit.ts end-to-end against a real
 * migrated DB: buffer + flush persistence (allow AND deny, all columns),
 * the 200-row threshold, the interval flush, the RBAC_AUDIT_DISABLED
 * kill-switch, flush resilience to a throwing DB, retention purge, the
 * shutdown drain, and one migrated MCP gate (inject-learning) exercised
 * through its real handler.
 *
 * Timer hygiene (plan Review Errata): bun test leaks module state
 * process-wide, so EVERY interval started here is stopped in afterEach —
 * dangling timers poison unrelated suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import {
  enqueueAuditRow,
  flushAuditBuffer,
  purgeExpiredAuditRows,
  startAuditGc,
  startAuditWriter,
  stopAuditGc,
  stopAuditWriter,
} from "../be/rbac-audit";
import { can, clearAuditSink, setAuditSink } from "../rbac";
import { registerInjectLearningTool } from "../tools/inject-learning";

const TEST_DB_PATH = "./test-rbac-audit.sqlite";

const LEAD_ID = "aaaa6000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb6000-0000-4000-8000-000000000002";

type AuditRowSelect = {
  principalType: string;
  principalId: string | null;
  originatorUserId: string | null;
  verb: string;
  resourceType: string | null;
  resourceId: string | null;
  decision: string;
  reason: string | null;
  source: string;
};

function selectAuditRows(): Promise<AuditRowSelect[]> {
  return getDbClient().query<AuditRowSelect>(
    `SELECT principalType, principalId, originatorUserId, verb, resourceType, resourceId,
              decision, reason, source
       FROM permission_audit ORDER BY ts, id`,
  );
}

async function countAuditRows(): Promise<number> {
  const row = await getDbClient().get<{ n: number }>("SELECT count(*) AS n FROM permission_audit");
  return row?.n ?? 0;
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

let savedEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  savedEnv = { ...process.env };
  delete process.env.RBAC_AUDIT_DISABLED;
  delete process.env.RBAC_AUDIT_RETENTION_DAYS;

  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);

  await createAgent({ id: LEAD_ID, name: "Audit Lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "Audit Worker", isLead: false, status: "idle" });
});

afterAll(async () => {
  stopAuditWriter();
  stopAuditGc();
  clearAuditSink();
  closeDb();
  await removeDbFiles();

  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  // Drain any leftover buffered rows, then start each test from a clean table.
  await flushAuditBuffer();
  await getDbClient().run("DELETE FROM permission_audit");
  delete process.env.RBAC_AUDIT_DISABLED;
  delete process.env.RBAC_AUDIT_RETENTION_DAYS;
});

afterEach(() => {
  // CRITICAL: never leak intervals across test files (bun test module-state
  // leakage) — stop both timers and detach the sink after every test.
  stopAuditWriter();
  stopAuditGc();
  clearAuditSink();
});

describe("buffer + flush persistence", () => {
  test("persists allow AND deny rows from can() with correct columns", async () => {
    setAuditSink(enqueueAuditRow);

    const allow = can({
      principal: { kind: "agent", agentId: LEAD_ID, isLead: true },
      verb: "memory.learning.inject",
      resource: { kind: "agent", agentId: WORKER_ID },
      source: "mcp",
    });
    const deny = can({
      principal: { kind: "agent", agentId: WORKER_ID, isLead: false },
      verb: "memory.learning.inject",
      resource: { kind: "agent", agentId: LEAD_ID },
      source: "http",
    });
    expect(allow.allow).toBe(true);
    expect(deny.allow).toBe(false);

    // Buffered, not yet written.
    expect(await countAuditRows()).toBe(0);

    await flushAuditBuffer();

    const rows = await selectAuditRows();
    expect(rows.length).toBe(2);

    const allowRow = rows.find((r) => r.decision === "allow");
    expect(allowRow).toMatchObject({
      principalType: "agent",
      principalId: LEAD_ID,
      originatorUserId: null,
      verb: "memory.learning.inject",
      resourceType: "agent",
      resourceId: WORKER_ID,
      decision: "allow",
      reason: null,
      source: "mcp",
    });

    const denyRow = rows.find((r) => r.decision === "deny");
    expect(denyRow).toMatchObject({
      principalType: "agent",
      principalId: WORKER_ID,
      verb: "memory.learning.inject",
      resourceType: "agent",
      resourceId: LEAD_ID,
      decision: "deny",
      source: "http",
    });
    expect(denyRow?.reason).toBeTruthy();
  });

  test("auto-flushes at the 200-row threshold without the interval writer", async () => {
    for (let i = 0; i < 200; i++) {
      enqueueAuditRow(
        { principal: { kind: "operator" }, verb: "user.manage", source: "http" },
        { allow: true },
      );
    }
    // The threshold flush is deferred off the enqueue path (zero-delay
    // timeout) so the 200th can() call never blocks on the transaction —
    // nothing is persisted synchronously, everything lands a tick later.
    expect(await countAuditRows()).toBe(0);
    await Bun.sleep(10);
    expect(await countAuditRows()).toBe(200);
  });

  test("interval flush drains the buffer", async () => {
    startAuditWriter(25);
    enqueueAuditRow(
      { principal: { kind: "user", userId: "user-1" }, verb: "user.manage", source: "http" },
      { allow: true },
    );
    expect(await countAuditRows()).toBe(0);

    await Bun.sleep(120);
    expect(await countAuditRows()).toBe(1);
    const row = (await selectAuditRows())[0];
    expect(row).toMatchObject({ principalType: "user", principalId: "user-1" });
  });
});

describe("kill-switch", () => {
  test("RBAC_AUDIT_DISABLED=true writes nothing", async () => {
    process.env.RBAC_AUDIT_DISABLED = "true";
    setAuditSink(enqueueAuditRow);

    can({
      principal: { kind: "agent", agentId: WORKER_ID, isLead: false },
      verb: "memory.learning.inject",
      source: "mcp",
    });
    enqueueAuditRow(
      { principal: { kind: "operator" }, verb: "user.manage", source: "http" },
      { allow: true },
    );
    await flushAuditBuffer();

    expect(await countAuditRows()).toBe(0);
  });
});

describe("flush resilience", () => {
  test("throwing DB during flush does not propagate (batch dropped)", async () => {
    enqueueAuditRow(
      { principal: { kind: "operator" }, verb: "user.manage", source: "http" },
      { allow: true },
    );

    await getDbClient().run("ALTER TABLE permission_audit RENAME TO permission_audit_broken");
    try {
      await expect(flushAuditBuffer()).resolves.toBeUndefined();
    } finally {
      await getDbClient().run("ALTER TABLE permission_audit_broken RENAME TO permission_audit");
    }

    // Batch was dropped, not retried.
    expect(await countAuditRows()).toBe(0);
    await flushAuditBuffer();
    expect(await countAuditRows()).toBe(0);
  });
});

describe("retention purge", () => {
  const insertAuditRow = (offset: string) =>
    getDbClient().run(
      `INSERT INTO permission_audit (ts, principalType, verb, decision, source)
       VALUES (datetime('now', ?), 'agent', 'user.manage', 'deny', 'mcp')`,
      [offset],
    );

  test("deletes only rows older than the cutoff (default 30 days)", async () => {
    await insertAuditRow("-40 days");
    await insertAuditRow("-29 days");
    await insertAuditRow("-0 seconds");
    expect(await countAuditRows()).toBe(3);

    const purged = await purgeExpiredAuditRows();
    expect(purged).toBe(1);
    expect(await countAuditRows()).toBe(2);
  });

  test("respects RBAC_AUDIT_RETENTION_DAYS override and runs via startAuditGc", async () => {
    process.env.RBAC_AUDIT_RETENTION_DAYS = "7";
    await insertAuditRow("-10 days");
    await insertAuditRow("-1 days");

    // startAuditGc purges immediately on start (pattern: startMemoryGc).
    await startAuditGc();
    expect(await countAuditRows()).toBe(1);
    stopAuditGc();
  });
});

describe("shutdown flush", () => {
  test("final flushAuditBuffer() drains everything below the thresholds", async () => {
    enqueueAuditRow(
      {
        principal: { kind: "agent", agentId: WORKER_ID, isLead: false },
        verb: "user.manage",
        source: "mcp",
      },
      { allow: false, reason: "requires lead agent", missing: "user.manage" },
    );
    enqueueAuditRow(
      { principal: { kind: "operator" }, verb: "user.manage", source: "http" },
      { allow: true },
    );
    expect(await countAuditRows()).toBe(0);

    // Shutdown path: stop the timer first, then drain.
    stopAuditWriter();
    await flushAuditBuffer();
    expect(await countAuditRows()).toBe(2);

    // Buffer is empty afterwards — a second drain writes nothing.
    await flushAuditBuffer();
    expect(await countAuditRows()).toBe(2);
  });
});

describe("migrated gate end-to-end (inject-learning)", () => {
  type ToolResult = {
    content: Array<{ type: string; text: string }>;
    structuredContent: { success: boolean; message: string };
  };

  test("worker call → soft denial → flush → deny audit row with expected verb", async () => {
    setAuditSink(enqueueAuditRow);

    const server = new McpServer({ name: "test-rbac-audit", version: "1.0.0" });
    registerInjectLearningTool(server);
    const tools = (
      server as unknown as {
        // biome-ignore lint/complexity/noBannedTypes: internal MCP SDK type, test-only
        _registeredTools: Record<string, { handler: Function }>;
      }
    )._registeredTools;
    const handler = tools["inject-learning"]?.handler;
    expect(handler).toBeDefined();

    const result = (await handler?.(
      { agentId: LEAD_ID, learning: "audit e2e learning", category: "best-practice" },
      {
        sessionId: "test-session",
        requestInfo: { headers: { "x-agent-id": WORKER_ID } },
      },
    )) as ToolResult;
    expect(result.structuredContent.success).toBe(false);

    await flushAuditBuffer();

    const rows = await selectAuditRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      principalType: "agent",
      principalId: WORKER_ID,
      verb: "memory.learning.inject",
      decision: "deny",
      source: "mcp",
    });
    expect(rows[0]?.reason).toBeTruthy();
  });
});
