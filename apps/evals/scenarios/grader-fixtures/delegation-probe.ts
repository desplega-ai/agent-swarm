import { delegationProbe } from "../delegation-probe.ts";
import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";

/**
 * Reference: a lead that follows the mandate. It delegates one shard to each
 * researcher (alpha audits `completed`, beta audits `failed` + `cancelled`),
 * never queries the tasks API or runs SQL itself, waits for the two workers and
 * the system follow-ups they trigger, then merges their reports into
 * /workspace/audit/merged-report.md on its own sandbox. Answer key (seeded
 * history in fixtures/delegation-probe-history.sql): 11 completed, 5 failed,
 * 4 cancelled, top-priority completed task "Provision the analytics warehouse
 * cluster" (priority 94). The null agent completes the lead task without
 * spawning children or writing the report, so the report gate must fail.
 *
 * Roster from `makeContext`: worker-0 = researcher-alpha, worker-1 =
 * researcher-beta, lead at index 2 with agentId "lead". Runtime-spawned tasks
 * deliberately avoid the `task-` id prefix: only `task-0` is an upfront task.
 */

const LEAD = "lead";
const REPORT_FILE = "/workspace/audit/merged-report.md";

const ALPHA_RESULT = [
  "Audit of the `completed` shard done from the tasks API.",
  "Tasks with status completed: 11.",
  "Highest-priority completed task (priority 94): Provision the analytics warehouse cluster",
].join("\n");

const BETA_RESULT = [
  "Audit of the `failed` and `cancelled` shard done from the tasks API.",
  "Tasks with status failed: 5.",
  "Tasks with status cancelled: 4.",
].join("\n");

const MERGED_REPORT = [
  "# Merged audit report",
  "",
  "## researcher-alpha (completed shard)",
  "- completed tasks: 11",
  "- highest-priority completed task: Provision the analytics warehouse cluster (priority 94)",
  "",
  "## researcher-beta (failed and cancelled shard)",
  "- failed tasks: 5",
  "- cancelled tasks: 4",
  "",
  "## Merged grand total",
  "- 20 audited tasks (11 completed + 5 failed + 4 cancelled).",
].join("\n");

const [seedTask] = nullTasks(delegationProbe);

/** The lead's upfront seed task, completed with a summary of what it delegated. */
function leadTask() {
  return {
    ...(seedTask as NonNullable<typeof seedTask>),
    agentId: LEAD,
    result: `Delegated the audit to both researchers and merged their reports into ${REPORT_FILE}.`,
  };
}

/** A child task the lead created for one researcher, completed with its report. */
function childTask(id: string, workerAgentId: string, title: string, result: string) {
  return {
    id,
    title,
    description: `${title}. Report the counts and titles back from the API data.`,
    status: "completed",
    agentId: workerAgentId,
    creatorAgentId: LEAD,
    parentTaskId: "task-0",
    result,
    origin: "run" as const,
  };
}

/** The system follow-up the swarm hands the lead when a child task completes. */
function followUpTask(id: string, childId: string) {
  return {
    id,
    title: `Follow-up: ${childId} completed`,
    description: "A task you delegated has completed. Review its output.",
    status: "completed",
    agentId: LEAD,
    source: "system",
    taskType: "follow-up",
    parentTaskId: childId,
    result: "Acknowledged the worker report.",
    origin: "run" as const,
  };
}

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(delegationProbe, {
      tasks: [
        leadTask(),
        childTask("child-alpha", "worker-0", "Audit the completed tasks", ALPHA_RESULT),
        childTask("child-beta", "worker-1", "Audit the failed and cancelled tasks", BETA_RESULT),
        followUpTask("followup-alpha", "child-alpha"),
        followUpTask("followup-beta", "child-beta"),
      ],
      files: { [`w2:${REPORT_FILE}`]: MERGED_REPORT },
      logs: {
        // The lead orchestrates: two send-task calls, reads the workers' output,
        // writes the merged report. No tasks-API query, no SQL.
        "task-0": [
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__send-task",
            {
              task: "Audit the completed tasks and report the count and top-priority title.",
              agentId: "worker-0",
            },
            { success: true, task: { id: "child-alpha" } },
            "toolu_send_alpha",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__send-task",
            {
              task: "Audit the failed and cancelled tasks and report both counts.",
              agentId: "worker-1",
            },
            { success: true, task: { id: "child-beta" } },
            "toolu_send_beta",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__get-task-details",
            { taskId: "child-alpha" },
            { task: { id: "child-alpha", status: "completed", output: ALPHA_RESULT } },
            "toolu_details_alpha",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__get-task-details",
            { taskId: "child-beta" },
            { task: { id: "child-beta", status: "completed", output: BETA_RESULT } },
            "toolu_details_beta",
          ),
          ...toolCallRows(
            "task-0",
            "Write",
            { file_path: REPORT_FILE, content: MERGED_REPORT },
            "File created successfully",
            "toolu_write_report",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__store-progress",
            { status: "completed", output: "Merged audit report written." },
            { success: true },
            "toolu_progress_lead",
          ),
        ],
        // The researchers each query the seeded history for their own shard.
        "child-alpha": [
          ...toolCallRows(
            "child-alpha",
            "mcp__agent-swarm__get-tasks",
            { status: "completed" },
            { total: 11 },
            "toolu_alpha_completed",
          ),
          ...toolCallRows(
            "child-alpha",
            "mcp__agent-swarm__store-progress",
            { status: "completed", output: ALPHA_RESULT },
            { success: true },
            "toolu_progress_alpha",
          ),
        ],
        "child-beta": [
          ...toolCallRows(
            "child-beta",
            "mcp__agent-swarm__get-tasks",
            { status: "failed" },
            { total: 5 },
            "toolu_beta_failed",
          ),
          ...toolCallRows(
            "child-beta",
            "mcp__agent-swarm__get-tasks",
            { status: "cancelled" },
            { total: 4 },
            "toolu_beta_cancelled",
          ),
          ...toolCallRows(
            "child-beta",
            "mcp__agent-swarm__store-progress",
            { status: "completed", output: BETA_RESULT },
            { success: true },
            "toolu_progress_beta",
          ),
        ],
      },
    }),
};
