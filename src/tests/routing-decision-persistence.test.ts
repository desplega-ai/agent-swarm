import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import { CreateTaskOptionsSchema, RoutingReasonSchema } from "../types";

const migration = await Bun.file(
  new URL("../be/migrations/152_routing_decisions.sql", import.meta.url),
).text();

type DecisionRow = {
  task_id: string;
  selected_agent_id: string | null;
  captured_at: string;
  worker_statuses: string;
  continuity_candidates: string;
};

type Candidate = { taskId: string; agentId: string } | null;

type ContinuityCandidates = {
  samePr: Candidate;
  sameThread: Candidate;
  sameRepo: Candidate;
};

type WorkerStatus = {
  agentId: string;
  status: string;
  activeTaskCount: number;
  openTaskCount: number;
};

const routingHolderSql = `CASE
  WHEN status IN ('draft', 'offered', 'reviewing') AND offeredTo IS NOT NULL THEN offeredTo
  ELSE COALESCE(agentId, offeredTo)
END`;

function expectIndexedContinuityPlan(
  database: Database,
  where: string,
  params: Array<string | number>,
  indexName: string,
): void {
  const plan = database
    .query<{ detail: string }, Array<string | number>>(
      `EXPLAIN QUERY PLAN
       SELECT id AS taskId, ${routingHolderSql} AS agentId
       FROM agent_tasks
       WHERE ${where}
         AND ${routingHolderSql} IN (SELECT id FROM agents WHERE isLead = 0)
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    )
    .all(...params)
    .map((row) => row.detail)
    .join("\n");

  expect(plan).toContain(`USING INDEX ${indexName}`);
  expect(plan).not.toContain("SCAN agent_tasks");
  expect(plan).not.toContain("USE TEMP B-TREE");
}

async function getDecision(taskId: string): Promise<DecisionRow | null> {
  return (
    (await getDbClient().get<DecisionRow>("SELECT * FROM routing_decisions WHERE task_id = ?", [
      taskId,
    ])) ?? null
  );
}

describe("routing decision migration and types", () => {
  test("defines the canonical reasons and validates the optional create fields", () => {
    expect(RoutingReasonSchema.options).toEqual([
      "skill",
      "continuity",
      "overflow",
      "human_pinned",
      "reroute_fault",
    ]);
    for (const routingReason of RoutingReasonSchema.options) {
      expect(CreateTaskOptionsSchema.parse({ routingReason, routingNote: "short note" })).toEqual({
        routingReason,
        routingNote: "short note",
      });
    }
    expect(() => CreateTaskOptionsSchema.parse({ routingReason: "guess" })).toThrow();
    expect(() => CreateTaskOptionsSchema.parse({ routingNote: "x".repeat(201) })).toThrow();
  });

  test("upgrades an existing task table with checked scalars and cascading snapshots", () => {
    const database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    try {
      database.exec(`CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL,
        agentId TEXT,
        offeredTo TEXT,
        vcsRepo TEXT,
        vcsNumber INTEGER,
        slackChannelId TEXT,
        slackThreadTs TEXT,
        agentmailThreadId TEXT
      )`);
      database.exec(
        `INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt)
         VALUES ('legacy', 'legacy task', 'completed', 'mcp', '2026-01-01', '2026-01-01')`,
      );
      database.exec(migration);

      const columns = database
        .query<{ name: string }, []>("PRAGMA table_info(agent_tasks)")
        .all()
        .map((column) => column.name);
      expect(columns).toContain("routing_reason");
      expect(columns).toContain("routing_note");
      expect(
        database
          .query<{ routing_reason: string | null; routing_note: string | null }, []>(
            "SELECT routing_reason, routing_note FROM agent_tasks WHERE id = 'legacy'",
          )
          .get(),
      ).toEqual({ routing_reason: null, routing_note: null });

      const insertTask = (reason: string | null, note: string | null) =>
        database.run(
          `INSERT INTO agent_tasks (
             id, task, status, source, createdAt, lastUpdatedAt, routing_reason, routing_note
           ) VALUES (?, 'task', 'pending', 'mcp', '2026-01-01', '2026-01-01', ?, ?)`,
          [crypto.randomUUID(), reason, note],
        );
      expect(() => insertTask("guess", null)).toThrow();
      expect(() => insertTask("skill", "x".repeat(201))).toThrow();

      const taskId = crypto.randomUUID();
      database.run(
        `INSERT INTO agent_tasks (
           id, task, status, source, createdAt, lastUpdatedAt, routing_reason, routing_note
         ) VALUES (?, 'task', 'pending', 'mcp', '2026-01-01', '2026-01-01', 'skill', 'fit')`,
        [taskId],
      );
      database.run(
        `INSERT INTO routing_decisions (
           task_id, selected_agent_id, captured_at, worker_statuses, continuity_candidates
         ) VALUES (?, 'worker', '2026-01-01', '[]', '{}')`,
        [taskId],
      );
      database.run("DELETE FROM agent_tasks WHERE id = ?", [taskId]);
      expect(
        database.query("SELECT * FROM routing_decisions WHERE task_id = ?").get(taskId),
      ).toBeNull();
    } finally {
      database.close();
    }
  });

  test("the migration runner applies 152 on a fresh database and reruns cleanly", () => {
    const database = new Database(":memory:");
    try {
      runMigrations(database);
      const applied = database
        .query<{ name: string }, []>("SELECT name FROM _migrations WHERE version = 152")
        .get();
      expect(applied).toEqual({ name: "152_routing_decisions" });
      expect(
        database
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routing_decisions'",
          )
          .get(),
      ).toEqual({ name: "routing_decisions" });
      runMigrations(database);
      expect(database.query("SELECT * FROM _migrations WHERE version = 152").all()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("continuity lookups use context recency indexes without scanning task history", () => {
    const database = new Database(":memory:");
    try {
      runMigrations(database);
      expectIndexedContinuityPlan(
        database,
        "vcsRepo = ? AND vcsNumber = ?",
        ["desplega-ai/agent-swarm", 1477],
        "idx_agent_tasks_routing_pr_recency",
      );
      expectIndexedContinuityPlan(
        database,
        "vcsRepo = ?",
        ["desplega-ai/agent-swarm"],
        "idx_agent_tasks_routing_repo_recency",
      );
      expectIndexedContinuityPlan(
        database,
        "slackChannelId = ? AND slackThreadTs = ?",
        ["C1477", "1477.1"],
        "idx_agent_tasks_routing_slack_thread_recency",
      );
      expectIndexedContinuityPlan(
        database,
        "agentmailThreadId = ?",
        ["thread-1477"],
        "idx_agent_tasks_routing_agentmail_thread_recency",
      );
    } finally {
      database.close();
    }
  });
});

describe("routing decision persistence", () => {
  const agents = {
    prOld: "00000000-0000-4000-8000-000000000101",
    prLatest: "00000000-0000-4000-8000-000000000102",
    thread: "00000000-0000-4000-8000-000000000103",
    repo: "00000000-0000-4000-8000-000000000104",
    selected: "00000000-0000-4000-8000-000000000105",
    busy: "00000000-0000-4000-8000-000000000106",
    waiting: "00000000-0000-4000-8000-000000000107",
    offline: "00000000-0000-4000-8000-000000000108",
  } as const;

  beforeEach(async () => {
    initDb(":memory:");
    await createAgent({ name: "Lead", isLead: true, status: "idle" });
    for (const [name, id] of Object.entries(agents)) {
      const status =
        name === "busy"
          ? "busy"
          : name === "waiting"
            ? "waiting_for_credentials"
            : name === "offline"
              ? "offline"
              : "idle";
      await createAgent({ id, name, isLead: false, status });
    }
  });

  afterEach(() => closeDb());

  async function insertHistoricalTask(input: {
    id: string;
    agentId?: string;
    offeredTo?: string;
    status?: string;
    createdAt: string;
    vcsRepo?: string;
    vcsNumber?: number;
    slackChannelId?: string;
    slackThreadTs?: string;
  }): Promise<void> {
    await getDbClient().run(
      `INSERT INTO agent_tasks (
         id, agentId, offeredTo, task, status, source, createdAt, lastUpdatedAt,
         vcsRepo, vcsNumber, slackChannelId, slackThreadTs
       ) VALUES (?, ?, ?, ?, ?, 'mcp', ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.agentId ?? null,
        input.offeredTo ?? null,
        input.id,
        input.status ?? "completed",
        input.createdAt,
        input.createdAt,
        input.vcsRepo ?? null,
        input.vcsNumber ?? null,
        input.slackChannelId ?? null,
        input.slackThreadTs ?? null,
      ],
    );
  }

  test("round-trips scalar fields, exact worker states, counts, and independent candidates", async () => {
    await insertHistoricalTask({
      id: "same-pr-old",
      agentId: agents.prOld,
      createdAt: "2026-01-02T00:00:00.000Z",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1477,
    });
    await insertHistoricalTask({
      id: "same-pr-latest",
      agentId: agents.prLatest,
      createdAt: "2026-01-02T00:00:00.000Z",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1477,
    });
    await insertHistoricalTask({
      id: "same-thread-latest",
      agentId: agents.thread,
      createdAt: "2026-01-03T00:00:00.000Z",
      slackChannelId: "C1477",
      slackThreadTs: "1477.1",
    });
    await insertHistoricalTask({
      id: "same-repo-latest",
      agentId: agents.repo,
      createdAt: "2026-01-04T00:00:00.000Z",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 999,
    });
    await insertHistoricalTask({
      id: "newer-unassigned",
      createdAt: "2026-01-05T00:00:00.000Z",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1477,
      slackChannelId: "C1477",
      slackThreadTs: "1477.1",
    });
    await insertHistoricalTask({
      id: "busy-in-progress",
      agentId: agents.busy,
      status: "in_progress",
      createdAt: "2026-01-06T00:00:00.000Z",
    });
    await insertHistoricalTask({
      id: "busy-reviewing",
      offeredTo: agents.busy,
      status: "reviewing",
      createdAt: "2026-01-07T00:00:00.000Z",
    });

    const created = await createTaskExtended("Persist routing telemetry", {
      agentId: agents.selected,
      routingReason: "skill",
      routingNote: "Best fit for DB persistence",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1477,
      slackChannelId: "C1477",
      slackThreadTs: "1477.1",
    });
    expect(created).toMatchObject({
      routingReason: "skill",
      routingNote: "Best fit for DB persistence",
    });
    expect(await getTaskById(created.id)).toMatchObject({
      routingReason: "skill",
      routingNote: "Best fit for DB persistence",
    });
    expect(
      await getDbClient().get("SELECT routing_reason, routing_note FROM agent_tasks WHERE id = ?", [
        created.id,
      ]),
    ).toEqual({
      routing_reason: "skill",
      routing_note: "Best fit for DB persistence",
    });

    const decision = await getDecision(created.id);
    expect(decision?.selected_agent_id).toBe(agents.selected);
    expect(new Date(decision!.captured_at).toISOString()).toBe(decision!.captured_at);
    expect(JSON.parse(decision!.continuity_candidates) as ContinuityCandidates).toEqual({
      samePr: { taskId: "same-pr-latest", agentId: agents.prLatest },
      sameThread: { taskId: "same-thread-latest", agentId: agents.thread },
      sameRepo: { taskId: "same-repo-latest", agentId: agents.repo },
    });

    const statuses = JSON.parse(decision!.worker_statuses) as WorkerStatus[];
    expect(statuses).toHaveLength(Object.keys(agents).length);
    expect(statuses.find((worker) => worker.agentId === agents.busy)).toEqual({
      agentId: agents.busy,
      status: "busy",
      activeTaskCount: 2,
      openTaskCount: 2,
    });
    expect(statuses.find((worker) => worker.agentId === agents.waiting)?.status).toBe(
      "waiting_for_credentials",
    );
    expect(statuses.find((worker) => worker.agentId === agents.offline)?.status).toBe("offline");
  });

  test("excludes the new pending task from open counts and survives a snapshot query failure", async () => {
    const existing = await createTaskExtended("Already queued", { agentId: agents.selected });
    const pending = await createTaskExtended("New pending task", {
      agentId: agents.selected,
      routingReason: "continuity",
    });
    const statuses = JSON.parse((await getDecision(pending.id))!.worker_statuses) as WorkerStatus[];
    expect(statuses.find((worker) => worker.agentId === agents.selected)).toMatchObject({
      openTaskCount: 1,
      activeTaskCount: 0,
    });
    expect(pending.status).toBe("pending");
    expect(existing.id).not.toBe(pending.id);

    const client = getDbClient();
    const query = client.query.bind(client);
    const capture = spyOn(client, "query").mockImplementation((sql, params) => {
      if (sql.includes("FROM agents agent")) throw new Error("snapshot query unavailable");
      return query(sql, params);
    });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const created = await createTaskExtended("Survives capture failure", {
        agentId: agents.selected,
        routingReason: "skill",
      });
      expect(await getTaskById(created.id)).not.toBeNull();
      expect(await getDecision(created.id)).toBeNull();
      expect(
        warning.mock.calls.some((call) => String(call[0]).includes("Failed to capture snapshot")),
      ).toBe(true);
    } finally {
      capture.mockRestore();
      warning.mockRestore();
    }
  });

  test("uses offeredTo as the selected target", async () => {
    const offered = await createTaskExtended("Offer telemetry", {
      offeredTo: agents.selected,
      routingReason: "human_pinned",
    });
    expect(offered).toMatchObject({ status: "offered", agentId: null });
    expect((await getDecision(offered.id))?.selected_agent_id).toBe(agents.selected);
  });

  test("captures inherited parent and source thread continuity after inheritance", async () => {
    const parent = await createTaskExtended("Parent context", {
      agentId: agents.prLatest,
      vcsRepo: "desplega-ai/parent-context",
      vcsNumber: 12,
      slackChannelId: "CPARENT",
      slackThreadTs: "12.1",
    });
    const child = await createTaskExtended("Parent continuation", {
      agentId: agents.selected,
      parentTaskId: parent.id,
      routingReason: "continuity",
    });
    expect(JSON.parse((await getDecision(child.id))!.continuity_candidates)).toEqual({
      samePr: { taskId: parent.id, agentId: agents.prLatest },
      sameThread: { taskId: parent.id, agentId: agents.prLatest },
      sameRepo: { taskId: parent.id, agentId: agents.prLatest },
    });

    const source = await createTaskExtended("Source context", {
      agentId: agents.thread,
      slackChannelId: "CSOURCE",
      slackThreadTs: "13.1",
    });
    const sourced = await createTaskExtended("Source continuation", {
      agentId: agents.selected,
      creatorAgentId: agents.selected,
      sourceTaskId: source.id,
      routingReason: "continuity",
    });
    expect(
      (JSON.parse((await getDecision(sourced.id))!.continuity_candidates) as ContinuityCandidates)
        .sameThread,
    ).toEqual({ taskId: source.id, agentId: agents.thread });
  });

  test("samples active counts before insert and ignores a failed snapshot write", async () => {
    await getDbClient().run(`CREATE TRIGGER force_created_task_active
      AFTER INSERT ON agent_tasks
      WHEN NEW.task = 'pre-insert count probe'
      BEGIN
        UPDATE agent_tasks SET status = 'in_progress' WHERE id = NEW.id;
      END`);
    const probe = await createTaskExtended("pre-insert count probe", {
      agentId: agents.selected,
      routingReason: "skill",
    });
    const statuses = JSON.parse((await getDecision(probe.id))!.worker_statuses) as WorkerStatus[];
    expect(statuses.find((worker) => worker.agentId === agents.selected)?.activeTaskCount).toBe(0);
    expect((await getTaskById(probe.id))?.status).toBe("in_progress");

    await getDbClient().run(`CREATE TRIGGER fail_routing_decision_write
      BEFORE INSERT ON routing_decisions
      BEGIN
        SELECT RAISE(FAIL, 'snapshot unavailable');
      END`);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const created = await createTaskExtended("Task survives telemetry failure", {
        agentId: agents.selected,
        routingReason: "overflow",
      });
      expect(await getTaskById(created.id)).not.toBeNull();
      expect(await getDecision(created.id)).toBeNull();
      expect(
        warning.mock.calls.some((call) => String(call[0]).includes("Failed to write snapshot")),
      ).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  test("does not create another snapshot when tracker dedup returns an existing task", async () => {
    const contextKey = "task:trackers:linear:DES-1477";
    const first = await createTaskExtended("First tracker task", {
      contextKey,
      routingReason: "skill",
    });
    const duplicate = await createTaskExtended("Duplicate tracker task", {
      contextKey,
      agentId: agents.selected,
      routingReason: "continuity",
    });
    expect(duplicate.id).toBe(first.id);
    expect(
      await getDbClient().get<{ count: number }>("SELECT COUNT(*) AS count FROM routing_decisions"),
    ).toEqual({ count: 1 });
  });
});
