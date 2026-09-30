import { delegationChain } from "../delegation-chain.ts";
import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";

/**
 * Reference: a lead that follows the mandate. It never queries the task history
 * or runs SQL itself. It creates three worker tasks as a strict linear chain
 * with dependsOn (phase-one counts the completed tasks, phase-two depends on it
 * and finds the highest-priority completed task, phase-three depends on that and
 * finds the planted anomaly), waits for the chain, then merges the three results
 * into /workspace/delegation-chain/final-report.md on its own sandbox. Every
 * worker answers from the tasks API, so each child session shows real tool use.
 *
 * Answer key (seeded history in fixtures/delegation-chain-history.sql): 10
 * completed tasks; top-priority completed task "Cut over the ledger service to
 * the new region" (priority 97); anomaly "Roll out the new pricing engine to EU
 * customers" (status failed, output claims success). The null agent completes
 * the lead task without spawning children or writing the report, so the report
 * gate must fail.
 *
 * Roster from `makeContext`, with the boot names the runner attaches: worker-0 =
 * phase-one, worker-1 = phase-two, worker-2 = phase-three, lead at index 3 with
 * agentId "lead". Runtime-spawned tasks avoid the `task-` id prefix: only
 * `task-0` is an upfront task.
 */

const LEAD = "lead";
const REPORT_FILE = "/workspace/delegation-chain/final-report.md";

const PHASE_ONE_TASK =
  "Phase one: count the tasks with status completed in the task history and report the number.";
const PHASE_TWO_TASK =
  "Phase two: the phase-one count of completed tasks is in your dependency. Identify the highest-priority completed task in the task history and report its title and priority.";
const PHASE_THREE_TASK =
  "Phase three: using the phase-two result, check the task history for the planted anomaly, a task whose status contradicts its output, and report it.";

const PHASE_ONE_RESULT = "10 tasks have status completed (18 tasks in the history in total).";
const PHASE_TWO_RESULT =
  'Highest-priority completed task: "Cut over the ledger service to the new region" (priority 97).';
const PHASE_THREE_RESULT = [
  'Anomaly: "Roll out the new pricing engine to EU customers" has status failed,',
  'yet its output claims "Rollout succeeded".',
].join(" ");

const FINAL_REPORT = [
  "# Delegation chain: final report",
  "",
  "Merged from the three chained worker tasks.",
  "",
  `1. Phase one (count): ${PHASE_ONE_RESULT}`,
  `2. Phase two (top priority): ${PHASE_TWO_RESULT}`,
  `3. Phase three (anomaly): ${PHASE_THREE_RESULT}`,
].join("\n");

const [seedTask] = nullTasks(delegationChain);

/** The lead's upfront task, completed with a summary of the chain it ran. */
function leadTask() {
  return {
    ...(seedTask as NonNullable<typeof seedTask>),
    agentId: LEAD,
    result: `Ran the three-phase chain through the workers and merged the results into ${REPORT_FILE}.`,
  };
}

/** A child task the lead created for one phase worker, completed with its answer. */
function childTask(
  id: string,
  workerAgentId: string,
  title: string,
  description: string,
  result: string,
  dependsOn?: string,
) {
  return {
    id,
    title,
    description,
    status: "completed",
    agentId: workerAgentId,
    creatorAgentId: LEAD,
    parentTaskId: "task-0",
    ...(dependsOn ? { dependsOn: [dependsOn] } : {}),
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
    result: "Acknowledged the worker result.",
    origin: "run" as const,
  };
}

/** A worker's session: read the task history through the tasks API, then report. */
function workerSession(taskId: string, args: Record<string, unknown>, result: string) {
  return [
    ...toolCallRows(
      taskId,
      "mcp__agent-swarm__get-tasks",
      args,
      { tasks: [], total: 18 },
      `toolu_${taskId}_read`,
    ),
    ...toolCallRows(
      taskId,
      "mcp__agent-swarm__store-progress",
      { taskId, status: "completed", output: result },
      { success: true },
      `toolu_${taskId}_done`,
    ),
  ];
}

/** One `send-task` call by the lead for a chain hop. */
function sendTask(
  callId: string,
  agentId: string,
  task: string,
  childId: string,
  dependsOn?: string,
) {
  return toolCallRows(
    "task-0",
    "mcp__agent-swarm__send-task",
    { task, agentId, ...(dependsOn ? { dependsOn: [dependsOn] } : {}) },
    { success: true, task: { id: childId } },
    callId,
  );
}

export const fixture: GraderFixture = {
  reference: () => {
    const ctx = makeContext(delegationChain, {
      // The runner puts the upfront lead task first, then the spawned tasks in the
      // order the swarm API lists them: lastUpdatedAt DESC, newest first.
      tasks: [
        leadTask(),
        followUpTask("followup-phase-three", "child-phase-three"),
        followUpTask("followup-phase-two", "child-phase-two"),
        followUpTask("followup-phase-one", "child-phase-one"),
        childTask(
          "child-phase-three",
          "worker-2",
          "Phase three: find the anomaly",
          PHASE_THREE_TASK,
          PHASE_THREE_RESULT,
          "child-phase-two",
        ),
        childTask(
          "child-phase-two",
          "worker-1",
          "Phase two: find the top-priority completed task",
          PHASE_TWO_TASK,
          PHASE_TWO_RESULT,
          "child-phase-one",
        ),
        childTask(
          "child-phase-one",
          "worker-0",
          "Phase one: count the completed tasks",
          PHASE_ONE_TASK,
          PHASE_ONE_RESULT,
        ),
      ],
      files: { [`w3:${REPORT_FILE}`]: FINAL_REPORT },
      logs: {
        // The lead orchestrates: three send-task calls chained with dependsOn,
        // polls the children by id, writes the merged report. No task-history query.
        "task-0": [
          ...sendTask("toolu_send_one", "worker-0", PHASE_ONE_TASK, "child-phase-one"),
          ...sendTask(
            "toolu_send_two",
            "worker-1",
            PHASE_TWO_TASK,
            "child-phase-two",
            "child-phase-one",
          ),
          ...sendTask(
            "toolu_send_three",
            "worker-2",
            PHASE_THREE_TASK,
            "child-phase-three",
            "child-phase-two",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__get-task-details",
            { taskId: "child-phase-three" },
            { task: { id: "child-phase-three", status: "completed", output: PHASE_THREE_RESULT } },
            "toolu_details_three",
          ),
          ...toolCallRows(
            "task-0",
            "Write",
            { file_path: REPORT_FILE, content: FINAL_REPORT },
            "File created successfully",
            "toolu_write_report",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__store-progress",
            { taskId: "task-0", status: "completed", output: `Final report at ${REPORT_FILE}.` },
            { success: true },
            "toolu_lead_done",
          ),
        ],
        "child-phase-one": workerSession(
          "child-phase-one",
          { status: "completed", limit: 100 },
          PHASE_ONE_RESULT,
        ),
        "child-phase-two": workerSession(
          "child-phase-two",
          { status: "completed", limit: 100 },
          PHASE_TWO_RESULT,
        ),
        "child-phase-three": workerSession("child-phase-three", { limit: 100 }, PHASE_THREE_RESULT),
      },
    });
    // The runner labels each roster entry with its scenario spec name; the
    // dispatch-structure check resolves the phase workers by that name.
    const names = [...(delegationChain.workers as { name: string }[]).map((w) => w.name), "Lead"];
    return { ...ctx, workers: ctx.workers.map((w, i) => ({ ...w, name: names[i] })) };
  },
  notes:
    "Spawned tasks are listed newest first, as the swarm API returns them (childOrder must not depend on it).",
};
