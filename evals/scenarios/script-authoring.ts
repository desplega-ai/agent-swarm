import type { CheckResult, DeterministicCheck, JudgeContext, Scenario } from "../src/types.ts";
import {
  apiList,
  hasTool,
  parseJson,
  rawApiToolCount,
  safeStringify,
  scoreResult,
  taskToolUses,
} from "./orchestration-utils.ts";

type ScriptListItem = {
  id: string;
  name: string;
  scope?: string;
  typeChecked?: boolean;
  isScratch?: boolean;
};
type ScriptDetail = ScriptListItem & { source?: string };
type ScriptRun = {
  scriptName?: string | null;
  status?: string;
  output?: unknown;
  error?: string | null;
};

async function savedScripts(ctx: JudgeContext): Promise<ScriptListItem[]> {
  return apiList<ScriptListItem>(ctx, "/api/scripts?includeScratch=false", ["scripts"]);
}

async function scriptDetail(
  ctx: JudgeContext,
  script: ScriptListItem | undefined,
): Promise<ScriptDetail | null> {
  if (!script?.id) return null;
  try {
    const res = (await ctx.apiGet(`/api/scripts/${script.id}`)) as
      | { script?: ScriptDetail }
      | ScriptDetail
      | null;
    return res && "script" in res ? (res.script ?? null) : (res as ScriptDetail | null);
  } catch {
    return null;
  }
}

async function scriptRuns(ctx: JudgeContext): Promise<ScriptRun[]> {
  return apiList<ScriptRun>(ctx, "/api/script-runs?limit=25", ["runs", "scriptRuns"]);
}

const scriptCreatedGate: DeterministicCheck = {
  name: "script-created",
  fn: async (ctx) => {
    const scripts = (await savedScripts(ctx)).filter((s) => !s.isScratch);
    return {
      pass: scripts.length === 1 && scripts[0]?.typeChecked !== false,
      detail: `${scripts.length} saved scripts`,
    };
  },
};

const sdkUsageCheck: DeterministicCheck = {
  name: "script-sdk-usage",
  fn: async (ctx): Promise<CheckResult> => {
    const script = (await savedScripts(ctx)).find((s) => !s.isScratch);
    const detail = await scriptDetail(ctx, script);
    const source = detail?.source ?? "";
    const tools = await taskToolUses(ctx, ctx.tasks[0]);
    const usedUpsert = hasTool(tools, ["script-upsert", "script_upsert"]);
    const usedRun = hasTool(tools, ["script-run", "script_run"]);
    if (!usedUpsert) return { pass: false, score: 0, detail: "script-upsert tool was not used" };
    const usesSdk = /ctx\.swarm\./.test(source);
    const parameterized = /\bargs\b/.test(source);
    const noRawAuth = !/process\.env\.(API_KEY|AGENT_SWARM_API_KEY)|fetch\s*\(|curl\b/.test(source);
    const tested = usedRun ? 1 : 0.5;
    const score =
      ((usesSdk ? 3 : 0) + (parameterized ? 1 : 0) + (noRawAuth ? 1 : 0) + tested * 2) / 7;
    return scoreResult("script SDK", score, [
      `ctx.swarm=${usesSdk ? "yes" : "no"}`,
      `args=${parameterized ? "yes" : "no"}`,
      `raw-auth=${noRawAuth ? "no" : "yes"}`,
      `script-run=${usedRun ? "yes" : "no"}`,
    ]);
  },
};

const scriptCorrectnessCheck: DeterministicCheck = {
  name: "script-run-output",
  fn: async (ctx): Promise<CheckResult> => {
    const runs = await scriptRuns(ctx);
    const completed = runs.find((r) => r.status === "completed" && r.output != null);
    const output = parseJson(completed?.output);
    const text = safeStringify(output);
    const hasTotal = /total|count/i.test(text);
    const hasRate = /completionRate|completion_rate|rate/i.test(text);
    const hasTop = /highestPriority|topPriority|top-priority|title/i.test(text);
    return scoreResult(
      "script output",
      ((completed ? 1 : 0) + (hasTotal ? 1 : 0) + (hasRate ? 1 : 0) + (hasTop ? 1 : 0)) / 4,
      [
        `completed-run=${completed ? "yes" : "no"}`,
        `total=${hasTotal ? "yes" : "no"}`,
        `rate=${hasRate ? "yes" : "no"}`,
        `top-title=${hasTop ? "yes" : "no"}`,
      ],
    );
  },
};

const reusabilityCheck: DeterministicCheck = {
  name: "script-reusable",
  fn: async (ctx): Promise<CheckResult> => {
    const tools = await taskToolUses(ctx, ctx.tasks[0]);
    const runCalls = tools.filter((u) => /script[-_]run/.test(u.toolName));
    const rawApiPenalty = rawApiToolCount(tools) > 0 ? 0.25 : 0;
    const namedRuns = runCalls.filter((u) => safeStringify(u.input).includes("name")).length;
    const score = Math.max(
      0,
      Math.min(1, (runCalls.length >= 2 ? 1 : namedRuns > 0 ? 0.75 : 0.25) - rawApiPenalty),
    );
    return {
      pass: score >= 1,
      score,
      detail: `${runCalls.length} script-run calls, ${namedRuns} named, raw-api penalty=${rawApiPenalty}`,
    };
  },
};

export const scriptAuthoring: Scenario = {
  id: "script-authoring",
  name: "Swarm-script authoring",
  description:
    "Create and test a reusable typed swarm script through script-upsert and script-run, grading source, run output, and behavioral tool use.",
  workers: 1,
  tasks: [
    {
      title: "Create and test a reusable task-summary script",
      description: [
        "Use script-upsert to create one reusable agent-scoped TypeScript script.",
        "The script must accept args, use ctx.swarm APIs to fetch task details for the provided task IDs, and return JSON with total count, completion rate, and the title of the highest-priority completed task.",
        "Do not use raw fetch/curl or process.env API keys. After upserting, run it with script-run at least once using this task's ID and any other task IDs you discover through swarm tools.",
        "Report the script name and observed output through store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [scriptCreatedGate],
    dimensions: [
      { name: "script-behavior", weight: 4, checks: [sdkUsageCheck] },
      { name: "correctness", weight: 2, checks: [scriptCorrectnessCheck] },
      { name: "reusability", weight: 1, checks: [reusabilityCheck] },
    ],
  },
  timeoutMs: 10 * 60_000,
};

export const __test__ = {
  scriptCreatedGate,
  sdkUsageCheck,
  scriptCorrectnessCheck,
  reusabilityCheck,
};
