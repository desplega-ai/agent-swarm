import type { CheckResult, DeterministicCheck, JudgeContext, Scenario } from "../src/types.ts";
import {
  agentOutput,
  agentToolUses,
  countNativeSpawns,
  countSwarmDispatch,
  memberCreatedTasks,
  rawTaskCreateCount,
} from "./orchestration-utils.ts";

/**
 * tool-mapping-worker-local (harness tool mappings plan, Phase 3; 1 worker, no lead)
 * --------------------------------------------------------------------------------
 * A quick lookup across three small files, with an invitation to split it. A
 * worker may use its native subagents for that; it must not turn a local lookup
 * into swarm tasks. This is the task-explosion guard for the worker half of the
 * tool-mapping prompt: the mapping must not teach workers to `send-task`.
 *
 * Graded deterministically:
 *   - gate `answer-json`: the output holds a JSON object with `total` and `top`.
 *   - `correctness` (2): `total` and `top` match the answer key.
 *   - `task-discipline` (2): zero tasks created by the worker, over every route:
 *     the task records (any route that creates a task leaves one: `send-task`,
 *     the `delegate` script, a raw POST to `/api/tasks`), plus attempted calls
 *     through each route that failed to create one.
 * Native `Agent` / `spawn_agent` use is reported in the detail, never scored.
 *
 * Answer key (seeded by `seed.exec`, never in the prompt):
 *   widget-7 quantities: north 14, south 23, east 9 -> total 46, top "south"
 */

const DIR = "/workspace/inventory";

const ROWS: Record<"north" | "south" | "east", [string, number][]> = {
  north: [
    ["widget-7", 14],
    ["gadget-2", 31],
  ],
  south: [
    ["gadget-2", 5],
    ["widget-7", 23],
    ["sprocket-1", 40],
  ],
  east: [
    ["widget-7", 9],
    ["widget-70", 50],
  ],
};

const ANSWER = { total: 46, top: "south" };

const SEED_COMMANDS = [
  `mkdir -p ${DIR}`,
  ...Object.entries(ROWS).map(
    ([file, rows]) =>
      `printf '%s\\n' 'item,quantity' ${rows.map(([item, qty]) => `'${item},${qty}'`).join(" ")} > ${DIR}/${file}.csv`,
  ),
];

function workerId(ctx: JudgeContext): string | undefined {
  return ctx.workers.find((w) => !w.isLead)?.agentId;
}

/** The last JSON object in the output that has both keys. */
function parseAnswer(output: string): { total?: unknown; top?: unknown } | null {
  const candidates = output.match(/\{[^{}]*\}/g) ?? [];
  for (const raw of candidates.reverse()) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if ("total" in value && "top" in value) return value;
    } catch {
      // not JSON, try the previous one
    }
  }
  return null;
}

const answerJson: DeterministicCheck = {
  name: "answer-json",
  fn: async (ctx): Promise<CheckResult> => {
    const answer = parseAnswer(agentOutput(ctx, workerId(ctx)));
    return answer
      ? { pass: true, detail: `answer ${JSON.stringify(answer)}` }
      : { pass: false, detail: "no JSON object with total and top in the output" };
  },
};

const correctness: DeterministicCheck = {
  name: "lookup-answer-key",
  fn: async (ctx): Promise<CheckResult> => {
    const answer = parseAnswer(agentOutput(ctx, workerId(ctx)));
    const total = Number(answer?.total) === ANSWER.total;
    const top =
      String(answer?.top ?? "")
        .toLowerCase()
        .replace(/\.csv$/, "") === ANSWER.top;
    const score = (Number(total) + Number(top)) / 2;
    return {
      pass: score === 1,
      score,
      detail: `total ${total ? "ok" : "wrong"}, top ${top ? "ok" : "wrong"}`,
    };
  },
};

const taskDiscipline: DeterministicCheck = {
  name: "no-spurious-swarm-tasks",
  fn: async (ctx): Promise<CheckResult> => {
    const tools = await agentToolUses(ctx, workerId(ctx));
    const created = memberCreatedTasks(ctx).length;
    const attempts = countSwarmDispatch(tools) + rawTaskCreateCount(tools);
    const native = countNativeSpawns(tools);
    const ok = created === 0 && attempts === 0;
    return {
      pass: ok,
      score: ok ? 1 : 0,
      detail: `${created} task(s) created, ${attempts} task-creation call(s), ${native} native spawn(s) (not scored)`,
    };
  },
};

const BRIEF = [
  `Quick lookup: the three files in \`${DIR}/\` (\`north.csv\`, \`south.csv\`, \`east.csv\`) each list`,
  "`item,quantity` rows. Find the total quantity of `widget-7` across all three files, and which file",
  "holds the most of it. Check the files in parallel if that helps.",
  "",
  'Reply with only one JSON object: `{"total": <number>, "top": "<file name without .csv>"}`.',
].join("\n");

export const toolMappingWorkerLocal: Scenario = {
  id: "tool-mapping-worker-local",
  version: 1,
  name: "Tool mapping: worker keeps lookups local",
  description: [
    "One worker gets a quick three-file lookup with an invitation to parallelize. Graded",
    "deterministically: the JSON answer (correctness, 2) and zero swarm tasks created over every",
    "route (task-discipline, 2). Native subagent use is reported, not scored.",
  ].join(" "),
  workers: [{ name: "worker-1" }],
  seed: { exec: SEED_COMMANDS },
  tasks: [{ title: "Three-file inventory lookup", description: BRIEF }],
  outcome: {
    gates: [answerJson],
    dimensions: [
      { name: "correctness", weight: 2, checks: [correctness] },
      { name: "task-discipline", weight: 2, checks: [taskDiscipline] },
    ],
  },
  timeoutMs: 8 * 60_000,
};

// Exported for the rubric unit tests and the grader fixture.
export const __test__ = { ANSWER, DIR, ROWS, answerJson, correctness, taskDiscipline, BRIEF };
