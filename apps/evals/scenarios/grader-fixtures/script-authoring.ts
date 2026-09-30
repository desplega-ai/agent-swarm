import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";
import { scriptAuthoring } from "../script-authoring.ts";

/**
 * Reference: what a correct run of the script-authoring task leaves behind. The
 * worker saves one agent-scoped script with `script-upsert` (args first, `ctx.swarm`
 * for task lookups, no raw fetch/curl/API keys), runs it by name with its own task
 * id (its own task is still in progress, so 0 of 1 completed), discovers other
 * tasks through `get-tasks`, runs the same named script again over those ids, and
 * reports the script name and output through `store-progress`.
 *
 * The scripts list returns what a real sandbox API returns: the 19 seeded global
 * catalog scripts plus the worker's own saved script. Only the agent-scoped one
 * may count. The discovered tasks are simulated sandbox history.
 *
 * The null agent completes its task and saves nothing; the same 19 seeded globals
 * are still listed, so `script-created` must fail on "0 saved scripts".
 */

const WORKER = "worker-0";
const SCRIPT_NAME = "task-summary";
const SCRIPT_ID = "b7d41e9a-0c62-4f38-8a15-6e2f9c3d7b04";

const SEEDED_GLOBALS = [
  "app-sync-run",
  "boot-triage",
  "catalog-report",
  "complete-task",
  "compound-insights",
  "date-resolve",
  "delegate",
  "fetch-readable",
  "get-child-outputs",
  "gh-pr-snapshot",
  "github-issues-pull",
  "group-count",
  "json-query",
  "linear-issue",
  "memory-dedup-check",
  "memory-eval",
  "ops-catalog-audit",
  "report-progress",
  "schedule-health",
].map((name, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  name,
  scope: "global",
  scopeId: null,
  createdByAgentId: null,
  typeChecked: true,
  isScratch: false,
}));

const source = `import type { ScriptContext } from "swarm-sdk";

type Args = { taskIds: string[] };

/** Summarize tasks: total count, completion rate, title of the highest-priority completed task. */
export default async function (args: Args, ctx: ScriptContext) {
  const tasks: any[] = [];
  for (const taskId of args.taskIds ?? []) {
    const res: any = await ctx.swarm.task_get({ taskId });
    const task = res?.data?.task ?? res?.task;
    if (task) tasks.push(task);
  }
  const completed = tasks.filter((t) => t.status === "completed");
  let top: any = null;
  for (const t of completed) {
    if (top === null || (t.priority ?? 0) > (top.priority ?? 0)) top = t;
  }
  return {
    total: tasks.length,
    completionRate: tasks.length === 0 ? 0 : completed.length / tasks.length,
    highestPriorityCompletedTitle: top?.task ?? top?.title ?? null,
  };
}
`;

const mySavedScript = {
  id: SCRIPT_ID,
  name: SCRIPT_NAME,
  scope: "agent",
  scopeId: WORKER,
  createdByAgentId: WORKER,
  typeChecked: true,
  isScratch: false,
};

const discovered = [
  { id: "9e1c5a20-7b44-4d0f-a3e6-1f8b2c6d9e07", status: "completed", priority: 60 },
  { id: "4a7f0d83-2e19-4b5c-8d61-c0a3e5b9f214", status: "completed", priority: 85 },
  { id: "d20b6e51-9c38-4a7d-b0f4-3e8a1c5d7f96", status: "failed", priority: 90 },
];

const firstRun = {
  success: true,
  status: 200,
  data: {
    result: { total: 1, completionRate: 0, highestPriorityCompletedTitle: null },
    exitCode: 0,
    stdout: "",
    stderr: "",
  },
};

const secondRun = {
  success: true,
  status: 200,
  data: {
    result: {
      total: 4,
      completionRate: 0.5,
      highestPriorityCompletedTitle: "Backfill the audit log index",
    },
    exitCode: 0,
    stdout: "",
    stderr: "",
  },
};

const scriptTasks = () => nullTasks(scriptAuthoring).map((t) => ({ ...t, agentId: WORKER }));

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(scriptAuthoring, {
      tasks: scriptTasks().map((t) => ({
        ...t,
        result: `Saved script ${SCRIPT_NAME}; last run: ${JSON.stringify(secondRun.data.result)}`,
      })),
      api: {
        "/api/scripts?includeScratch=false": { scripts: [...SEEDED_GLOBALS, mySavedScript] },
        [`/api/scripts/${SCRIPT_ID}`]: { script: { ...mySavedScript, source } },
      },
      logs: {
        "task-0": [
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__script-upsert",
            {
              name: SCRIPT_NAME,
              source,
              description: "Summarize tasks by id: total, completion rate, top completed title.",
              intent: "Reusable task summary for the task-summary eval.",
              scope: "agent",
            },
            {
              success: true,
              status: 200,
              message: `Script \`${SCRIPT_NAME}\` v1 saved.`,
              data: { name: SCRIPT_NAME, version: 1, typeChecked: true },
            },
            "toolu_upsert1",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__script-run",
            { name: SCRIPT_NAME, args: { taskIds: ["task-0"] }, intent: "Test the new script" },
            firstRun,
            "toolu_run1",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__get-tasks",
            { limit: 10 },
            {
              success: true,
              tasks: [{ id: "task-0", status: "in_progress", priority: 50 }, ...discovered],
            },
            "toolu_tasks1",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__script-run",
            {
              name: SCRIPT_NAME,
              args: { taskIds: ["task-0", ...discovered.map((d) => d.id)] },
              intent: "Summarize this task and the tasks found in the swarm",
            },
            secondRun,
            "toolu_run2",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__store-progress",
            {
              status: "completed",
              output: `Script ${SCRIPT_NAME} output: ${JSON.stringify(secondRun.data.result)}`,
            },
            { success: true, message: "Progress stored." },
            "toolu_progress1",
          ),
        ],
      },
    }),
  nullContext: () =>
    makeContext(scriptAuthoring, {
      tasks: scriptTasks(),
      // The seeded catalog is still listed; the worker just did nothing.
      api: { "/api/scripts?includeScratch=false": { scripts: SEEDED_GLOBALS } },
    }),
  notes:
    "The get-tasks history is simulated; the checks read only the script-run tool results, " +
    "the saved script source, and the list of agent-scoped scripts.",
};
