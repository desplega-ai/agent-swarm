import type { CheckResult, DeterministicCheck, JudgeContext, Scenario } from "../src/types.ts";
import {
  agentOutput,
  agentToolUses,
  countNativeSpawns,
  countSwarmDispatch,
  safeStringify,
  workerTasks,
} from "./orchestration-utils.ts";

/**
 * tool-mapping-lead-reflex (harness tool mappings plan, Phase 3; lead + 2 workers)
 * ------------------------------------------------------------------------------
 * The brief is worded to fire a harness's native spawn reflex ("spin up a couple
 * of agents in parallel"). The facts live only in a fixture repo on the two
 * checkers' sandboxes, so a native subagent on the lead's own sandbox cannot see
 * them: the work has to go through the swarm (`send-task`, the `delegate`
 * script). Paired with HARNESS_TOOL_MAPPINGS_ENABLED off/on it measures whether
 * the prompt mapping moves the lead from native spawn to swarm dispatch.
 *
 * Graded deterministically:
 *   - gate `lead-reported`: the lead's output carries at least one service line.
 *   - `delegation` (4): one composite check. Hard zero when the lead called a
 *     native spawn tool (Claude `Agent`/`Task`, Codex `spawn_agent`), counted by
 *     exact name. Otherwise: D1 two or more child tasks from the lead to the
 *     checkers (w2); D2 the lead's service facts also appear in worker output,
 *     so they were not guessed (w2).
 *   - `correctness` (2): both service lines (port and owner) in the lead's output.
 *
 * Answer key (seeded by `seed.workerExec`, never in the prompt):
 *   alpha: port 7311, owner team-kestrel
 *   beta:  port 7422, owner team-osprey
 */

const WORKER_COUNT = 2;
const REPO = "/workspace/fixture-repo";

interface Service {
  name: "alpha" | "beta";
  port: number;
  owner: string;
}

const SERVICES: Service[] = [
  { name: "alpha", port: 7311, owner: "team-kestrel" },
  { name: "beta", port: 7422, owner: "team-osprey" },
];

function serviceToml(s: Service): string {
  return [`name = "${s.name}"`, `port = ${s.port}`, `owner = "${s.owner}"`, ""].join("\n");
}

/** Both checkers hold the whole repo; the lead holds nothing. */
const SEED_COMMANDS = SERVICES.flatMap((s) => [
  `mkdir -p ${REPO}/services/${s.name}`,
  `printf '%s' '${serviceToml(s)}' > ${REPO}/services/${s.name}/service.toml`,
]);

/** One fact per service: its port and owner on one line. */
function serviceLine(s: Service): RegExp {
  return new RegExp(`\\b${s.name}\\b[^\\n]{0,40}\\b${s.port}\\b[^\\n]{0,40}${s.owner}`, "i");
}

function leadId(ctx: JudgeContext): string | undefined {
  return ctx.workers.find((w) => w.isLead)?.agentId;
}

const leadReported: DeterministicCheck = {
  name: "lead-reported",
  fn: async (ctx): Promise<CheckResult> => {
    const output = agentOutput(ctx, leadId(ctx));
    const found = SERVICES.filter((s) => serviceLine(s).test(output)).map((s) => s.name);
    return found.length > 0
      ? { pass: true, detail: `service lines for ${found.join(", ")}` }
      : { pass: false, detail: "no service line in the lead's output" };
  },
};

const correctness: DeterministicCheck = {
  name: "service-answer-key",
  fn: async (ctx): Promise<CheckResult> => {
    const output = agentOutput(ctx, leadId(ctx));
    const missing = SERVICES.filter((s) => !serviceLine(s).test(output)).map((s) => s.name);
    const score = (SERVICES.length - missing.length) / SERVICES.length;
    return {
      pass: missing.length === 0,
      score,
      detail:
        missing.length === 0
          ? "both service lines"
          : `missing service lines: ${missing.join(", ")}`,
    };
  },
};

const W_CHILDREN = 2;
const W_TRACE = 2;

const delegation: DeterministicCheck = {
  name: "swarm-dispatch-not-native-spawn",
  fn: async (ctx): Promise<CheckResult> => {
    const lead = leadId(ctx);
    const tools = await agentToolUses(ctx, lead);
    const native = countNativeSpawns(tools);
    const dispatched = countSwarmDispatch(tools);
    if (native > 0) {
      return {
        pass: false,
        score: 0,
        detail: `${native} native spawn call(s) by the lead (${dispatched} swarm dispatch): dimension zeroed`,
      };
    }
    const children = workerTasks(ctx, lead);
    const d1 = Math.min(children.length, 2) / 2;
    const workerText = children.map((t) => safeStringify(t.result ?? "")).join("\n");
    const output = agentOutput(ctx, lead);
    const reported = SERVICES.filter((s) => serviceLine(s).test(output));
    const traced = reported.filter((s) => workerText.includes(String(s.port)));
    const d2 = reported.length > 0 ? traced.length / reported.length : 0;
    const score = (W_CHILDREN * d1 + W_TRACE * d2) / (W_CHILDREN + W_TRACE);
    return {
      pass: score >= 1,
      score,
      detail: `D1=${d1.toFixed(2)}(${children.length} children, ${dispatched} dispatch calls), D2=${d2.toFixed(2)}(facts→workers), 0 native spawns`,
    };
  },
};

const BRIEF = [
  `Spin up a couple of agents in parallel to each check one service in the fixture repo at \`${REPO}\`:`,
  "one checks `alpha`, the other checks `beta`. Each reads `services/<service>/service.toml` and",
  "reports its `port` and `owner`. The fixture repo lives on your two checkers' machines, not on yours.",
  "",
  "Then merge their findings. End your final output with one line per service, exactly in the form",
  "`<service>: port <port>, owner <owner>`. Use only the values the checks report.",
].join("\n");

export const toolMappingLeadReflex: Scenario = {
  id: "tool-mapping-lead-reflex",
  version: 1,
  name: "Tool mapping: lead spawn reflex",
  description: [
    "A lead is asked to 'spin up a couple of agents in parallel' to read two service configs that",
    "exist only on its two checkers' sandboxes. Graded deterministically: a native spawn by the lead",
    "zeroes delegation; otherwise two child tasks to the checkers and facts traceable to their output",
    "(delegation, 4); both service lines correct (correctness, 2).",
  ].join(" "),
  workers: [{ name: "checker-1" }, { name: "checker-2" }],
  lead: { name: "Lead", template: "lead" },
  seed: {
    workerExec: Array.from({ length: WORKER_COUNT }, (_, worker) => ({
      worker,
      commands: SEED_COMMANDS,
    })),
  },
  tasks: [{ title: "Check two services in parallel (lead)", worker: "lead", description: BRIEF }],
  outcome: {
    gates: [leadReported],
    dimensions: [
      { name: "delegation", weight: 4, checks: [delegation] },
      { name: "correctness", weight: 2, checks: [correctness] },
    ],
  },
  awaitSpawnedTasks: true,
  timeoutMs: 12 * 60_000,
};

// Exported for the rubric unit tests and the grader fixture.
export const __test__ = { SERVICES, REPO, leadReported, correctness, delegation, BRIEF };
