import type { ToolUse } from "../src/judge/session-log-parse.ts";
import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import {
  agentOutput,
  agentToolUses,
  countNativeComms,
  memberCreatedTasks,
  swarmToolSlug,
  toolArgs,
} from "./orchestration-utils.ts";

/**
 * tool-mapping-worker-comms (harness tool mappings plan, Phase 3; 2 workers, no lead)
 * ---------------------------------------------------------------------------------
 * Worker A creates one swarm task T for worker B with a deliberately wrong input,
 * then has to correct T while it runs, wait for it and report T's output. The
 * reflex under test: a harness's native agent messaging (Claude `SendMessage`,
 * Codex `send_message` / `followup_task` / `wait_agent`) reaches only local
 * subagents, so the correction must go through `steer-task` on T.
 *
 * Plan deviation (the plan's stated fallback): seeding T with A as its creator
 * would need a seed primitive that calls the API as A, which the eval seed does
 * not have (seed commands run as root with no swarm credentials). So A creates
 * T itself as step one and the expected task count is exactly 1.
 *
 * Graded deterministically:
 *   - gate `marker-reported`: A's output carries T's corrected marker.
 *   - `comms` (3): one composite check. C1 at least one `steer-task` call on T
 *     (w2); C2 zero native comms calls by A (w2); C3 exactly one task created by
 *     the workers, T, so no re-dispatch through `send-task`, the `delegate`
 *     script or a raw POST to `/api/tasks` (w1); C4 the wait went through the
 *     swarm (`wait-for-task` script, `defer-task`, `get-task-details`,
 *     `get-tasks`) (w1).
 *   - `correctness` (1): the last marker in A's output is the corrected one.
 *
 * Answer key (seeded on worker B by `seed.workerExec`, never in the prompt):
 *   a.txt marker AMBER-3317 (the wrong input), b.txt marker BLUE-6604 (the right one)
 */

const DIR = "/workspace/comms";
const WRONG = "AMBER-3317";
const RIGHT = "BLUE-6604";
const MARKER_RE = /\b(AMBER-3317|BLUE-6604)\b/g;

const SEED_COMMANDS = [
  `mkdir -p ${DIR}`,
  `printf 'marker: %s\\n' '${WRONG}' > ${DIR}/a.txt`,
  `printf 'marker: %s\\n' '${RIGHT}' > ${DIR}/b.txt`,
];

const WAIT_SLUGS = new Set(["defer-task", "get-task-details", "get-tasks"]);

function workerA(ctx: JudgeContext): string | undefined {
  return ctx.workers.find((w) => !w.isLead && w.index === 0)?.agentId;
}

/** T: the task worker A created for another worker. */
function findT(ctx: JudgeContext, a: string | undefined): SwarmTask | undefined {
  return ctx.tasks.find(
    (t) => a !== undefined && t.creatorAgentId === a && t.agentId !== a && t.agentId != null,
  );
}

function isSteerOn(use: ToolUse, taskId: string | undefined): boolean {
  return (
    taskId !== undefined &&
    swarmToolSlug(use.toolName) === "steer-task" &&
    toolArgs(use.input).taskId === taskId
  );
}

function isSwarmWait(use: ToolUse): boolean {
  const slug = swarmToolSlug(use.toolName);
  if (WAIT_SLUGS.has(slug)) return true;
  return slug === "script-run" && toolArgs(use.input).name === "wait-for-task";
}

const markerReported: DeterministicCheck = {
  name: "marker-reported",
  fn: async (ctx): Promise<CheckResult> => {
    const output = agentOutput(ctx, workerA(ctx));
    return output.includes(RIGHT)
      ? { pass: true, detail: "corrected marker reported" }
      : { pass: false, detail: "corrected marker missing from worker A's output" };
  },
};

const correctness: DeterministicCheck = {
  name: "last-marker-is-corrected",
  fn: async (ctx): Promise<CheckResult> => {
    const markers = agentOutput(ctx, workerA(ctx)).match(MARKER_RE) ?? [];
    const last = markers.at(-1);
    return last === RIGHT
      ? { pass: true, score: 1, detail: "last marker is the corrected one" }
      : { pass: false, score: 0, detail: last ? "last marker is the wrong input's" : "no marker" };
  },
};

const W_STEER = 2;
const W_NATIVE = 2;
const W_TASKS = 1;
const W_WAIT = 1;

const comms: DeterministicCheck = {
  name: "steer-not-native-comms",
  fn: async (ctx): Promise<CheckResult> => {
    const a = workerA(ctx);
    const t = findT(ctx, a);
    const tools = await agentToolUses(ctx, a);
    const steers = tools.filter((u) => isSteerOn(u, t?.id)).length;
    const native = countNativeComms(tools);
    const created = memberCreatedTasks(ctx).length;
    const waited = tools.some(isSwarmWait);
    const c1 = steers > 0 ? 1 : 0;
    const c2 = native === 0 ? 1 : 0;
    const c3 = created === 1 ? 1 : 0;
    const c4 = waited ? 1 : 0;
    const score =
      (W_STEER * c1 + W_NATIVE * c2 + W_TASKS * c3 + W_WAIT * c4) /
      (W_STEER + W_NATIVE + W_TASKS + W_WAIT);
    return {
      pass: score >= 1,
      score,
      detail: `C1=${c1}(${steers} steer on T), C2=${c2}(${native} native comms), C3=${c3}(${created} worker-created tasks), C4=${c4}(swarm wait)`,
    };
  },
};

const BRIEF = [
  "Your teammate `worker-b` is another swarm agent (find its agent ID with `get-swarm`).",
  "",
  "1. Create one swarm task for `worker-b` with this brief: run `sleep 90`, then read",
  `   \`${DIR}/a.txt\` and reply with its \`marker:\` line.`,
  `2. That brief reads the wrong input. As soon as the task exists, tell it, while it runs, to read`,
  `   \`${DIR}/b.txt\` instead. Do not create another task.`,
  "3. Wait for the task to finish, then end your output with the marker line it reported, verbatim.",
].join("\n");

export const toolMappingWorkerComms: Scenario = {
  id: "tool-mapping-worker-comms",
  version: 1,
  name: "Tool mapping: worker steers a swarm task",
  description: [
    "Worker A creates one task for worker B with the wrong input, must correct it while it runs,",
    "wait for it and report its output. Graded deterministically: a steer-task on that task, no",
    "native agent messaging, exactly one worker-created task and a swarm wait (comms, 3); the",
    "corrected marker reported last (correctness, 1).",
  ].join(" "),
  workers: [{ name: "worker-a" }, { name: "worker-b" }],
  seed: { workerExec: [{ worker: 1, commands: SEED_COMMANDS }] },
  tasks: [{ title: "Correct a running teammate task", description: BRIEF }],
  outcome: {
    gates: [markerReported],
    dimensions: [
      { name: "comms", weight: 3, checks: [comms] },
      { name: "correctness", weight: 1, checks: [correctness] },
    ],
  },
  // Worker A may defer while T runs; keep waiting for T and A's wake-up task.
  awaitSpawnedTasks: true,
  timeoutMs: 10 * 60_000,
};

// Exported for the rubric unit tests and the grader fixture.
export const __test__ = { DIR, WRONG, RIGHT, markerReported, correctness, comms, BRIEF };
