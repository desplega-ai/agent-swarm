import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as db from "../be/db";

beforeEach(async () => {
  db.initDb(":memory:");
  await db
    .getDbClient()
    .run(
      "INSERT INTO users (id, name, createdAt, lastUpdatedAt) VALUES ('requester', 'Requester', '2026-01-01', '2026-01-01')",
    );
  for (const [id, status, taskType, tags, requester, updated, priority] of [
    ["a", "pending", null, "[]", null, "03", 10],
    ["b", "completed", "feature", '["blue"]', "requester", "02", 50],
    ["c", "pending", "feature", '["blue"]', "requester", "03", 90],
    ["h", "pending", "heartbeat", "[]", null, "04", 50],
    ["t", "pending", null, '["heartbeat"]', null, "05", 50],
    ["k", "pending", "heartbeat-checklist", "[]", null, "06", 50],
    ["z", "pending", "boot-triage", "[]", null, "07", 50],
  ] as const) {
    await db.getDbClient().run(
      `INSERT INTO agent_tasks (id, task, status, source, taskType, tags, requestedByUserId,
       createdAt, lastUpdatedAt, priority, "key") VALUES (?, ?, ?, 'api', ?, ?, ?, ?, ?, ?, 'shared/demo/')`,
      [
        id,
        `needle ${id}`,
        status,
        taskType,
        tags,
        requester,
        "2026-01-01",
        `2026-01-${updated}`,
        priority,
      ],
    );
  }
});
afterEach(() => db.closeDb());

// Characterized against the pre-extraction facade at 8a8b7b53.
const cases: {
  name: string;
  filters: db.TaskFilters;
  params: string[];
  ids: string[];
  total?: number;
}[] = [
  { name: "defaults and priority tie", filters: {}, params: [], ids: ["c", "a", "b"] },
  { name: "single status", filters: { status: "completed" }, params: ["completed"], ids: ["b"] },
  { name: "empty statuses", filters: { status: [] }, params: [], ids: ["c", "a", "b"] },
  {
    name: "singleton statuses",
    filters: { status: ["pending"] },
    params: ["pending"],
    ids: ["c", "a"],
  },
  {
    name: "status array ordering",
    filters: { status: ["completed", "pending"] },
    params: ["completed", "pending"],
    ids: ["c", "a", "b"],
  },
  {
    name: "requester",
    filters: { requestedByUserId: "requester" },
    params: ["requester"],
    ids: ["c", "b"],
  },
  {
    name: "null wins",
    filters: { requestedByUserId: "requester", requestedByUserIdIsNull: true },
    params: [],
    ids: ["a"],
  },
  { name: "search", filters: { search: "b" }, params: ["%b%", "%b%"], ids: ["b"] },
  {
    name: "combined ordering",
    filters: {
      status: ["pending", "completed"],
      search: "needle",
      taskType: "feature",
      tags: ["blue"],
      source: ["api"],
      requestedByUserId: "requester",
    },
    params: [
      "pending",
      "completed",
      "%needle%",
      "%needle%",
      "feature",
      '%"blue"%',
      "api",
      "requester",
    ],
    ids: ["c", "b"],
  },
  {
    name: "include heartbeat",
    filters: { includeHeartbeat: true },
    params: [],
    ids: ["z", "k", "t", "h", "c", "a", "b"],
  },
  {
    name: "created rowid tie",
    filters: { orderBy: "createdAt" },
    params: [],
    ids: ["c", "b", "a"],
  },
  { name: "pagination", filters: { limit: 1, offset: 1 }, params: [], ids: ["a"], total: 3 },
  { name: "zero limit", filters: { limit: 0 }, params: [], ids: [], total: 3 },
  {
    name: "namespace prefix",
    filters: { keyPrefix: "shared/demo/" },
    params: ["shared/demo/%"],
    ids: ["c", "a", "b"],
  },
];

for (const { name, filters, params, ids, total } of cases) {
  test(name, async () => {
    const client = db.getDbClient();
    const listSpy = spyOn(client, "query");
    const countSpy = spyOn(client, "get");
    try {
      expect((await db.getAllTasks(filters)).map((task) => task.id)).toEqual(ids);
      expect(listSpy.mock.calls[0]?.[1]).toEqual(params);
      const sql = listSpy.mock.calls[0]?.[0] ?? "";
      expect(sql).toContain(`LIMIT ${filters.limit ?? 25} OFFSET ${filters.offset ?? 0}`);
      expect(sql).toContain(
        filters.orderBy === "createdAt"
          ? "ORDER BY createdAt DESC, rowid DESC"
          : "ORDER BY lastUpdatedAt DESC, priority DESC",
      );
      expect(await db.getTasksCount(filters)).toBe(total ?? ids.length);
      expect(countSpy.mock.calls[0]?.[1]).toEqual(params);
      expect((await db.getAllTasks({ ...filters, limit: 100, offset: 0 })).length).toBe(
        await db.getTasksCount(filters),
      );
      expect((await db.getAllTasks(filters, { slim: true })).map((task) => task.id)).toEqual(ids);
    } finally {
      listSpy.mockRestore();
      countSpy.mockRestore();
    }
  });
}

test("facade dependency callback preserves post-pagination readiness and propagates errors", async () => {
  await db.getDbClient().run("UPDATE agent_tasks SET dependsOn = '[\"a\"]' WHERE id = 'c'");
  expect(await db.getAllTasks({ readyOnly: true, limit: 1 })).toEqual([]);
  expect(await db.getAllTasks({ readyOnly: true, limit: 1 }, { slim: true })).toEqual([]);
  await db.getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = 'a'");
  expect((await db.getAllTasks({ readyOnly: true, limit: 1 })).map((t) => t.id)).toEqual(["c"]);
  await db.getDbClient().run("UPDATE agent_tasks SET tags = '{' WHERE id = 'a'");
  await expect(db.getAllTasks({ readyOnly: true, limit: 1 })).rejects.toThrow();
});

test("row defaults, malformed guarded JSON and slim preview remain unchanged", async () => {
  await db
    .getDbClient()
    .run(
      "UPDATE agent_tasks SET task = ?, followUpConfig = '{', routingAffinity = '{' WHERE id = 'a'",
      ["x".repeat(400)],
    );
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const task = await db.getTaskById("a");
    expect(task).toMatchObject({
      tags: [],
      dependsOn: [],
      slackReplySent: false,
      wasPaused: false,
      routingAffinityInvalid: true,
    });
    expect(task?.followUpConfig).toBeUndefined();
    expect(task?.requestedByUserId).toBeUndefined();
    const slim = (await db.getAllTasks({ search: "a" }, { slim: true }))[0];
    expect(slim?.task.length).toBeLessThanOrEqual(301);
    expect(slim).not.toHaveProperty("output");
    expect(await db.getTaskById("missing")).toBeNull();
  } finally {
    warning.mockRestore();
  }
});
