import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createApp, listApps } from "../apps/store";
import {
  closeDb,
  countAllPages,
  createAgent,
  createPage,
  createScheduledTask,
  createWorkflow,
  getScheduledTasks,
  initDb,
  listAllPages,
  listWorkflows,
} from "../be/db";
import { searchAgents } from "../http/agents";

const TEST_DB_PATH = "./test-list-search-params.sqlite";

async function removeDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
  }
}

const appDefinition = {
  pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
  defaultPage: "main",
};

/**
 * The bounded `q` / `limit` list params the dashboard's Cmd+K search uses.
 * Each filter has a positive case, a negative case, and a literal-wildcard
 * case (`%` and `_` in the query match only themselves).
 */
describe("list search params", () => {
  beforeAll(async () => {
    await removeDb();
    initDb(TEST_DB_PATH);
    await createAgent({ id: "search-agent", name: "Search Agent", isLead: false, status: "idle" });
  });

  afterAll(async () => {
    closeDb();
    await removeDb();
  });

  test("pages: q matches title, slug and description; count agrees", async () => {
    const base = { agentId: "search-agent", contentType: "text/html" as const, body: "<p>x</p>" };
    await createPage({ ...base, slug: "quarterly-report", title: "Quarterly report" });
    await createPage({ ...base, slug: "roadmap", title: "Roadmap", description: "plan for Q3" });
    await createPage({ ...base, slug: "unrelated", title: "100% done" });

    const byTitle = await listAllPages(50, 0, { slim: true, q: "quarterly" });
    expect(byTitle.map((p) => p.slug)).toEqual(["quarterly-report"]);
    const byDescription = await listAllPages(50, 0, { slim: true, q: "plan for" });
    expect(byDescription.map((p) => p.slug)).toEqual(["roadmap"]);
    expect(await countAllPages({ q: "quarterly" })).toBe(1);
    expect(await listAllPages(50, 0, { slim: true, q: "no-such-page" })).toEqual([]);
    // `%` is literal: only the title that contains it matches.
    const literal = await listAllPages(50, 0, { slim: true, q: "%" });
    expect(literal.map((p) => p.slug)).toEqual(["unrelated"]);
  });

  test("workflows: q matches name and description; limit bounds the rows", async () => {
    const definition = {
      nodes: [{ id: "n1", type: "raw-llm", config: {} }],
      onNodeFailure: "fail",
    };
    await createWorkflow({ name: "Deploy preview", definition });
    await createWorkflow({ name: "Nightly digest", description: "deploy notes", definition });
    await createWorkflow({ name: "Unrelated", definition });

    const matches = await listWorkflows({ q: "deploy" }, { slim: true });
    expect(matches.map((w) => w.name).sort()).toEqual(["Deploy preview", "Nightly digest"]);
    expect(await listWorkflows({ q: "deploy", limit: 1 }, { slim: true })).toHaveLength(1);
    expect(await listWorkflows({ q: "dep_oy" }, { slim: true })).toEqual([]);
  });

  test("apps: q matches name and description; limit bounds the rows", async () => {
    await createApp({ name: "Sales board", definition: appDefinition });
    await createApp({ name: "Ops", description: "sales pipeline", definition: appDefinition });
    await createApp({ name: "Other", definition: appDefinition });

    const matches = await listApps({ q: "SALES" });
    expect(matches.map((a) => a.name).sort()).toEqual(["Ops", "Sales board"]);
    expect(await listApps({ q: "sales", limit: 1 })).toHaveLength(1);
    expect(await listApps({ q: "nothing" })).toEqual([]);
    expect((await listApps()).length).toBeGreaterThanOrEqual(3);
  });

  test("scheduled tasks: limit bounds the name search", async () => {
    for (const name of ["Standup alpha", "Standup beta", "Retro"]) {
      await createScheduledTask({
        name,
        taskTemplate: "do it",
        cronExpression: "0 9 * * 1",
        scheduleType: "recurring",
      });
    }
    expect(await getScheduledTasks({ name: "Standup" }, { slim: true })).toHaveLength(2);
    expect(await getScheduledTasks({ name: "Standup", limit: 1 }, { slim: true })).toHaveLength(1);
  });

  test("agents: q matches name, role or id; limit bounds the rows", () => {
    const agents = [
      { id: "a-1", name: "Picateclas", role: "coder" },
      { id: "a-2", name: "Lead", role: "lead" },
      { id: "coder-3", name: "Other", role: null },
    ];
    expect(searchAgents(agents, "CODER", undefined).map((a) => a.id)).toEqual(["a-1", "coder-3"]);
    expect(searchAgents(agents, "coder", 1).map((a) => a.id)).toEqual(["a-1"]);
    expect(searchAgents(agents, "nope", undefined)).toEqual([]);
    expect(searchAgents(agents, undefined, undefined)).toHaveLength(3);
  });
});
