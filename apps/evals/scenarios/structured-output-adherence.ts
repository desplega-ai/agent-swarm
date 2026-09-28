import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

// v2 (2026-09-28): the v1 task (one snapshot, four fields) saturated at 5/5 for
// every Claude model because the check graded JSON SHAPE only — any output with
// the four keys and the right types passed, whatever it decided. v2 keeps the
// shape axis but adds an answer key: four services, each with a release
// decision fixed by explicit rules, so the output must be both well-formed AND
// right. The rules include two traps (a waived approval that is expired, and a
// high-severity risk that is already mitigated) that a skim-read gets wrong.

const DECISIONS = ["ship", "hold", "needs-review"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;

/** Answer key, derived by hand from the RULES + SNAPSHOT in the task prompt. */
const EXPECTED: Record<string, { decision: string; blockers: RegExp[] }> = {
  billing: { decision: "ship", blockers: [] },
  search: { decision: "hold", blockers: [/test/i] },
  notifications: { decision: "hold", blockers: [/approv|waiver|expir/i] },
  checkout: { decision: "needs-review", blockers: [/cache|risk|high/i] },
};
const RELEASE_SHIPPABLE = 1;

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parse(value: unknown): Record<string, unknown> | null {
  if (isObj(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serviceShapeOk(s: unknown): boolean {
  if (!isObj(s)) return false;
  return (
    typeof s.name === "string" &&
    DECISIONS.includes(s.decision as (typeof DECISIONS)[number]) &&
    Array.isArray(s.blockers) &&
    s.blockers.every((b) => typeof b === "string") &&
    Array.isArray(s.risks) &&
    s.risks.every(
      (r) =>
        isObj(r) &&
        typeof r.description === "string" &&
        SEVERITIES.includes(r.severity as (typeof SEVERITIES)[number]) &&
        typeof r.mitigated === "boolean",
    )
  );
}

function shapeScore(obj: Record<string, unknown> | null): { score: number; detail: string } {
  if (!obj) return { score: 0, detail: "output is not a JSON object" };
  const services = Array.isArray(obj.services) ? obj.services : [];
  const topLevel =
    (Array.isArray(obj.services) ? 1 : 0) +
    (typeof obj.shippableCount === "number" ? 1 : 0) +
    (typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1 ? 1 : 0);
  const wellFormed = services.filter(serviceShapeOk).length;
  const score = (topLevel / 3 + (services.length > 0 ? wellFormed / services.length : 0)) / 2;
  return {
    score,
    detail: `top-level ${topLevel}/3, ${wellFormed}/${services.length} services well-formed`,
  };
}

function answerScore(obj: Record<string, unknown> | null): { score: number; detail: string } {
  if (!obj) return { score: 0, detail: "output is not a JSON object" };
  const services = (Array.isArray(obj.services) ? obj.services : []).filter(isObj);
  const byName = new Map(services.map((s) => [String(s.name).toLowerCase().trim(), s]));
  let points = 0;
  const parts: string[] = [];
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = byName.get(name);
    const decisionOk = got?.decision === want.decision;
    const blockers = Array.isArray(got?.blockers) ? got.blockers.map(String) : [];
    const blockersOk =
      want.blockers.length === 0
        ? blockers.length === 0
        : want.blockers.every((re) => blockers.some((b) => re.test(b)));
    points += (decisionOk ? 1 : 0) + (decisionOk && blockersOk ? 0.5 : 0);
    parts.push(`${name}=${got ? `${String(got.decision)}${blockersOk ? "" : "/blockers?"}` : "missing"}`);
  }
  const countOk = obj.shippableCount === RELEASE_SHIPPABLE;
  const extra = services.length !== Object.keys(EXPECTED).length;
  points += countOk ? 1 : 0;
  const max = Object.keys(EXPECTED).length * 1.5 + 1;
  const score = Math.max(0, points / max - (extra ? 0.1 : 0));
  parts.push(`shippableCount=${String(obj.shippableCount)}`);
  return { score, detail: parts.join(", ") };
}

const schemaAdherenceCheck: DeterministicCheck = {
  name: "store-progress-output-schema",
  fn: async (ctx): Promise<CheckResult> => {
    const r = shapeScore(parse(ctx.tasks[0]?.result));
    return { pass: r.score >= 1, score: r.score, detail: r.detail };
  },
};

const decisionAnswerCheck: DeterministicCheck = {
  name: "release-decision-answer-key",
  fn: async (ctx): Promise<CheckResult> => {
    const r = answerScore(parse(ctx.tasks[0]?.result));
    return { pass: r.score >= 1, score: r.score, detail: r.detail };
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

const riskSchema = {
  type: "object",
  required: ["description", "severity", "mitigated"],
  properties: {
    description: { type: "string" },
    severity: { type: "string", enum: [...SEVERITIES] },
    mitigated: { type: "boolean" },
  },
};

export const structuredOutputAdherence: Scenario = {
  id: "structured-output-adherence",
  name: "Structured output adherence",
  description:
    "Apply explicit release rules to a four-service snapshot and complete with nested JSON matching the task outputSchema. Grades shape and the rule-derived answer key.",
  workers: 1,
  tasks: [
    {
      title: "Return the release decisions as structured JSON",
      outputSchema: {
        type: "object",
        required: ["services", "shippableCount", "confidence"],
        properties: {
          services: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "decision", "blockers", "risks"],
              properties: {
                name: { type: "string" },
                decision: { type: "string", enum: [...DECISIONS] },
                blockers: { type: "array", items: { type: "string" } },
                risks: { type: "array", items: riskSchema },
              },
            },
          },
          shippableCount: { type: "number" },
          confidence: { type: "number" },
        },
      },
      description: [
        "Decide the release status of each service. Today is 2026-09-28.",
        "",
        "RULES (apply in order, first match wins):",
        "1. Any failing test suite -> hold. Blocker: the failing suite.",
        "2. Owner approval missing -> hold. A waiver counts as approval only if it has not expired. Blocker: the missing approval.",
        "3. Any risk with severity high that is NOT mitigated -> needs-review. Blocker: that risk.",
        "4. Otherwise -> ship, with an empty blockers list.",
        "",
        "SNAPSHOT:",
        "- billing: tests all passing. Owner approved by dana on 2026-09-27. Risks: schema migration (high, mitigated by a tested rollback script); log volume increase (low, not mitigated).",
        "- search: tests failing in the ranking-regression suite; other suites pass. Owner approved. Risks: index rebuild time (medium, not mitigated).",
        "- notifications: tests all passing. No owner approval; a waiver was granted by the VP, valid until 2026-09-15. Risks: none.",
        "- checkout: tests all passing. Owner approved. Risks: cache invalidation on price change (high, not mitigated); retry storm (medium, mitigated by a circuit breaker).",
        "",
        "Output: one entry per service (use the lowercase service name), every listed risk with its severity and mitigated flag, shippableCount = number of services whose decision is ship, and confidence from 0 to 1.",
        "Complete via store-progress with output that is ONLY the JSON object. No markdown, no prose.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [structuredOutputGate],
    dimensions: [
      { name: "instruction-following", weight: 2, checks: [schemaAdherenceCheck] },
      { name: "correctness", weight: 3, checks: [decisionAnswerCheck] },
    ],
    passThreshold: 0.9,
  },
  timeoutMs: 5 * 60_000,
};

export const __test__ = {
  schemaAdherenceCheck,
  decisionAnswerCheck,
  structuredOutputGate,
  shapeScore,
  answerScore,
  EXPECTED,
};
