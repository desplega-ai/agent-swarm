import type { SwarmTask } from "../../src/types.ts";
import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";
import { toolRouting } from "../tool-routing.ts";

/**
 * Reference: the worker recalls the Alpha handoff conventions from memory, lists
 * the completed tasks in the seeded history (the same 20-row dump as sql-audit;
 * 12 are `completed`, the highest-priority one is "Rotate the payments service
 * API keys" at 95), checkpoints the count under `alpha/checkpoint` in its own KV
 * namespace, sends exactly one phase-two follow-up naming that task, and
 * completes through store-progress with the outputSchema JSON. Tools run in the
 * causal order the scenario grades: recall, look up, checkpoint, delegate, complete.
 *
 * The seeded history rows ride in the context as `origin: "seed"` tasks with no
 * creator or parent, as in a live attempt, so the follow-up filter has to tell
 * them apart from the one task the worker spawned. The null agent leaves an empty
 * result, so the output and structured-output gates fail on their own.
 */

/** Completed rows of the seeded history: [id suffix, title, priority]. The other 8 rows are failed/cancelled. */
const COMPLETED_HISTORY: [string, string, number][] = [
  ["01", "Provision staging Postgres replica", 40],
  ["02", "Rotate the payments service API keys", 95],
  ["03", "Backfill user_events partition for April", 55],
  ["04", "Tune the search relevance ranker", 60],
  ["05", "Migrate billing webhooks to the v3 endpoint", 70],
  ["07", "Patch the CVE-2026-1188 in the image base", 90],
  ["09", "Enable mTLS on the internal mesh", 80],
  ["0c", "Add idempotency keys to the order API", 65],
  ["0e", "Wire up the on-call escalation policy", 75],
  ["18", "Harden the SSH bastion configuration", 78],
  ["1c", "Failover the primary database to the standby", 92],
  ["1d", "Renew the wildcard TLS certificate", 82],
];

const TOP_TITLE = "Rotate the payments service API keys";
const ROOT_TASK_ID = "task-0";
const WORKER_ID = "worker-0";
const KV_NAMESPACE = `task:agent:${WORKER_ID}`;
const TOOL = (name: string) => `mcp__agent-swarm__${name}`;

const memoryHits = toolRouting.seed?.memories ?? [];

const checkpointValue = { phase: 1, completed: COMPLETED_HISTORY.length, topTask: TOP_TITLE };

const completionOutput = JSON.stringify({
  alphaSummary: `${COMPLETED_HISTORY.length} phase-one tasks completed; highest-priority completed task: ${TOP_TITLE} (priority 95)`,
  checkpointKey: "alpha/checkpoint",
  followUpCreated: true,
});

/** The seeded history as the runner lists it: no creator, no parent, `origin: "seed"`. */
function seedRows(): SwarmTask[] {
  return COMPLETED_HISTORY.map(([suffix, title, priority]) => ({
    id: `aud17a48-c000-4000-a000-0000000000${suffix}`,
    title,
    description: title,
    status: "completed",
    priority,
    origin: "seed" as const,
  }));
}

function referenceLogs(): Record<string, Record<string, unknown>[]> {
  return {
    [ROOT_TASK_ID]: [
      ...toolCallRows(
        ROOT_TASK_ID,
        TOOL("memory-search"),
        { query: "Project Alpha handoff conventions" },
        { results: memoryHits.map((content, i) => ({ id: `mem-${i}`, content })) },
        "toolu_memory",
      ),
      ...toolCallRows(
        ROOT_TASK_ID,
        TOOL("get-tasks"),
        { status: "completed" },
        {
          total: COMPLETED_HISTORY.length,
          tasks: COMPLETED_HISTORY.map(([suffix, title, priority]) => ({
            id: `aud17a48-c000-4000-a000-0000000000${suffix}`,
            task: title,
            status: "completed",
            priority,
          })),
        },
        "toolu_lookup",
      ),
      ...toolCallRows(
        ROOT_TASK_ID,
        TOOL("kv-set"),
        { key: "alpha/checkpoint", value: checkpointValue },
        { success: true, namespace: KV_NAMESPACE },
        "toolu_kv",
      ),
      ...toolCallRows(
        ROOT_TASK_ID,
        TOOL("send-task"),
        {
          task: `Project Alpha phase two. Start from the highest-priority completed phase-one task: ${TOP_TITLE} (priority 95). Phase one finished ${COMPLETED_HISTORY.length} completed tasks; checkpoint is in KV under alpha/checkpoint.`,
        },
        { success: true, task: { id: "followup-0", status: "pending" } },
        "toolu_send",
      ),
      ...toolCallRows(
        ROOT_TASK_ID,
        TOOL("store-progress"),
        { status: "completed", output: completionOutput },
        { success: true },
        "toolu_done",
      ),
    ],
  };
}

export const fixture: GraderFixture = {
  reference: () => {
    const [root] = nullTasks(toolRouting);
    return makeContext(toolRouting, {
      tasks: [
        {
          ...(root as NonNullable<typeof root>),
          agentId: WORKER_ID,
          contextKey: KV_NAMESPACE,
          result: completionOutput,
          output: completionOutput,
        },
        {
          id: "followup-0",
          title: "Project Alpha phase two",
          description: `Project Alpha phase two. Start from the highest-priority completed phase-one task: ${TOP_TITLE} (priority 95). Phase one finished ${COMPLETED_HISTORY.length} completed tasks; checkpoint is in KV under alpha/checkpoint.`,
          status: "pending",
          parentTaskId: ROOT_TASK_ID,
          creatorAgentId: WORKER_ID,
          origin: "run",
        },
        ...seedRows(),
      ],
      logs: referenceLogs(),
      api: {
        // The worker's own namespace (its task's contextKey); a bare /api/kv would list the judge's.
        [`/api/kv/_/${encodeURIComponent(KV_NAMESPACE)}`]: {
          entries: [{ key: "alpha/checkpoint", value: checkpointValue }],
        },
      },
    });
  },
  // The null agent still sees the seeded history in ctx.tasks (and its own task is assigned to
  // the worker, so agentId is set); nothing else. The follow-up filter must not count seed rows.
  nullContext: () => {
    const [root] = nullTasks(toolRouting);
    return makeContext(toolRouting, {
      tasks: [{ ...(root as NonNullable<typeof root>), agentId: WORKER_ID }, ...seedRows()],
    });
  },
  notes:
    "Seed history is the sql-audit dump (12 completed of 20); only the completed rows are modelled.",
};
