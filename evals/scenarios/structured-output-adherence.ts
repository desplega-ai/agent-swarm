import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

const REQUIRED = ["summary", "risks", "nextAction", "confidence"] as const;

function validOutput(value: unknown): { ok: boolean; score: number; detail: string } {
  if (typeof value !== "string") return { ok: false, score: 0, detail: "output is not a string" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, score: 0, detail: "output is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, score: 0.2, detail: "JSON output is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const present = REQUIRED.filter((key) => key in obj).length;
  const typed =
    (typeof obj.summary === "string" ? 1 : 0) +
    (Array.isArray(obj.risks) && obj.risks.every((r) => typeof r === "string") ? 1 : 0) +
    (["ship", "hold", "needs-review"].includes(String(obj.nextAction)) ? 1 : 0) +
    (typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1 ? 1 : 0);
  const score = (present + typed) / (REQUIRED.length * 2);
  return {
    ok: score >= 1,
    score,
    detail: `${present}/${REQUIRED.length} fields present, ${typed}/${REQUIRED.length} correctly typed`,
  };
}

const schemaAdherenceCheck: DeterministicCheck = {
  name: "store-progress-output-schema",
  fn: async (ctx): Promise<CheckResult> => {
    const task = ctx.tasks[0];
    const result = validOutput(task?.result);
    return { pass: result.ok, score: result.score, detail: result.detail };
  },
};

const structuredOutputGate: DeterministicCheck = {
  name: "structured-output-present",
  fn: async (ctx) => {
    const output = ctx.tasks[0]?.result;
    return {
      pass: typeof output === "string" && output.trim().length > 0,
      detail: typeof output === "string" ? `${output.length} output chars` : "no task output",
    };
  },
};

export const structuredOutputAdherence: Scenario = {
  id: "structured-output-adherence",
  name: "Structured output adherence",
  description:
    "Validates that agents complete work by emitting JSON matching the task outputSchema, the recurring workflow failure mode.",
  workers: 1,
  tasks: [
    {
      title: "Return the deployment readiness decision as structured JSON",
      outputSchema: {
        type: "object",
        required: ["summary", "risks", "nextAction", "confidence"],
        properties: {
          summary: { type: "string" },
          risks: { type: "array", items: { type: "string" } },
          nextAction: { type: "string", enum: ["ship", "hold", "needs-review"] },
          confidence: { type: "number" },
        },
      },
      description: [
        "Review this readiness snapshot: tests passed, docs changed, rollout risk is cache invalidation, owner approval is missing.",
        "Complete via store-progress with output that is ONLY a JSON object matching the task outputSchema.",
        "Required fields: summary string, risks string array, nextAction enum ship|hold|needs-review, confidence number from 0 to 1.",
        "Do not wrap the JSON in markdown or prose.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [structuredOutputGate],
    dimensions: [{ name: "instruction-following", weight: 4, checks: [schemaAdherenceCheck] }],
  },
  timeoutMs: 5 * 60_000,
};

export const __test__ = { schemaAdherenceCheck, structuredOutputGate, validOutput };
