import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getApprovalRequestById,
  initDb,
  startTask,
} from "../be/db";
import gate from "../be/seed-scripts/catalog/heartbeat-jev-gate";
import { registerRequestHumanInputTool } from "../tools/request-human-input";

const LEAD = "11111111-2222-4333-8444-555555555555";
const NOW = Date.parse("2026-10-15T14:00:00.000Z");
const MMDD = "10-15";

type Fixture = {
  configs: Record<string, string>;
  heartbeatMd?: string;
  prevStatus?: string;
  reportedFailures?: unknown;
  prevOutput?: string | null;
  prevCreatedAt?: string | null;
  failed?: Array<Record<string, unknown>>;
  approvalStatus?: string;
  /** Stands in for `ctx.swarm.systemOne_decide`; returns the bridge result. */
  jev?: (args: Record<string, any>) => Promise<unknown>;
};

function fakeCtx(f: Fixture) {
  const kv = new Map<string, unknown>();
  const calls = {
    prompts: [] as any[],
    kvSets: 0,
    decides: [] as Array<Record<string, any>>,
    approvalReads: 0,
    previousReads: 0,
  };
  const table = (columns: string[], rows: unknown[][]) => ({
    success: true,
    status: 200,
    data: { columns, rows },
  });
  const ctx = {
    swarm: {
      config_get: async (args: { includeSecrets?: boolean }) => {
        if (args.includeSecrets) throw new Error("the gate must never read secret values");
        return {
          success: true,
          status: 200,
          data: {
            configs: Object.entries(f.configs).map(([key, value]) => ({
              key,
              // Secret rows come back masked without includeSecrets.
              value: key.endsWith("_API_KEY") ? "********" : value,
              scope: "global",
            })),
          },
        };
      },
      db_query: async ({ sql, params = [] }: { sql: string; params?: any[] }) => {
        if (sql.includes("FROM approval_requests")) {
          calls.approvalReads++;
          return table(["status"], f.approvalStatus ? [[f.approvalStatus]] : []);
        }
        if (sql.includes("heartbeatMd")) return table(["heartbeatMd"], [[f.heartbeatMd ?? ""]]);
        if (sql.includes("'heartbeat-checklist'") || sql.includes("finishedAt <= ?")) {
          if (sql.includes("'heartbeat-checklist'")) calls.previousReads++;
          // Execute historical selection against real rows, including its bounds and limit.
          const db = new Database(":memory:");
          try {
            db.run(`CREATE TABLE agent_tasks (
              id TEXT, output TEXT, task TEXT, agentId TEXT, taskType TEXT,
              status TEXT, createdAt TEXT, finishedAt TEXT
            )`);
            if (f.prevCreatedAt !== null)
              db.run("INSERT INTO agent_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
                "prev-id",
                f.prevOutput ?? null,
                f.prevStatus ?? "",
                LEAD,
                "heartbeat-checklist",
                "completed",
                f.prevCreatedAt ?? "2026-10-15T13:00:00.000Z",
                null,
              ]);
            for (const failure of f.failed ?? []) {
              db.run("INSERT INTO agent_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
                failure.id,
                null,
                failure.task,
                failure.agentId,
                "test",
                "failed",
                "2026-10-15T06:00:00.000Z",
                failure.finishedAt,
              ]);
            }
            return { data: { rows: db.query(sql).all(...params) } };
          } finally {
            db.close();
          }
        }
        if (sql.includes("completed24")) {
          return table(
            ["inProgress", "pending", "unassigned", "completed24", "failed24"],
            [[3, 1, 0, 40, 2]],
          );
        }
        if (sql.includes("status = 'failed' AND finishedAt")) {
          const rows = (f.failed ?? [])
            .filter((r) => String(r.finishedAt) > params[0])
            .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
            .slice(0, 10);
          return table(
            ["id", "agentId", "task", "failureReason", "finishedAt"],
            rows.map((r) => [r.id, r.agentId, r.task, r.failureReason, r.finishedAt]),
          );
        }
        if (sql.includes("GROUP BY status")) {
          return table(
            ["status", "n"],
            [
              ["idle", 4],
              ["busy", 2],
              ["offline", 5],
            ],
          );
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      kv_getOrNull: async ({ namespace, key }: { namespace: string; key: string }) => {
        if (namespace === "heartbeat-checklist:reported-failures") {
          expect(key).toBe("prev-id");
          return f.reportedFailures === undefined ? null : { key, value: f.reportedFailures };
        }
        return kv.has(key) ? { key, value: kv.get(key) } : null;
      },
      kv_set: async ({ key, value }: { key: string; value: unknown }) => {
        calls.kvSets++;
        kv.set(key, value);
        return { success: true };
      },
      request_humanInput: async (args: unknown) => {
        calls.prompts.push(args);
        return {
          success: true,
          status: 200,
          data: { requestId: "req-1", url: "https://app.example/approval-requests/req-1" },
        };
      },
      systemOne_decide: async (args: Record<string, any>) => {
        calls.decides.push(args);
        if (!f.jev) throw new Error("no Jev stub");
        return f.jev(args);
      },
    },
    stdlib: {
      fetch: async () => {
        throw new Error("the gate must not fetch Jev from the script realm");
      },
    },
  };
  return { ctx, calls, kv };
}

const jevSays = (p: number) => async () => ({
  success: true,
  status: 200,
  data: { success: true, model: "jev-latest", answers: { act: { type: "noul", noul: p } } },
});
const jevFails = (message: string) => async () => ({
  success: true,
  status: 200,
  data: { success: false, message },
});
const run = (ctx: unknown, args: Record<string, unknown> = {}) =>
  gate({ leadAgentId: LEAD, ...args }, ctx) as Promise<any>;

let realNow: typeof Date.now;
beforeAll(() => {
  realNow = Date.now;
  Date.now = () => NOW;
});
afterAll(() => {
  Date.now = realNow;
});

describe("heartbeat-jev-gate with a provider", () => {
  test("quiet below the threshold; Jev is asked through the server, with no credential", async () => {
    const { ctx, calls } = fakeCtx({ configs: { TYPESAFE_API_KEY: "x" }, jev: jevSays(0.12) });
    const verdict = await run(ctx);
    expect(verdict).toEqual({
      quiet: true,
      reason: "jev p(needs action)=0.120 < 0.5 via typesafe",
    });
    expect(calls.decides).toHaveLength(1);
    const args = calls.decides[0]!;
    expect(args.provider).toBe("typesafe");
    expect(args.model).toBe("jev-latest");
    expect(args.questions.act.type).toBe("noul");
    expect(args.timeoutMs).toBe(25_000);
    expect(args.maxRetries).toBe(0);
    expect(JSON.stringify(args)).not.toMatch(/REDACTED|API_KEY|authorization/i);
    expect(calls.prompts).toHaveLength(0);
    expect(calls.kvSets).toBe(0);
  });

  test("wake at or above the threshold, with the new failures and due items in summary", async () => {
    const { ctx } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      reportedFailures: ["aaaaaaaa-0000"],
      heartbeatMd: [
        "# Standing orders",
        `- Watch: release on ${MMDD} — lift after ship`,
        "- Blocker: old thing (DELETE 10-12)",
        "- Future item (DELETE 10-30)",
      ].join("\n"),
      // The previous checklist already listed aaaaaaaa, so only bbbbbbbb is new.
      prevStatus:
        '## Current System Status [auto-generated]\n## Recent Failures (last 6h) [auto-generated]\n- [aaaaaaaa] "old failure" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z\n',
      prevOutput: "All clear.\n\nNothing to do.",
      failed: [
        {
          id: "bbbbbbbb-0000",
          agentId: "87654321-aaaa",
          task: "deploy the thing",
          failureReason: "exit 1",
          finishedAt: "2026-10-15T13:50:00Z",
        },
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "old failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00Z",
        },
      ],
      jev: jevSays(0.5),
    });
    const verdict = await run(ctx, { dryRun: true });
    expect(verdict.quiet).toBe(false);
    expect(verdict.reason).toBe("jev p(needs action)=0.500 >= 0.5 via typesafe");
    expect(verdict.summary).toContain("bbbbbbbb: deploy the thing | exit 1");
    expect(verdict.summary).not.toContain("aaaaaaaa");
    expect(verdict.summary).toContain("(DELETE 10-12)");
    expect(verdict.state).toEqual({
      now: "2026-10-15 14:00 UTC",
      new_failures_since_previous_heartbeat: ["bbbbbbbb: deploy the thing | exit 1"],
      tracked_items_mentioning_today_or_past_delete_date: [
        `- Watch: release on ${MMDD} — lift after ship`,
        "- Blocker: old thing (DELETE 10-12)",
      ],
      previous_heartbeat_result: "All clear. Nothing to do.",
      failures_last_6h_total: 2,
      task_overview:
        "- In Progress: 3 - Pending: 1 - Unassigned: 0 - Completed (24h): 40 - Failed (24h): 2",
      agents: "- Online: 6 (4 idle, 2 busy), Offline: 5",
    });
  });

  test("only a bare MM-DD counts as a due tracked item", async () => {
    const mocked = Date.now;
    Date.now = () => Date.parse("2026-10-20T09:30:00.000Z");
    try {
      const { ctx } = fakeCtx({
        configs: { TYPESAFE_API_KEY: "x" },
        heartbeatMd: [
          "- **2026-10-20 ~10:45Z (heartbeat 2026-10-20):** re-verified, nothing pending",
          "- Watch: 10-20s retry window closed, nothing pending",
          "- Watch: session 4a12-10-20-9e2f finished cleanly, nothing pending",
          "- Watch: release on 10-20 — lift after ship",
        ].join("\n"),
        jev: jevSays(0.9),
      });
      const verdict = await run(ctx, { dryRun: true });
      expect(verdict.state.tracked_items_mentioning_today_or_past_delete_date).toEqual([
        "- Watch: release on 10-20 — lift after ship",
      ]);
    } finally {
      Date.now = mocked;
    }
  });

  for (const ordersFirst of [true, false]) {
    test(`previous failures are not new with standing orders ${ordersFirst ? "before" : "after"} status`, async () => {
      const failures =
        '## Recent Failures (last 6h) [auto-generated]\n- [aaaaaaaa] "old failure" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z\n';
      const orders = "## Your Standing Orders\n- Already triaged.\n";
      const status = `## Current System Status [auto-generated]\n${failures}`;
      const { ctx } = fakeCtx({
        configs: { TYPESAFE_API_KEY: "x" },
        reportedFailures: ["aaaaaaaa-0000"],
        prevStatus: ordersFirst ? orders + status : status + orders,
        failed: [
          {
            id: "aaaaaaaa-0000",
            agentId: "12345678-bbbb",
            task: "old failure",
            failureReason: "boom",
            finishedAt: "2026-10-15T12:00:00Z",
          },
          {
            id: "bbbbbbbb-0000",
            agentId: "12345678-bbbb",
            task: "new failure",
            failureReason: "exit 1",
            finishedAt: "2026-10-15T13:01:00.000Z",
          },
        ],
        jev: jevSays(0.9),
      });
      const verdict = await run(ctx, { dryRun: true });
      expect(verdict.state.new_failures_since_previous_heartbeat).toEqual([
        "bbbbbbbb: new failure | exit 1",
      ]);
      expect(verdict.state.failures_last_6h_total).toBe(2);
    });
  }

  test.each([
    "## Recent Failures (last 6h) [auto-generated]\nNone.\n",
    "",
  ])("failures outside the previous Recent Failures section stay new (%s)", async (section) => {
    const { ctx } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      prevStatus: `## Current System Status [auto-generated]\n${section}## Gate Findings [auto-generated]\n- [aaaaaaaa] "quoted failure" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z\n`,
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "quoted failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T13:01:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toEqual([
      "aaaaaaaa: quoted failure | boom",
    ]);
  });

  test.each([
    "- Item 544: fix `## Recent Failures` parsing.\n",
    "## Recent Failures\nSnapshot notes.\n",
    '## Recent Failures (last 6h) [auto-generated]\n- [bbbbbbbb] "snapshot quote" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z\n',
  ])("snapshot failure headings cannot hijack generated status (%s)", async (snapshot) => {
    const { ctx, calls } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      reportedFailures: ["aaaaaaaa-0000"],
      prevStatus: [
        "## Your Standing Orders (snapshot from HEARTBEAT.md)",
        snapshot,
        "## Instructions",
        "Review the generated status.",
        "## Current System Status [auto-generated]",
        "## Recent Failures (last 6h) [auto-generated]",
        '- [aaaaaaaa] "old failure" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z',
      ].join("\n"),
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "old failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00Z",
        },
        {
          id: "bbbbbbbb-0000",
          agentId: "12345678-bbbb",
          task: "snapshot quote",
          failureReason: "boom",
          finishedAt: "2026-10-15T13:01:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toEqual([
      "bbbbbbbb: snapshot quote | boom",
    ]);
    expect(calls.previousReads).toBe(1);
  });

  test("an absent generated failures section cannot use a trailing snapshot heading", async () => {
    const { ctx, calls } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      prevStatus: [
        "## Current System Status [auto-generated]",
        "## Task Overview [auto-generated]",
        "- Failed (24h): 0",
        "## Agent Status [auto-generated]",
        "- Online: 6",
        "## Your Standing Orders (snapshot from HEARTBEAT.md)",
        "## Recent Failures (last 6h) [auto-generated]",
        '- [aaaaaaaa] "snapshot quote" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z',
      ].join("\n"),
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "snapshot quote",
          failureReason: "boom",
          finishedAt: "2026-10-15T13:01:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toEqual([
      "aaaaaaaa: snapshot quote | boom",
    ]);
    expect(calls.previousReads).toBe(1);
  });

  test("a failed-task title heading does not hide later failures", async () => {
    const { ctx, calls } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      reportedFailures: ["aaaaaaaa-0000", "bbbbbbbb-0000"],
      prevStatus: [
        "## Current System Status [auto-generated]",
        "## Recent Failures (last 6h) [auto-generated]",
        '- [aaaaaaaa] "Fix the task\n## Requirements" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z',
        '- [bbbbbbbb] "later failure" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z',
        "## Gate Findings [auto-generated]",
        '- [cccccccc] "outside failures" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00Z',
      ].join("\n"),
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "Fix the task\n## Requirements",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00Z",
        },
        {
          id: "bbbbbbbb-0000",
          agentId: "12345678-bbbb",
          task: "later failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00Z",
        },
        {
          id: "cccccccc-0000",
          agentId: "12345678-bbbb",
          task: "outside failures",
          failureReason: "boom",
          finishedAt: "2026-10-15T13:01:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    const verdict = await run(ctx, { dryRun: true });
    expect(verdict.state.new_failures_since_previous_heartbeat).toEqual([
      "cccccccc: outside failures | boom",
    ]);
    expect(verdict.state.failures_last_6h_total).toBe(3);
    expect(calls.previousReads).toBe(1);
  });

  test("code-fenced snapshot system and agent markers cannot hide previous failures", async () => {
    const { ctx, calls } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      reportedFailures: ["aaaaaaaa-0000"],
      prevStatus: [
        "## Your Standing Orders (snapshot from HEARTBEAT.md)",
        "```md",
        "## Current System Status [auto-generated]",
        "## Agent Status [auto-generated]",
        "```",
        "## Current System Status [auto-generated]",
        "## Recent Failures (last 6h) [auto-generated]",
        '- [aaaaaaaa] "old failure" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00.000Z',
        "## Agent Status [auto-generated]",
      ].join("\n"),
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "old failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toBe(
      "none",
    );
    expect(calls.previousReads).toBe(1);
  });

  test("a generated Requirements heading in a failed title cannot hide later failures", async () => {
    const { ctx } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      reportedFailures: ["aaaaaaaa-0000", "bbbbbbbb-0000"],
      prevStatus: [
        "## Current System Status [auto-generated]",
        "## Recent Failures (last 6h) [auto-generated]",
        '- [aaaaaaaa] "Fix\n## Requirements [auto-generated]\nbody" — agent: 12345678, reason: boom, at: 2026-10-15T12:00:00.000Z',
        '- [bbbbbbbb] "later failure" — agent: 12345678, reason: boom, at: 2026-10-15T12:01:00.000Z',
        "## Agent Status [auto-generated]",
      ].join("\n"),
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "Fix\n## Requirements [auto-generated]\nbody",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00.000Z",
        },
        {
          id: "bbbbbbbb-0000",
          agentId: "12345678-bbbb",
          task: "later failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:01:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toBe(
      "none",
    );
  });

  test("a failure finished after previous creation stays new even if its ID is quoted", async () => {
    const { ctx } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      prevStatus:
        '## Current System Status [auto-generated]\n## Recent Failures (last 6h) [auto-generated]\n- [aaaaaaaa] "new failure" — agent: 12345678, reason: boom, at: 2026-10-15T13:00:00.001Z',
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "new failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T13:00:00.001Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toEqual([
      "aaaaaaaa: new failure | boom",
    ]);
  });

  test.each([
    { reportedFailures: ["aaaaaaaa-0000"] },
    { reportedFailures: '["aaaaaaaa-0000"]' },
  ])("a failure unseen during gathering stays new before checklist creation (%j)", async ({
    reportedFailures,
  }) => {
    const { ctx } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      reportedFailures,
      prevCreatedAt: "2026-10-15T13:00:00.000Z",
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "reported",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00.000Z",
        },
        {
          id: "bbbbbbbb-0000",
          agentId: "12345678-bbbb",
          task: "unseen",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:59:59.999Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toEqual([
      "bbbbbbbb: unseen | boom",
    ]);
  });

  test.each(
    [undefined, "not JSON", {}, [42]].map((reportedFailures) => ({ reportedFailures })),
  )("missing or invalid receipts treat every current failure as new (%j)", async ({
    reportedFailures,
  }) => {
    const { ctx } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      reportedFailures,
      prevStatus: '## Recent Failures (last 6h) [auto-generated]\n- [aaaaaaaa] "quoted"',
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "still new",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toEqual([
      "aaaaaaaa: still new | boom",
    ]);
  });

  test("without a previous checklist all current failures are new", async () => {
    const { ctx } = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      prevCreatedAt: null,
      failed: [
        {
          id: "aaaaaaaa-0000",
          agentId: "12345678-bbbb",
          task: "first failure",
          failureReason: "boom",
          finishedAt: "2026-10-15T12:00:00.000Z",
        },
      ],
      jev: jevSays(0.9),
    });
    expect((await run(ctx, { dryRun: true })).state.new_failures_since_previous_heartbeat).toEqual([
      "aaaaaaaa: first failure | boom",
    ]);
  });

  test("threshold and time zone come from swarm config", async () => {
    const { ctx } = fakeCtx({
      configs: {
        TYPESAFE_API_KEY: "x",
        HEARTBEAT_JEV_GATE_THRESHOLD: "0.3",
        HEARTBEAT_JEV_GATE_TIMEZONE: "Europe/Madrid",
      },
      jev: jevSays(0.35),
    });
    const verdict = await run(ctx, { dryRun: true });
    expect(verdict.quiet).toBe(false);
    expect(verdict.threshold).toBe(0.3);
    expect(verdict.state.now).toBe("2026-10-15 16:00 Europe/Madrid");
  });

  test("openrouter is used when it is the only key", async () => {
    const { ctx, calls } = fakeCtx({ configs: { OPENROUTER_API_KEY: "x" }, jev: jevSays(0.9) });
    expect((await run(ctx)).reason).toContain("via openrouter");
    expect(calls.decides[0]).toMatchObject({
      provider: "openrouter",
      model: "~typesafe/jev-latest",
    });
  });

  test("a refused decision throws, so the heartbeat records a fail-open error verdict", async () => {
    const refused = fakeCtx({
      configs: { OPENROUTER_API_KEY: "x" },
      jev: jevFails("OPENROUTER_BASE_URL points at a gateway."),
    });
    await expect(run(refused.ctx)).rejects.toThrow(
      "jev openrouter: OPENROUTER_BASE_URL points at a gateway.",
    );

    const bridgeDown = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      jev: async () => ({ success: false, status: 500, data: { error: "boom" } }),
    });
    await expect(run(bridgeDown.ctx)).rejects.toThrow("jev typesafe: boom");

    const malformed = fakeCtx({
      configs: { TYPESAFE_API_KEY: "x" },
      jev: async () => ({ success: true, status: 200, data: { success: true, answers: {} } }),
    });
    await expect(run(malformed.ctx)).rejects.toThrow("no numeric answers.act.noul");
  });

  test("jevTimeoutMs is the server-side time budget", async () => {
    const { ctx, calls } = fakeCtx({ configs: { TYPESAFE_API_KEY: "x" }, jev: jevSays(0.1) });
    await run(ctx, { jevTimeoutMs: 5_000 });
    expect(calls.decides[0]!.timeoutMs).toBe(5_000);
  });
});

describe("heartbeat-jev-gate without a provider", () => {
  const inactive = (verdict: any) => {
    expect(verdict.quiet).toBe(false);
    expect(verdict.reason).toStartWith("jev-gate inactive:");
    expect(verdict.summary).toBeUndefined();
  };

  test("first run asks exactly once; pending ticks never ask again", async () => {
    const f: Fixture = { configs: {}, approvalStatus: "pending" };
    const { ctx, calls, kv } = fakeCtx(f);

    const first = await run(ctx);
    inactive(first);
    expect(first.reason).toContain("asked a human (approval request req-1)");
    expect(calls.prompts).toHaveLength(1);
    const prompt = calls.prompts[0];
    expect(prompt.detached).toBe(true);
    expect(prompt.questions[0].type).toBe("approval");
    expect(prompt.questions[0].description).toContain("TYPESAFE_API_KEY");
    expect(prompt.questions[0].description).toContain("OPENROUTER_API_KEY");
    expect(prompt.questions[0].description).toContain("$0.00004");
    expect(kv.get("setup")).toMatchObject({ status: "asked", requestId: "req-1" });

    const second = await run(ctx);
    inactive(second);
    expect(second.reason).toContain("awaiting answer");
    expect(calls.prompts).toHaveLength(1);
    expect(calls.decides).toHaveLength(0);
  });

  test("a rejection is stored as declined; later ticks neither ask nor poll", async () => {
    const f: Fixture = { configs: {}, approvalStatus: "pending" };
    const { ctx, calls, kv } = fakeCtx(f);
    await run(ctx);
    f.approvalStatus = "rejected";
    inactive(await run(ctx));
    expect(kv.get("setup")).toMatchObject({ status: "declined" });
    const reads = calls.approvalReads;

    const later = await run(ctx);
    inactive(later);
    expect(later.reason).toContain("declined");
    expect(calls.approvalReads).toBe(reads);
    expect(calls.prompts).toHaveLength(1);
  });

  test("approved without a key waits; an expired request stops asking", async () => {
    const approved = fakeCtx({ configs: {}, approvalStatus: "approved" });
    await run(approved.ctx);
    const waiting = await run(approved.ctx);
    inactive(waiting);
    expect(waiting.reason).toContain("approved, waiting for");
    expect(approved.calls.prompts).toHaveLength(1);

    const expired = fakeCtx({ configs: {}, approvalStatus: "cancelled" });
    await run(expired.ctx);
    inactive(await run(expired.ctx));
    expect(expired.kv.get("setup")).toMatchObject({ status: "expired" });
    expect(expired.calls.prompts).toHaveLength(1);
  });

  test("declined, then a key appears: the gate resumes with no human step", async () => {
    const f: Fixture = { configs: {}, approvalStatus: "rejected", jev: jevSays(0.2) };
    const { ctx, calls } = fakeCtx(f);
    await run(ctx);
    inactive(await run(ctx));
    f.configs.TYPESAFE_API_KEY = "x";
    const verdict = await run(ctx);
    expect(verdict.quiet).toBe(true);
    expect(verdict.reason).toContain("via typesafe");
    expect(calls.prompts).toHaveLength(1);
  });

  test("dryRun returns the prompt and state without asking or writing KV", async () => {
    const { ctx, calls } = fakeCtx({ configs: {} });
    const verdict = await run(ctx, { dryRun: true });
    inactive(verdict);
    expect(verdict.dryRun).toBe(true);
    expect(verdict.prompt.title).toContain("Jev");
    expect(verdict.state.agents).toBe("- Online: 6 (4 idle, 2 busy), Offline: 5");
    expect(calls.prompts).toHaveLength(0);
    expect(calls.kvSets).toBe(0);
  });
});

describe("request-human-input detached", () => {
  beforeAll(() => initDb(":memory:"));
  afterAll(() => closeDb());

  test("a detached request is not attached to the agent's current task", async () => {
    const server = new McpServer({ name: "jev-gate-hitl", version: "1" });
    registerRequestHumanInputTool(server);
    const tool = (server as any)._registeredTools["request-human-input"];
    const agent = await createAgent({ name: "jev-gate-lead", isLead: true, status: "idle" });
    const task = await createTaskExtended("unrelated lead work", {
      agentId: agent.id,
      source: "mcp",
      slackChannelId: "C_UNRELATED",
      slackThreadTs: "1.000",
    });
    await startTask(task.id);
    const extra = { sessionId: "s", requestInfo: { headers: { "x-agent-id": agent.id } } };
    const questions = [{ id: "q", type: "approval", label: "ok?" }];

    const attached = await tool.handler({ title: "a", questions }, extra);
    const detached = await tool.handler({ title: "d", questions, detached: true }, extra);

    const a = await getApprovalRequestById(attached.structuredContent.requestId);
    const d = await getApprovalRequestById(detached.structuredContent.requestId);
    expect(a?.sourceTaskId).toBe(task.id);
    expect(d?.sourceTaskId).toBeNull();
  });
});
