import { describe, expect, it } from "bun:test";
import { SwarmClient } from "../swarm/client.ts";
import type { SwarmTask } from "../types.ts";
import { classifyTaskOrigin } from "./index.ts";

/**
 * Automated QA for Plan A §Phase 1 runtime-spawned-task enumeration. The merge
 * itself is inline in runner/index.ts (after the upfront-task await loop); this
 * test exercises the SAME algorithm against a synthetic full-task list so we can
 * assert the behavior without booting an E2B stack:
 *
 *   - 1 upfront LEAD task (the scenario's `worker:"lead"` task)
 *   - 2 child tasks delegated by the lead (creatorAgentId=lead, parentTaskId=lead task)
 *   - 2 auto follow-ups (taskType="follow-up", source="system")
 *
 * Expectation: all 5 land in ctx.tasks (the upfront set was just the 1 lead task).
 */

const LEAD_AGENT = "agent-lead";
const WORKER_A = "agent-worker-a";
const WORKER_B = "agent-worker-b";
const LEAD_TASK_ID = "task-lead-0";

/** The full /api/tasks?fields=full set the fresh-DB attempt would return. */
function fixtureFullTaskList(): SwarmTask[] {
  return [
    {
      id: LEAD_TASK_ID,
      title: "Audit the task history",
      description: "Delegate to your two researchers and merge their reports.",
      status: "completed",
      agentId: LEAD_AGENT,
    },
    {
      id: "task-child-a",
      title: "Research shard A",
      description: "Count completed tasks.",
      status: "completed",
      agentId: WORKER_A,
      creatorAgentId: LEAD_AGENT,
      parentTaskId: LEAD_TASK_ID,
    },
    {
      id: "task-child-b",
      title: "Research shard B",
      description: "Count failed tasks.",
      status: "completed",
      agentId: WORKER_B,
      creatorAgentId: LEAD_AGENT,
      parentTaskId: LEAD_TASK_ID,
    },
    {
      id: "task-followup-a",
      title: "Follow-up on shard A",
      description: "Worker A completed — review.",
      status: "completed",
      agentId: LEAD_AGENT,
      taskType: "follow-up",
      source: "system",
      parentTaskId: "task-child-a",
    },
    {
      id: "task-followup-b",
      title: "Follow-up on shard B",
      description: "Worker B completed — review.",
      status: "completed",
      agentId: LEAD_AGENT,
      taskType: "follow-up",
      source: "system",
      parentTaskId: "task-child-b",
    },
  ];
}

/**
 * Replicate the runner's inline merge (runner/index.ts): start from the upfront
 * `tasks`, fetch the full list via `client.listAllTasks()`, append every task
 * not already tracked by id.
 */
async function mergeSpawnedTasks(
  upfront: SwarmTask[],
  client: Pick<SwarmClient, "listAllTasks">,
): Promise<SwarmTask[]> {
  const ctxTasks: SwarmTask[] = [...upfront];
  const knownIds = new Set(upfront.map((t) => t.id));
  const allTasks = await client.listAllTasks();
  const spawned = allTasks.filter((t) => t.id && !knownIds.has(t.id));
  ctxTasks.push(...spawned);
  return ctxTasks;
}

describe("runtime-spawned-task enumeration (Plan A §Phase 1)", () => {
  it("merges lead-delegated children + follow-ups into ctx.tasks (1 upfront → 5 total)", async () => {
    const upfront: SwarmTask[] = [
      {
        id: LEAD_TASK_ID,
        title: "Audit the task history",
        description: "Delegate to your two researchers and merge their reports.",
        status: "completed",
        agentId: LEAD_AGENT,
      },
    ];

    // Stub a SwarmClient whose listAllTasks returns the fresh-DB full set.
    const client = new SwarmClient("http://stub", "key");
    client.listAllTasks = async () => fixtureFullTaskList();

    const ctxTasks = await mergeSpawnedTasks(upfront, client);

    expect(ctxTasks).toHaveLength(5);
    const ids = ctxTasks.map((t) => t.id).sort();
    expect(ids).toEqual(
      ["task-child-a", "task-child-b", "task-followup-a", "task-followup-b", LEAD_TASK_ID].sort(),
    );

    // The delegation artifacts are now visible to scoring with their fields intact.
    const children = ctxTasks.filter(
      (t) => t.creatorAgentId === LEAD_AGENT && t.parentTaskId === LEAD_TASK_ID,
    );
    expect(children).toHaveLength(2);

    const followUps = ctxTasks.filter((t) => t.taskType === "follow-up" && t.source === "system");
    expect(followUps).toHaveLength(2);
  });

  it("dedupes by id so an upfront task already present in the list isn't doubled", async () => {
    const upfront = fixtureFullTaskList().slice(0, 1); // lead task already in the full list
    const client = new SwarmClient("http://stub", "key");
    client.listAllTasks = async () => fixtureFullTaskList();

    const ctxTasks = await mergeSpawnedTasks(upfront, client);
    expect(ctxTasks).toHaveLength(5);
    expect(ctxTasks.filter((t) => t.id === LEAD_TASK_ID)).toHaveLength(1);
  });
});

/**
 * Run-vs-seed classification (the run-details artifact tag — display-only, scoring
 * never reads it). Mirrors the delegation-probe shape: 5 REAL run tasks (1 upfront
 * lead + 2 lead-delegated children + 2 follow-ups) sharing the run's agent ids,
 * plus 20 SEED audit-history rows the scenario seeded into the same swarm DB BEFORE
 * the run's agents existed (no run agent id, not in the upfront set). The predicate
 * must tag exactly the 5 as "run" and all 20 as "seed".
 */
describe("classifyTaskOrigin — run-vs-seed (display-only)", () => {
  const RUN_AGENT_IDS = new Set([LEAD_AGENT, WORKER_A, WORKER_B]);
  const UPFRONT_IDS = new Set([LEAD_TASK_ID]);

  /** 20 pre-existing fixture rows: pre-run agents, not in the upfront set. */
  function seedHistory(): SwarmTask[] {
    return Array.from({ length: 20 }, (_, i) => ({
      id: `seed-task-${String(i)}`,
      title: `Seeded audit row ${String(i)}`,
      description: "Reference data the scenario audits.",
      status: i % 3 === 0 ? "failed" : "completed",
      // Created by a pre-run seeder agent + assigned to a pre-run agent — NEITHER is
      // a run agent id, so the predicate must classify these as seed.
      agentId: `seed-agent-${String(i % 4)}`,
      creatorAgentId: "seed-agent-orchestrator",
    }));
  }

  it("tags the 5 run tasks as run and all 20 seed rows as seed", () => {
    const tasks = [...fixtureFullTaskList(), ...seedHistory()];
    expect(tasks).toHaveLength(25);

    const tagged = tasks.map((t) => ({
      id: t.id,
      origin: classifyTaskOrigin(t, UPFRONT_IDS, RUN_AGENT_IDS),
    }));

    const runTagged = tagged.filter((t) => t.origin === "run");
    const seedTagged = tagged.filter((t) => t.origin === "seed");
    expect(runTagged).toHaveLength(5);
    expect(seedTagged).toHaveLength(20);
    expect(runTagged.map((t) => t.id).sort()).toEqual(
      ["task-child-a", "task-child-b", "task-followup-a", "task-followup-b", LEAD_TASK_ID].sort(),
    );
    expect(seedTagged.every((t) => t.id.startsWith("seed-task-"))).toBe(true);
  });

  it("tags an upfront task as run even when no agent id is attributed", () => {
    // An upfront task whose agentId/creatorAgentId never landed (e.g. still pending)
    // is still a run task purely by virtue of being in the upfront set.
    const orphan: SwarmTask = {
      id: LEAD_TASK_ID,
      title: "Upfront",
      description: "",
      status: "pending",
    };
    expect(classifyTaskOrigin(orphan, UPFRONT_IDS, RUN_AGENT_IDS)).toBe("run");
  });

  it("tags a run-agent-created task as run even when its id is unknown upfront", () => {
    // A lead-delegated child: not in the upfront set, but creatorAgentId is a run agent.
    const child: SwarmTask = {
      id: "task-child-x",
      title: "Delegated",
      description: "",
      status: "completed",
      creatorAgentId: LEAD_AGENT,
    };
    expect(classifyTaskOrigin(child, UPFRONT_IDS, RUN_AGENT_IDS)).toBe("run");
  });

  it("is defensive when delegation fields are absent / non-string", () => {
    const weird = {
      id: "weird-1",
      title: "",
      description: "",
      status: "completed",
      creatorAgentId: 42, // non-string via the index signature
      agentId: null,
    } as unknown as SwarmTask;
    expect(classifyTaskOrigin(weird, UPFRONT_IDS, RUN_AGENT_IDS)).toBe("seed");
  });
});
