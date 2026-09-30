import type { SwarmTask } from "../../src/types.ts";
import { type GraderFixture, makeContext, nullTasks } from "../grader-validation-support.ts";
import { humanInLoop, humanInLoopSolo, __test__ as key } from "../human-in-loop.ts";

/**
 * Reference: the lead asks the requester which customers, which fields and
 * which format before anything is exported, ends its task, gets the canned
 * answer as a hitl-follow-up task, and only then sends the analyst the export
 * job. The analyst writes the EU customers (id, name, plan) as JSON.
 *
 * The solo reference is the analyst asking and exporting on its own.
 */

const LEAD = "lead";
const T0 = Date.UTC(2026, 8, 30, 10, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

export const EXPORT = JSON.stringify(
  key.CUSTOMERS.filter((c) => c[2] === "EU").map(([id, name, , , plan]) => ({ id, name, plan })),
  null,
  2,
);

export function requestsApi(opts: { createdAt?: number; resolvedAt?: number | null } = {}) {
  return {
    "/api/approval-requests?limit=100": {
      approvalRequests: [
        {
          id: "req-1",
          title: "Northwind export: scope",
          sourceTaskId: "task-0",
          status: "approved",
          questions: [
            {
              id: "scope",
              type: "text",
              label: "Which customers and which fields may Northwind receive, and in what format?",
            },
          ],
          createdAt: at(opts.createdAt ?? 20),
          resolvedAt: opts.resolvedAt === null ? null : at(opts.resolvedAt ?? 25),
        },
      ],
    },
  };
}

export function followUp(agentId: string, status = "completed"): SwarmTask {
  return {
    id: "follow-up-1",
    title: "Human answered",
    description: `Approval request answered: ${key.REPLY}`,
    status,
    agentId,
    taskType: "hitl-follow-up",
    parentTaskId: "task-0",
    result: "Continued with the answer.",
    createdAt: at(25),
    finishedAt: at(200),
    origin: "run",
  };
}

export function exportJob(createdAt: number): SwarmTask {
  return {
    id: "export-job",
    title: "Export EU customers",
    description:
      "Export the EU customers as JSON (id, name, plan) to /workspace/export/customers.json. No emails.",
    status: "completed",
    agentId: `worker-${key.ANALYST}`,
    creatorAgentId: LEAD,
    parentTaskId: "follow-up-1",
    result: "Wrote 5 records.",
    createdAt: at(createdAt),
    finishedAt: at(createdAt + 60),
    origin: "run",
  };
}

const [leadSeed] = nullTasks(humanInLoop);
const [soloSeed] = nullTasks(humanInLoopSolo);

export function loopContext(
  opts: { children?: SwarmTask[]; api?: Record<string, unknown>; exportJson?: string | null } = {},
) {
  const exportJson = opts.exportJson === undefined ? EXPORT : opts.exportJson;
  return makeContext(humanInLoop, {
    tasks: [
      { ...(leadSeed as SwarmTask), agentId: LEAD, result: "Asked the requester." },
      ...(opts.children ?? [followUp(LEAD), exportJob(30)]),
    ],
    api: opts.api ?? requestsApi(),
    files: exportJson === null ? {} : { [`w${key.ANALYST}:${key.EXPORT_FILE}`]: exportJson },
  });
}

export const fixture: GraderFixture = {
  reference: () => loopContext(),
};

export const soloFixture: GraderFixture = {
  reference: () =>
    makeContext(humanInLoopSolo, {
      tasks: [
        { ...(soloSeed as SwarmTask), agentId: "worker-0", result: "Asked the requester." },
        followUp("worker-0"),
      ],
      api: requestsApi(),
      files: { [`w0:${key.EXPORT_FILE}`]: EXPORT },
    }),
};
