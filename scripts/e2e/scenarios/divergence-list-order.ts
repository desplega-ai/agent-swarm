// Locks today's list order, tie order and NULL placement for four paginated or sorted
// lists, so another storage engine must return the same rows in the same order.
// Every expectation is computed from what the API itself returned (timestamps, ids,
// insertion order), never from wall-clock luck, so the scenario is deterministic.
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cancelQuietly, createAssignedTask, registerWorker } from "./core-helpers";

type Row = Record<string, unknown>;

function ids(rows: Row[]): string[] {
  return rows.map((row) => asString(row.id, "row id"));
}

function sameSequence(actual: string[], expected: string[], label: string): void {
  expect(
    actual.length === expected.length && actual.every((id, index) => id === expected[index]),
    `${label}: order differs.\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
  );
}

/** Paging contract: every row exactly once, no gaps, same sequence as one big page. */
function expectPagedEqualsFull(pages: string[][], full: string[], label: string): void {
  const flat = pages.flat();
  expect(new Set(flat).size === flat.length, `${label}: a row appears on two pages`);
  sameSequence(flat, full, `${label} (paged vs one page)`);
}

/**
 * Stable sort by `key` descending; equal keys keep `insertion` order ascending. This is the
 * order the lists below return today for rows that tie on their only sort key.
 */
function descThenInsertion<T>(rows: T[], key: (row: T) => string, insertion: (row: T) => number) {
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return insertion(a) - insertion(b);
  });
}

async function listTaskIds(ctx: ScenarioContext, query: string): Promise<Row[]> {
  const response = await ctx.api("GET", `/api/tasks?${query}`);
  expectStatus(response, [200], `list tasks ${query}`);
  return asRecords(response.json, "tasks");
}

/** GET /api/tasks: default order (lastUpdatedAt DESC, priority DESC) and orderBy=createdAt. */
async function tasksOrder(ctx: ScenarioContext): Promise<string[]> {
  const created: string[] = [];
  // Sequential inserts with rising priority: when two rows land on the same millisecond the
  // priority tiebreak still puts the later row first, so the default order is exactly the
  // reverse of insertion either way.
  const sequentialAgent = await registerWorker(ctx, "div-order-seq");
  const sequential: string[] = [];
  for (let index = 0; index < 6; index++) {
    sequential.push(
      await createAssignedTask(ctx, sequentialAgent, `div order seq ${index} ${ctx.nonce}`, {
        priority: 10 + index * 10,
      }),
    );
  }
  created.push(...sequential);
  const newestFirst = [...sequential].reverse();

  const byDefault = await listTaskIds(ctx, `agentId=${sequentialAgent}&limit=50`);
  sameSequence(ids(byDefault), newestFirst, "tasks default order");
  for (let index = 1; index < byDefault.length; index++) {
    const previous = asString(byDefault[index - 1]?.lastUpdatedAt, "lastUpdatedAt");
    const current = asString(byDefault[index]?.lastUpdatedAt, "lastUpdatedAt");
    expect(previous >= current, "tasks default order is not lastUpdatedAt DESC");
  }
  const defaultPages: string[][] = [];
  for (let offset = 0; offset < 6; offset += 4) {
    defaultPages.push(
      ids(await listTaskIds(ctx, `agentId=${sequentialAgent}&limit=4&offset=${offset}`)),
    );
  }
  expectPagedEqualsFull(defaultPages, newestFirst, "tasks default order");

  // orderBy=createdAt is createdAt DESC with an insertion tiebreak (newest insert first), so
  // sequential inserts come back in exact reverse insertion order even on a millisecond tie.
  const byCreated = await listTaskIds(ctx, `agentId=${sequentialAgent}&orderBy=createdAt&limit=50`);
  sameSequence(ids(byCreated), newestFirst, "tasks orderBy=createdAt");
  const createdPages: string[][] = [];
  for (let offset = 0; offset < 6; offset += 2) {
    createdPages.push(
      ids(
        await listTaskIds(
          ctx,
          `agentId=${sequentialAgent}&orderBy=createdAt&limit=2&offset=${offset}`,
        ),
      ),
    );
  }
  expectPagedEqualsFull(createdPages, newestFirst, "tasks orderBy=createdAt");
  expect(
    (await listTaskIds(ctx, `agentId=${sequentialAgent}&orderBy=createdAt&limit=2&offset=6`))
      .length === 0,
    "tasks: a page past the end is not empty",
  );

  // Concurrent inserts with one priority provoke createdAt ties. The order inside a tie is
  // the insertion tiebreak, which the client cannot observe, so assert the paging contract:
  // small pages concatenate to the one-page sequence, with createdAt never rising.
  const burstAgent = await registerWorker(ctx, "div-order-burst");
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      createAssignedTask(ctx, burstAgent, `div order burst ${index} ${ctx.nonce}`, {
        priority: 50,
      }),
    ),
  );
  created.push(...burst);
  const burstFull = await listTaskIds(ctx, `agentId=${burstAgent}&orderBy=createdAt&limit=50`);
  expect(
    burstFull.length === 8 && new Set(ids(burstFull)).size === 8,
    `tasks burst: expected 8 distinct rows, got ${burstFull.length}`,
  );
  expect(
    ids(burstFull).every((id) => burst.includes(id)),
    "tasks burst: a foreign row in the list",
  );
  let ties = 0;
  for (let index = 1; index < burstFull.length; index++) {
    const previous = asString(burstFull[index - 1]?.createdAt, "createdAt");
    const current = asString(burstFull[index]?.createdAt, "createdAt");
    expect(previous >= current, "tasks burst: createdAt rises inside orderBy=createdAt");
    if (previous === current) ties++;
  }
  for (const size of [1, 3]) {
    const pages: string[][] = [];
    for (let offset = 0; offset < 8; offset += size) {
      pages.push(
        ids(
          await listTaskIds(
            ctx,
            `agentId=${burstAgent}&orderBy=createdAt&limit=${size}&offset=${offset}`,
          ),
        ),
      );
    }
    expectPagedEqualsFull(pages, ids(burstFull), `tasks burst limit=${size}`);
  }
  ctx.log(`tasks burst: ${ties} createdAt tie(s) across 8 concurrent inserts`);
  return created;
}

/** POST /api/memory/list: ORDER BY createdAt DESC only. Chunks of one document often tie. */
async function memoryOrder(ctx: ScenarioContext): Promise<void> {
  const agentId = await registerWorker(ctx, "div-order-mem");
  const insertion: string[] = [];
  for (const [label, paragraphs] of [
    ["otter", 220],
    ["heron", 60],
  ] as const) {
    const content = Array.from(
      { length: paragraphs },
      (_, index) =>
        `Paragraph ${index} of the ${label}${ctx.nonce} field guide covers feeding, nesting, migration and the habits of the colony in plain words.`,
    ).join("\n\n");
    const response = await ctx.api("POST", "/api/memory/index", {
      agentId,
      body: {
        content,
        name: `div order ${label} ${ctx.nonce}`,
        scope: "agent",
        source: "manual",
        agentId,
      },
    });
    expectStatus(response, [202], `index the ${label} document`);
    const memoryIds = asRecord(response.json).memoryIds;
    expect(
      Array.isArray(memoryIds) && memoryIds.length > 1,
      `the ${label} document was not chunked: ${response.text.slice(0, 200)}`,
    );
    insertion.push(...memoryIds.map((id) => asString(id, "memory id")));
  }

  const list = async (limit: number, offset: number) => {
    const response = await ctx.api("POST", "/api/memory/list", {
      body: { agentId, limit, offset },
    });
    expectStatus(response, [200], `memory list limit=${limit} offset=${offset}`);
    const body = asRecord(response.json);
    expect(body.mode === "list", "memory list without a query is not list mode");
    return { rows: asRecords(body, "results"), total: body.total };
  };
  const landed = await pollUntil(
    async () => (await list(100, 0)).total === insertion.length,
    15_000,
    200,
  );
  expect(landed, `memory list never counted the ${insertion.length} stored chunks`);

  const full = (await list(100, 0)).rows;
  const position = new Map(insertion.map((id, index) => [id, index]));
  // tie order: insertion. createdAt is the only sort key, so chunks stored in the same
  // millisecond come back oldest insert first, inside a newest-first list.
  const expected = ids(
    descThenInsertion(
      full,
      (row) => asString(row.createdAt, "memory createdAt"),
      (row) => position.get(asString(row.id, "memory id")) ?? -1,
    ),
  );
  expect(
    ids(full).every((id) => position.has(id)),
    "memory list returned a row this scenario did not store",
  );
  sameSequence(ids(full), expected, "memory list order");
  const ties = full.filter(
    (row, index) => index > 0 && row.createdAt === full[index - 1]?.createdAt,
  ).length;
  ctx.log(`memory list: ${ties} createdAt tie(s) across ${full.length} chunks`);

  const pages: string[][] = [];
  for (let offset = 0; offset < full.length; offset += 4) {
    pages.push(ids((await list(4, offset)).rows));
  }
  expectPagedEqualsFull(pages, ids(full), "memory list");
  const past = await list(4, full.length);
  expect(past.rows.length === 0 && past.total === full.length, "memory list past the end");
}

/** GET /api/pages: ORDER BY updatedAt DESC. updatedAt has second precision, so rapid
 * inserts tie on it. */
async function pagesOrder(ctx: ScenarioContext): Promise<string[]> {
  const agentId = await registerWorker(ctx, "div-order-pages");
  const marker = `divpg${ctx.nonce}`;
  const insertion: string[] = [];
  for (let index = 0; index < 9; index++) {
    const response = await ctx.api("POST", "/api/pages", {
      agentId,
      body: {
        title: `${marker} page ${index}`,
        slug: `${marker}-${index}`,
        contentType: "text/html",
        body: `<p>${index}</p>`,
      },
    });
    expectStatus(response, [201], `create page ${index}`);
    insertion.push(asString(asRecord(response.json).id, "page id"));
  }
  const list = async (query: string) => {
    const response = await ctx.api("GET", `/api/pages?q=${marker}&${query}`);
    expectStatus(response, [200], `list pages ${query}`);
    const body = asRecord(response.json);
    expect(body.total === 9, `pages total ${String(body.total)}, expected 9`);
    return asRecords(body, "pages");
  };
  const full = await list("limit=100");
  const position = new Map(insertion.map((id, index) => [id, index]));
  // tie order: insertion. Pages created in the same second come back oldest insert first.
  const expected = ids(
    descThenInsertion(
      full,
      (row) => asString(row.updatedAt, "page updatedAt"),
      (row) => position.get(asString(row.id, "page id")) ?? -1,
    ),
  );
  expect(
    ids(full).every((id) => position.has(id)),
    "pages list returned a foreign page",
  );
  sameSequence(ids(full), expected, "pages list order");
  const distinctSeconds = new Set(full.map((row) => row.updatedAt)).size;
  ctx.log(`pages list: 9 pages over ${distinctSeconds} distinct updatedAt value(s)`);
  const pages: string[][] = [];
  for (let offset = 0; offset < 9; offset += 4) {
    pages.push(ids(await list(`limit=4&offset=${offset}`)));
  }
  expectPagedEqualsFull(pages, ids(full), "pages list");
  expect((await list("limit=4&offset=9")).length === 0, "pages list past the end");
  return insertion;
}

/** GET /api/schedules: lastRunAt DESC with NULL lastRunAt last, then lastUpdatedAt DESC. */
async function schedulesNullOrder(ctx: ScenarioContext, created: string[]): Promise<string[]> {
  const agentId = await registerWorker(ctx, "div-order-sched");
  const prefix = `div-order-${ctx.nonce}`;
  const scheduleIds: string[] = [];
  for (const [label, enabled] of [
    ["ran-first", true],
    ["never-a", false],
    ["ran-second", true],
    ["never-b", false],
  ] as const) {
    const response = await ctx.api("POST", "/api/schedules", {
      body: {
        name: `${prefix}-${label}`,
        intervalMs: 86_400_000,
        taskTemplate: `div order ${label} ${ctx.nonce}`,
        targetAgentId: agentId,
        enabled,
      },
    });
    expectStatus(response, [201], `create schedule ${label}`);
    scheduleIds.push(asString(asRecord(response.json).id, "schedule id"));
  }
  const [ranFirst, neverA, ranSecond, neverB] = scheduleIds as [string, string, string, string];
  for (const id of [ranFirst, ranSecond]) {
    const run = await ctx.api("POST", `/api/schedules/${id}/run`, { body: {} });
    expectStatus(run, [200], `run schedule ${id} now`);
  }
  const tasks = await ctx.api("GET", `/api/tasks?agentId=${agentId}&limit=50`);
  expectStatus(tasks, [200], "list the schedule tasks");
  created.push(...ids(asRecords(tasks.json, "tasks")));

  const response = await ctx.api("GET", `/api/schedules?name=${prefix}`);
  expectStatus(response, [200], "list schedules");
  const rows = asRecords(response.json, "schedules");
  // Run schedules first (latest run first), then never-run schedules (NULL lastRunAt sorts
  // last) newest lastUpdatedAt first.
  sameSequence(ids(rows), [ranSecond, ranFirst, neverB, neverA], "schedules order");
  for (const row of rows.slice(0, 2)) {
    expect(typeof row.lastRunAt === "string", "a run schedule has no lastRunAt");
  }
  for (const row of rows.slice(2)) {
    // A NULL lastRunAt is omitted from the JSON, not sent as null.
    expect(!("lastRunAt" in row), `a never-run schedule sends lastRunAt: ${JSON.stringify(row)}`);
  }
  expect(asRecord(response.json).count === 4, "schedules count");
  return scheduleIds;
}

export const divergenceListOrder: Scenario = {
  name: "divergence-list-order",
  order: 9_231,
  async run(ctx) {
    const taskIds = await tasksOrder(ctx);
    await memoryOrder(ctx);
    const pageIds = await pagesOrder(ctx);
    const scheduleIds = await schedulesNullOrder(ctx, taskIds);

    for (const id of scheduleIds) {
      expectStatus(await ctx.api("DELETE", `/api/schedules/${id}`), [200, 204], "delete schedule");
    }
    for (const id of pageIds) {
      expectStatus(await ctx.api("DELETE", `/api/pages/${id}`), [200, 204], "delete page");
    }
    for (const id of taskIds) await cancelQuietly(ctx, id);
  },
};
