import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  countAllPages,
  countPagesByAgent,
  countSessions,
  createAgent,
  createPage,
  createSkill,
  createTaskExtended,
  createWorkflow,
  getAllTasks,
  getSwarmMetrics,
  getTasksCount,
  initDb,
  insertActiveSession,
} from "../be/db";

const TEST_DB_PATH = "./test-pagination-metrics.sqlite";

/**
 * Covers the filter-aware pagination totals + the `/api/metrics` aggregate:
 *   - `getTasksCount` applies the SAME WHERE clause as `getAllTasks` (so a
 *     paginated list shows the real filtered total, not the page length).
 *   - `countAllPages` / `countPagesByAgent` / `countSessions` back the totals
 *     for the `/api/pages` + `/api/sessions` pagers.
 *   - `getSwarmMetrics` returns coherent swarm-wide counts.
 */
describe("pagination metrics", () => {
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

  test("getTasksCount is filter-aware and independent of limit/offset", () => {
    const totalBefore = getTasksCount();

    for (let i = 0; i < 7; i++) {
      createTaskExtended(`alpha task ${i}`, { tags: ["alpha"] });
    }
    for (let i = 0; i < 3; i++) {
      createTaskExtended(`beta task ${i}`, { tags: ["beta"] });
    }

    // Filtered count matches the number of matching rows...
    expect(getTasksCount({ tags: ["alpha"] })).toBe(7);
    expect(getTasksCount({ tags: ["beta"] })).toBe(3);

    // ...and is unaffected by the page window applied to the list query.
    const page1 = getAllTasks({ tags: ["alpha"], limit: 2, offset: 0 });
    const page2 = getAllTasks({ tags: ["alpha"], limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(getTasksCount({ tags: ["alpha"], limit: 2, offset: 0 })).toBe(7);

    // The unfiltered count covers every task created above.
    expect(getTasksCount() - totalBefore).toBe(10);
  });

  test("getTasksCount filter-aware on search", () => {
    createTaskExtended("needle-xyz unique marker", {});
    expect(getTasksCount({ search: "needle-xyz" })).toBe(1);
    expect(getAllTasks({ search: "needle-xyz" })).toHaveLength(1);
  });

  test("countAllPages and countPagesByAgent", () => {
    const a1 = createAgent({ id: "pm-agent-1", name: "PM Agent 1", isLead: false, status: "idle" });
    const a2 = createAgent({ id: "pm-agent-2", name: "PM Agent 2", isLead: false, status: "busy" });
    for (let i = 0; i < 4; i++) {
      createPage({
        agentId: a1.id,
        slug: `pm-page-a1-${i}`,
        title: `Page ${i}`,
        contentType: "text/html",
        authMode: "public",
        body: "<html>x</html>",
      });
    }
    for (let i = 0; i < 2; i++) {
      createPage({
        agentId: a2.id,
        slug: `pm-page-a2-${i}`,
        title: `Page ${i}`,
        contentType: "text/html",
        authMode: "public",
        body: "<html>y</html>",
      });
    }

    expect(countAllPages()).toBe(6);
    expect(countPagesByAgent(a1.id)).toBe(4);
    expect(countPagesByAgent(a2.id)).toBe(2);
  });

  test("countSessions is filter-aware on source", () => {
    // Sessions are root tasks (parentTaskId IS NULL). Tasks created here have
    // no parent, so each is its own session. Assertions are delta-based so the
    // test is robust against tasks created by earlier tests in this file.
    const mcpBefore = countSessions({ source: ["mcp"] });
    const slackBefore = countSessions({ source: ["slack"] });
    const bothBefore = countSessions({ source: ["mcp", "slack"] });

    for (let i = 0; i < 5; i++) {
      createTaskExtended(`mcp session ${i}`, { source: "mcp" });
    }
    for (let i = 0; i < 2; i++) {
      createTaskExtended(`slack session ${i}`, { source: "slack" });
    }

    expect(countSessions({ source: ["mcp"] }) - mcpBefore).toBe(5);
    expect(countSessions({ source: ["slack"] }) - slackBefore).toBe(2);
    expect(countSessions({ source: ["mcp", "slack"] }) - bothBefore).toBe(7);
    // q filter narrows on top of source.
    expect(countSessions({ source: ["slack"], q: "slack session" }) - slackBefore).toBe(2);
    expect(countSessions({ q: "no-such-session-marker-zzz" })).toBe(0);
  });

  test("getSwarmMetrics returns coherent aggregate counts", () => {
    createWorkflow({
      name: "PM Workflow A",
      definition: { nodes: [{ id: "n1", type: "raw-llm", config: {} }], onNodeFailure: "fail" },
    });
    createWorkflow({
      name: "PM Workflow B",
      definition: { nodes: [{ id: "n1", type: "raw-llm", config: {} }], onNodeFailure: "fail" },
    });
    createSkill({ name: "pm-skill", description: "test skill", content: "body" });
    insertActiveSession({ agentId: "pm-agent-1", triggerType: "task" });

    const m = getSwarmMetrics();

    // tasks: by_status counts sum to the total.
    expect(m.tasks.total).toBeGreaterThan(0);
    const taskStatusSum = Object.values(m.tasks.by_status).reduce((a, b) => a + b, 0);
    expect(taskStatusSum).toBe(m.tasks.total);

    // agents: 2 created above, by_status sums to total.
    expect(m.agents.total).toBe(2);
    const agentStatusSum = Object.values(m.agents.by_status).reduce((a, b) => a + b, 0);
    expect(agentStatusSum).toBe(m.agents.total);

    // workflows: 2 created, both enabled by default.
    expect(m.workflows.total).toBe(2);
    expect(m.workflows.enabled).toBe(2);

    // pages / sessions / skills.
    expect(m.pages.total).toBe(6);
    expect(m.sessions.active).toBe(1);
    expect(m.skills.total).toBe(1);
  });
});
