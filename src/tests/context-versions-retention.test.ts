import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  getContextVersionHistory,
  getDbClient,
  getLatestContextVersion,
  initDb,
  updateAgentProfile,
} from "../be/db";
import {
  DB_RETENTION_TABLES,
  getDbRetentionStats,
  resetDbRetentionForTests,
  runDbRetentionTick,
  sweepStatements,
} from "../be/db-retention";
import { registerContextDiffTool } from "../tools/context-diff";
import { registerContextHistoryTool } from "../tools/context-history";

const TEST_DB_PATH = "./test-context-versions-retention.sqlite";
const KEEP_KEY = "CONTEXT_VERSIONS_KEEP_LATEST";
const AGENT_A = "cccc0000-0000-4000-8000-000000000001";
const AGENT_B = "cccc0000-0000-4000-8000-000000000002";

const CONTEXT_VERSIONS = DB_RETENTION_TABLES.find((table) => table.table === "context_versions");
if (!CONTEXT_VERSIONS) throw new Error("context_versions is not in the retention allowlist");

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
};

let server: McpServer;

async function callTool(
  name: string,
  callerAgentId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  return (await handler(args, {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  })) as ToolResult;
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

/** Write `count` distinct edits through the real profile path, which chains previousVersionId. */
async function edit(
  agentId: string,
  field: "heartbeatMd" | "toolsMd" | "setupScript",
  count: number,
  tag = field,
): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await updateAgentProfile(agentId, { [field]: `${tag} edit ${i}` });
  }
}

async function versionsOf(agentId: string, field: string): Promise<number[]> {
  const rows = await getDbClient().query<{ version: number }>(
    "SELECT version FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version",
    [agentId, field],
  );
  return rows.map((row) => row.version);
}

async function rowFor(agentId: string, field: string, version: number) {
  return getDbClient().get<{ id: string; previousVersionId: string | null }>(
    "SELECT id, previousVersionId FROM context_versions WHERE agentId = ? AND field = ? AND version = ?",
    [agentId, field, version],
  );
}

beforeAll(async () => {
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await createAgent({ id: AGENT_A, name: "Retention A", isLead: true, status: "idle" });
  await createAgent({ id: AGENT_B, name: "Retention B", isLead: false, status: "idle" });
  server = new McpServer({ name: "test-context-versions-retention", version: "1.0.0" });
  registerContextHistoryTool(server);
  registerContextDiffTool(server);
});

afterAll(async () => {
  await resetDbRetentionForTests();
  delete process.env[KEEP_KEY];
  delete process.env.DB_RETENTION_DRY_RUN;
  closeDb();
  await removeDbFiles();
});

beforeEach(async () => {
  await resetDbRetentionForTests();
  delete process.env[KEEP_KEY];
  delete process.env.DB_RETENTION_DRY_RUN;
  await getDbClient().run("DELETE FROM context_versions");
  // The profile path diffs against the agents row, so reset it with the history.
  await getDbClient().run(
    "UPDATE agents SET heartbeatMd = NULL, toolsMd = NULL, setupScript = NULL WHERE id IN (?, ?)",
    [AGENT_A, AGENT_B],
  );
});

describe("context_versions count-based retention", () => {
  test("is opt-in: an unset key deletes nothing", async () => {
    await edit(AGENT_A, "heartbeatMd", 12);

    await runDbRetentionTick();

    expect(await versionsOf(AGENT_A, "heartbeatMd")).toHaveLength(12);
    expect(getDbRetentionStats().contextVersions).toBeUndefined();
  });

  test.each([
    1, 3, 10,
  ])("keeps exactly the newest %i versions of every (agentId, field) and never the age", async (keep) => {
    await edit(AGENT_A, "heartbeatMd", 15);
    await edit(AGENT_A, "toolsMd", 4);
    await edit(AGENT_A, "setupScript", 1); // rarely edited: its only version
    await edit(AGENT_B, "heartbeatMd", 7, "b-heartbeat");
    // Age plays no part: make the lone setupScript version years old.
    await getDbClient().run(
      "UPDATE context_versions SET createdAt = '2020-01-01T00:00:00.000Z' WHERE field = 'setupScript'",
    );
    process.env[KEEP_KEY] = String(keep);

    await runDbRetentionTick();

    const newest = (total: number) =>
      Array.from(
        { length: Math.min(total, keep) },
        (_, i) => total - Math.min(total, keep) + i + 1,
      );
    expect(await versionsOf(AGENT_A, "heartbeatMd")).toEqual(newest(15));
    expect(await versionsOf(AGENT_A, "toolsMd")).toEqual(newest(4));
    expect(await versionsOf(AGENT_A, "setupScript")).toEqual([1]);
    expect(await versionsOf(AGENT_B, "heartbeatMd")).toEqual(newest(7));

    const expectedDeleted = Math.max(0, 15 - keep) + Math.max(0, 4 - keep) + Math.max(0, 7 - keep);
    expect(getDbRetentionStats().contextVersions).toMatchObject({
      rowsDeleted: expectedDeleted,
      backlogRemaining: 0,
      drained: true,
      outcome: "converged",
    });
  });

  test("dry run counts the would-delete rows without deleting", async () => {
    await edit(AGENT_A, "heartbeatMd", 9);
    await edit(AGENT_A, "toolsMd", 2);
    process.env[KEEP_KEY] = "3";
    process.env.DB_RETENTION_DRY_RUN = "true";

    await runDbRetentionTick();

    expect(await versionsOf(AGENT_A, "heartbeatMd")).toHaveLength(9);
    expect(getDbRetentionStats().contextVersions).toMatchObject({
      rowsDeleted: 0,
      backlogRemaining: 6,
      dryRun: true,
    });
  });

  test("drains a backlog larger than one batch, deepest history first, within the batch ceiling", async () => {
    await edit(AGENT_A, "heartbeatMd", 260);
    process.env[KEEP_KEY] = "5";

    for (let tick = 0; tick < 10; tick++) {
      await runDbRetentionTick();
      if (getDbRetentionStats().contextVersions?.drained) break;
    }

    const stats = getDbRetentionStats().contextVersions;
    expect(stats?.drained).toBe(true);
    expect(stats?.cumulativeRowsDeleted).toBe(255);
    expect(stats?.batchSize).toBeLessThanOrEqual(100);
    expect(await versionsOf(AGENT_A, "heartbeatMd")).toEqual([256, 257, 258, 259, 260]);
  });

  test("version numbering continues from the newest survivor after a prune", async () => {
    await edit(AGENT_A, "heartbeatMd", 8);
    process.env[KEEP_KEY] = "2";
    await runDbRetentionTick();

    const latest = await getLatestContextVersion(AGENT_A, "heartbeatMd");
    expect(latest?.version).toBe(8);

    await updateAgentProfile(AGENT_A, { heartbeatMd: "after prune" });

    const next = await getLatestContextVersion(AGENT_A, "heartbeatMd");
    expect(next?.version).toBe(9);
    expect(next?.previousVersionId).toBe(latest?.id ?? "missing");
  });

  test("the oldest survivor's previousVersionId is set to NULL; the rest of the chain is intact", async () => {
    await edit(AGENT_A, "heartbeatMd", 6);
    process.env[KEEP_KEY] = "3";

    await runDbRetentionTick();

    const v4 = await rowFor(AGENT_A, "heartbeatMd", 4);
    const v5 = await rowFor(AGENT_A, "heartbeatMd", 5);
    const v6 = await rowFor(AGENT_A, "heartbeatMd", 6);
    expect(v4?.previousVersionId).toBeNull();
    expect(v5?.previousVersionId).toBe(v4?.id ?? "missing");
    expect(v6?.previousVersionId).toBe(v5?.id ?? "missing");
  });

  test("context-diff reports a pruned predecessor instead of diffing against an empty file", async () => {
    await edit(AGENT_A, "heartbeatMd", 6);
    process.env[KEEP_KEY] = "3";
    await runDbRetentionTick();
    const v4 = await rowFor(AGENT_A, "heartbeatMd", 4);
    const v5 = await rowFor(AGENT_A, "heartbeatMd", 5);
    const v6 = await rowFor(AGENT_A, "heartbeatMd", 6);

    const pruned = await callTool("context-diff", AGENT_A, { versionId: v4?.id });
    expect(pruned.structuredContent.success).toBe(true);
    expect(pruned.structuredContent).toMatchObject({
      field: "heartbeatMd",
      toVersion: 4,
      predecessorPruned: true,
    });
    expect(pruned.structuredContent.diff).toBeUndefined();
    expect(pruned.content[0]?.text).toContain("v3 was removed by context version retention");

    // A survivor whose predecessor survived still diffs normally.
    const intact = await callTool("context-diff", AGENT_A, { versionId: v5?.id });
    expect(intact.structuredContent).toMatchObject({ fromVersion: 4, toVersion: 5 });
    expect(String(intact.structuredContent.diff)).toContain("+heartbeatMd edit 5");

    // An explicit comparison against a surviving version also works.
    const explicit = await callTool("context-diff", AGENT_A, {
      versionId: v6?.id,
      compareToVersionId: v4?.id,
    });
    expect(explicit.structuredContent).toMatchObject({ fromVersion: 4, toVersion: 6 });
    expect(explicit.structuredContent.predecessorPruned).toBeUndefined();
  });

  test("context-diff on a genuine first version still diffs against an empty file", async () => {
    await edit(AGENT_A, "setupScript", 1);
    process.env[KEEP_KEY] = "1";
    await runDbRetentionTick();
    const v1 = await rowFor(AGENT_A, "setupScript", 1);

    const result = await callTool("context-diff", AGENT_A, { versionId: v1?.id });

    expect(result.structuredContent).toMatchObject({ fromVersion: 0, toVersion: 1 });
    expect(result.structuredContent.predecessorPruned).toBeUndefined();
  });

  test("context-history lists only the surviving versions after a prune", async () => {
    await edit(AGENT_A, "toolsMd", 7);
    process.env[KEEP_KEY] = "2";
    await runDbRetentionTick();

    const history = await getContextVersionHistory({ agentId: AGENT_A, field: "toolsMd" });
    expect(history.map((v) => v.version)).toEqual([7, 6]);

    const result = await callTool("context-history", AGENT_A, {
      agentId: AGENT_A,
      field: "toolsMd",
    });
    expect(result.structuredContent.success).toBe(true);
    const versions = result.structuredContent.versions as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toEqual([7, 6]);
  });

  test("the ranking, the delete, and the FK child lookup all use an index", async () => {
    const statements = sweepStatements(CONTEXT_VERSIONS, 100, new Date());
    const client = getDbClient();

    const deletePlan = await client.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${statements.deleteSql}`,
      [...statements.params, 50],
    );
    const deleteDetail = deletePlan.map((row) => row.detail).join("\n");
    expect(deleteDetail).toContain("USING COVERING INDEX idx_cv_agent_field");
    expect(deleteDetail).not.toMatch(/SCAN context_versions(?! USING)/);

    const countPlan = await client.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${statements.backlogSql}`,
      statements.params,
    );
    const countDetail = countPlan.map((row) => row.detail).join("\n");
    expect(countDetail).toContain("USING COVERING INDEX idx_cv_agent_field");
    expect(countDetail).not.toMatch(/SCAN context_versions(?! USING)/);

    // ON DELETE SET NULL makes SQLite look up children of every deleted row by
    // previousVersionId. Without idx_cv_previous_version that is a full scan
    // over every version's content, once per deleted row.
    const fkPlan = await client.query<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT rowid FROM context_versions WHERE previousVersionId = ?",
      ["x"],
    );
    expect(fkPlan.map((row) => row.detail).join("\n")).toContain(
      "USING COVERING INDEX idx_cv_previous_version",
    );
  });
});
