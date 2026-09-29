import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createPage,
  createScheduledTask,
  createSessionCost,
  createTaskExtended,
  createWorkflow,
  getAgentById,
  getAllAgents,
  getAllTasks,
  getDbClient,
  getScheduledTasks,
  initDb,
  listAllPages,
  listRecentSessions,
  listWorkflows,
  updateAgentProfile,
} from "../be/db";
import type { Page, Workflow } from "../types";

const TEST_DB_PATH = "./test-list-endpoint-slimming.sqlite";

/**
 * Covers the list-endpoint payload slimming: every list query function returns
 * a slim shape (heavy fields stripped) when `slim: true` is passed, and the
 * full shape otherwise. HTTP routes + MCP tools branch on these flags.
 */
describe("list-endpoint slimming", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("getAllAgents — slim omits identity markdown, full keeps it", async () => {
    const agent = await createAgent({
      id: "slim-agent-1",
      name: "Slim Agent",
      isLead: false,
      status: "idle",
    });
    await updateAgentProfile(agent.id, {
      claudeMd: "C".repeat(500),
      soulMd: "S".repeat(500),
      identityMd: "I".repeat(500),
      toolsMd: "T".repeat(500),
      heartbeatMd: "H".repeat(500),
      setupScript: "echo hi",
      avatar: { type: "lucide", icon: "rocket", color: "#8b5cf6" },
    });

    const slim = (await getAllAgents({ slim: true })).find((a) => a.id === agent.id);
    expect(slim).toBeDefined();
    expect(slim?.claudeMd).toBeUndefined();
    expect(slim?.soulMd).toBeUndefined();
    expect(slim?.identityMd).toBeUndefined();
    expect(slim?.toolsMd).toBeUndefined();
    expect(slim?.heartbeatMd).toBeUndefined();
    expect(slim?.setupScript).toBeUndefined();
    // Scalar fields survive.
    expect(slim?.name).toBe("Slim Agent");
    expect(slim?.status).toBe("idle");
    // avatar is not a heavy markdown blob — must survive in BOTH slim and
    // full, or the agents list would silently show the default avatar while
    // the detail page shows the custom one.
    expect(slim?.avatar).toEqual({ type: "lucide", icon: "rocket", color: "#8b5cf6" });

    const full = (await getAllAgents()).find((a) => a.id === agent.id);
    expect(full?.claudeMd).toBe("C".repeat(500));
    expect(full?.setupScript).toBe("echo hi");
    expect(full?.avatar).toEqual({ type: "lucide", icon: "rocket", color: "#8b5cf6" });
  });

  test("updateAgentProfile — avatar set/reset round-trip", async () => {
    const agent = await createAgent({
      id: "avatar-agent-1",
      name: "Avatar Agent",
      isLead: false,
      status: "idle",
    });

    // No avatar set yet — falls back to the deterministic derivation (null).
    expect((await getAgentById(agent.id))?.avatar).toBeNull();

    // Set a custom avatar.
    await updateAgentProfile(agent.id, {
      avatar: { type: "lucide", icon: "cat", color: "#ff00aa" },
    });
    expect((await getAgentById(agent.id))?.avatar).toEqual({
      type: "lucide",
      icon: "cat",
      color: "#ff00aa",
    });

    // Updating an unrelated field must NOT touch (or clobber) the avatar —
    // the COALESCE(?, col) pattern used for other fields can never write a
    // literal NULL back, so avatar needs its own explicit-set branch that
    // must also correctly no-op when the key is simply absent.
    await updateAgentProfile(agent.id, { role: "QA" });
    expect((await getAgentById(agent.id))?.avatar).toEqual({
      type: "lucide",
      icon: "cat",
      color: "#ff00aa",
    });

    // Explicit `avatar: null` resets to the deterministic fallback — this is
    // the case COALESCE(?, avatar) can never express.
    await updateAgentProfile(agent.id, { avatar: null });
    expect((await getAgentById(agent.id))?.avatar).toBeNull();
  });

  test("listWorkflows — slim drops definition, adds nodeCount", async () => {
    await createWorkflow({
      name: "Slim Workflow",
      definition: {
        nodes: [
          { id: "n1", type: "raw-llm", config: {} },
          { id: "n2", type: "raw-llm", config: {} },
        ],
        onNodeFailure: "fail",
      },
    });

    const slim = await listWorkflows(undefined, { slim: true });
    expect(slim.length).toBeGreaterThan(0);
    const slimWf = slim.find((w) => w.name === "Slim Workflow");
    expect(slimWf).toBeDefined();
    expect(slimWf?.nodeCount).toBe(2);
    expect((slimWf as unknown as Workflow).definition).toBeUndefined();
    expect((slimWf as unknown as Workflow).triggers).toBeUndefined();

    const full = (await listWorkflows()).find((w) => w.name === "Slim Workflow");
    expect(full?.definition.nodes).toHaveLength(2);
    expect(Array.isArray(full?.triggers)).toBe(true);
  });

  test("listAllPages — slim drops body and passwordHash", async () => {
    await createPage({
      agentId: "slim-agent-1",
      slug: "slim-page",
      title: "Slim Page",
      contentType: "text/html",
      authMode: "public",
      body: "<html>".concat("x".repeat(5000), "</html>"),
    });

    const slim = await listAllPages(50, 0, { slim: true });
    const slimPage = slim.find((p) => p.slug === "slim-page");
    expect(slimPage).toBeDefined();
    expect((slimPage as unknown as Page).body).toBeUndefined();
    expect((slimPage as unknown as Page).passwordHash).toBeUndefined();
    expect(slimPage?.title).toBe("Slim Page");

    const full = (await listAllPages(50, 0)).find((p) => p.slug === "slim-page");
    expect(full?.body).toContain("x".repeat(5000));
  });

  test("getScheduledTasks — slim swaps taskTemplate for a bounded preview", async () => {
    const template = "T".repeat(2000);
    await createScheduledTask({
      name: "Slim Schedule",
      taskTemplate: template,
      cronExpression: "0 9 * * 1",
      scheduleType: "recurring",
    });

    const slim = await getScheduledTasks(undefined, { slim: true });
    const slimSched = slim.find((s) => s.name === "Slim Schedule");
    expect(slimSched).toBeDefined();
    expect("taskTemplate" in slimSched!).toBe(false);
    expect(slimSched?.taskTemplatePreview.length).toBeLessThan(template.length);
    expect(slimSched?.taskTemplatePreview.startsWith("T")).toBe(true);

    const full = (await getScheduledTasks()).find((s) => s.name === "Slim Schedule");
    expect(full?.taskTemplate).toBe(template);
  });

  test("getAllTasks — slim truncates task text and drops heavy blobs", async () => {
    const longText = "Z".repeat(2000);
    const task = await createTaskExtended(longText, { agentId: "slim-agent-1" });
    await createSessionCost({
      sessionId: "slim-cost-session-1",
      taskId: task.id,
      agentId: "slim-agent-1",
      totalCostUsd: 0.0123,
      durationMs: 1000,
      numTurns: 1,
      model: "test-model",
    });
    await createSessionCost({
      sessionId: "slim-cost-session-2",
      taskId: task.id,
      agentId: "slim-agent-1",
      totalCostUsd: 0.0045,
      durationMs: 1000,
      numTurns: 1,
      model: "test-model",
    });

    const slim = await getAllTasks({}, { slim: true });
    const slimTask = slim.find((t) => t.task.startsWith("Z"));
    expect(slimTask).toBeDefined();
    expect(slimTask?.task.length).toBeLessThan(longText.length);
    // Heavy blobs are dropped from the slim row.
    expect("output" in slimTask!).toBe(false);
    expect("failureReason" in slimTask!).toBe(false);
    expect("providerMeta" in slimTask!).toBe(false);
    expect(slimTask?.totalCostUsd).toBeCloseTo(0.0168, 6);

    const full = (await getAllTasks({})).find((t) => t.task === longText);
    expect(full).toBeDefined();
    expect(full?.task).toBe(longText);
    expect(full?.totalCostUsd).toBeCloseTo(0.0168, 6);
  });

  test("getAllTasks — SQL-side preview matches truncating the full text", async () => {
    // The SQL cut counts UTF-8 bytes while JS slices UTF-16 units, so pin the
    // boundary with astral (surrogate-pair) and multibyte characters. SQLite's
    // text functions stop at an embedded NUL, so pin that too, plus a leading
    // BOM a default TextDecoder would strip. The BOM goes in as SQL bytes:
    // bun:sqlite drops a leading BOM when it binds a string.
    const agentId = "preview-parity-agent";
    const marker = "preview-parity-";
    const texts = [
      `${marker}${"a".repeat(285)}`, // exactly 300 units
      `${marker}${"a".repeat(286)}`, // 301 units
      `${marker}${"😀".repeat(200)}`,
      `${marker}${"é".repeat(284)}😀`,
      `${marker}${"ñ".repeat(500)}`,
      `${marker}short`,
      "a\u0000b",
      `\u0000${"x".repeat(350)}`,
    ];
    for (const text of texts) await createTaskExtended(text, { agentId });
    const bom = await createTaskExtended(`${marker}bom`, { agentId });
    texts.push(`\uFEFF${marker}bom`);
    await getDbClient().run(
      "UPDATE agent_tasks SET task = CAST(x'EFBBBF' AS TEXT) || task WHERE id = ?",
      [bom.id],
    );

    const full = await getAllTasks({ agentId, limit: 50 });
    expect(full.map((t) => t.task).sort()).toEqual([...texts].sort());
    for (const opts of [{ slim: true }, { fields: "timeline" as const }]) {
      const rows = await getAllTasks({ agentId, limit: 50 }, opts);
      expect(rows.map((t) => t.id)).toEqual(full.map((t) => t.id));
      for (const [i, row] of full.entries()) {
        const expected = row.task.length > 300 ? `${row.task.slice(0, 300)}…` : row.task;
        expect(rows[i]!.task).toBe(expected);
      }
    }
  });

  test("getAllTasks — slim and full pages hold the same rows in the same order", async () => {
    for (let i = 0; i < 12; i++) {
      await createTaskExtended(`page-parity ${i}`, { agentId: "slim-agent-1" });
    }
    for (const orderBy of ["lastUpdatedAt", "createdAt"] as const) {
      for (const offset of [0, 5, 10]) {
        const filters = { search: "page-parity", limit: 5, offset, orderBy };
        const slimIds = (await getAllTasks(filters, { slim: true })).map((t) => t.id);
        const fullIds = (await getAllTasks(filters)).map((t) => t.id);
        const timelineIds = (await getAllTasks(filters, { fields: "timeline" })).map((t) => t.id);
        expect(slimIds).toEqual(fullIds);
        expect(timelineIds).toEqual(fullIds);
      }
    }
  });

  test("getAllTasks — timeline projection carries only what the timeline draws", async () => {
    const task = await createTaskExtended(`timeline-row ${"T".repeat(1000)}`, {
      agentId: "slim-agent-1",
      tags: ["timeline"],
    });
    await createSessionCost({
      sessionId: "timeline-cost-session",
      taskId: task.id,
      agentId: "slim-agent-1",
      totalCostUsd: 0.25,
      durationMs: 1000,
      numTurns: 1,
      model: "test-model",
    });

    const [row] = await getAllTasks({ search: "timeline-row", limit: 1 }, { fields: "timeline" });
    expect(Object.keys(row!).sort()).toEqual(
      [
        "agentId",
        "createdAt",
        "finishedAt",
        "id",
        "lastUpdatedAt",
        "parentTaskId",
        "peakContextTokens",
        "status",
        "task",
        "title",
        "totalCostUsd",
      ].sort(),
    );
    expect(row!.id).toBe(task.id);
    expect(row!.task).toBe(`${task.task.slice(0, 300)}…`);
    expect(row!.totalCostUsd).toBeCloseTo(0.25, 6);
  });

  test("listRecentSessions — slim root is a truncated task summary", async () => {
    const longText = "Q".repeat(2000);
    await createTaskExtended(longText, { agentId: "slim-agent-1" });

    const slim = await listRecentSessions({ limit: 50, slim: true });
    const slimSession = slim.find((s) => s.root.task.startsWith("Q"));
    expect(slimSession).toBeDefined();
    expect(slimSession?.root.task.length).toBeLessThan(longText.length);
    expect("output" in slimSession!.root).toBe(false);

    const full = await listRecentSessions({ limit: 50 });
    const fullSession = full.find((s) => s.root.task === longText);
    expect(fullSession).toBeDefined();
    expect(fullSession?.root.task).toBe(longText);
  });
});
