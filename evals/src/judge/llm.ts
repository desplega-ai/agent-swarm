import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { lookupOpenrouterModel, priceUsage } from "../cost/pricing.ts";
import type {
  JudgeKind,
  JudgeStep,
  JudgeTrace,
  JudgeWorkerContext,
  Scenario,
  SwarmTask,
  TokenTotals,
} from "../types.ts";
import type { JudgeLiveHandle } from "./live-registry.ts";

const DEFAULT_JUDGE_MODEL = "deepseek/deepseek-v4-pro";

const VerdictSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Overall quality of the outcome, 0 = total failure, 1 = flawless"),
  pass: z.boolean().describe("Whether the outcome satisfies the rubric"),
  reasoning: z
    .string()
    .describe("Concise justification citing concrete evidence from the tasks/transcript"),
});

export type LlmVerdict = z.infer<typeof VerdictSchema>;

export interface LlmJudgeInput {
  scenario: Pick<Scenario, "name" | "description">;
  rubric: string;
  tasks: SwarmTask[];
  transcript: string;
  model?: string;
  /**
   * Worker roster (v8.0 §4) — when present, a manifest is injected into the
   * prompt so the non-agentic fallback also has worker labels. Optional for
   * back-compat (single-worker scenarios pass nothing).
   */
  workers?: JudgeWorkerContext[];
  /** Live-registry handle — the trace is attached before the LLM call starts. */
  live?: JudgeLiveHandle;
}

/**
 * Map an AI SDK v6 usage block to TokenTotals. `inputTokens` is the TOTAL
 * prompt tokens (cache reads included) — price with
 * `{ inputIncludesCacheRead: true }`.
 */
export function usageToTokens(model: string | null, usage: LanguageModelUsage): TokenTotals {
  return {
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/** Fresh (mutable) trace — attach to the live registry, then keep mutating it. */
export function newJudgeTrace(judge: JudgeKind, model: string | null): JudgeTrace {
  return {
    judge,
    model,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    costUsd: null,
    tokens: null,
    error: null,
    steps: [],
  };
}

/**
 * Finalize a trace: finishedAt + durationMs, tokens = field-wise sum over
 * steps carrying usage (model = the configured judge model id), costUsd =
 * sum of non-null step costs (null when ALL are null).
 */
export function finishJudgeTrace(trace: JudgeTrace): void {
  trace.finishedAt = new Date().toISOString();
  trace.durationMs = Math.max(0, Date.parse(trace.finishedAt) - Date.parse(trace.startedAt));
  const usages = trace.steps.flatMap((s) => (s.tokens ? [s.tokens] : []));
  trace.tokens =
    usages.length === 0
      ? null
      : {
          model: trace.model,
          inputTokens: usages.reduce((s, u) => s + u.inputTokens, 0),
          outputTokens: usages.reduce((s, u) => s + u.outputTokens, 0),
          cacheReadTokens: usages.reduce((s, u) => s + u.cacheReadTokens, 0),
          cacheWriteTokens: usages.reduce((s, u) => s + u.cacheWriteTokens, 0),
        };
  const costs = trace.steps.flatMap((s) => (s.costUsd === null ? [] : [s.costUsd]));
  trace.costUsd = costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0);
}

/** Cap transcript size so judge calls stay cheap; keep head + tail. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - maxChars} chars truncated ...]\n\n${text.slice(-half)}`;
}

/**
 * Render the worker roster as a manifest block for a judge prompt (v8.0 §4) so
 * the judge knows what it is inspecting — each worker's index, registered name,
 * template, and role, with the lead flagged. Returns "" when no workers are
 * provided (back-compat: pre-v8 ctxs / bare fixtures), so callers can append it
 * unconditionally.
 */
export function renderRosterManifest(workers: JudgeWorkerContext[]): string {
  if (workers.length === 0) return "";
  const lines = workers.map((w) => {
    const isLead = w.isLead ?? w.role === "lead";
    const name = w.name ?? `worker-${w.index}`;
    const template = w.template ?? "(default)";
    const role = w.role ?? (isLead ? "lead" : "worker");
    return `- worker ${w.index}: name "${name}", template "${template}", role ${role}${isLead ? "  ← LEAD" : ""}`;
  });
  return `## Workers in this attempt\n${lines.join("\n")}`;
}

export async function judgeWithLlm(
  input: LlmJudgeInput,
): Promise<LlmVerdict & { raw: string; trace: JudgeTrace }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the LLM judge");
  const openrouter = createOpenRouter({ apiKey });
  const model = input.model ?? process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;

  // Attached before the call so the live view shows the judge as started.
  const trace = newJudgeTrace("llm", model);
  input.live?.attach(trace);
  const priced = await lookupOpenrouterModel(model);

  const taskSummaries = input.tasks
    .map(
      (t, i) =>
        `### Task ${i + 1}: ${t.title}\nStatus: ${t.status}\nDescription: ${t.description}\nResult: ${t.result ?? "(none)"}`,
    )
    .join("\n\n");

  const rosterBlock = renderRosterManifest(input.workers ?? []);
  const prompt = `You are grading the outcome of an autonomous-agent evaluation scenario.

## Scenario: ${input.scenario.name}
${input.scenario.description ?? ""}

## Rubric (what a successful outcome looks like)
${input.rubric}
${rosterBlock ? `\n${rosterBlock}\n` : ""}
## Final task records (authoritative — written by the orchestrator on completion)
${taskSummaries}

## Agent transcript (supporting evidence; streamed asynchronously and MAY BE TRUNCATED)
${truncateMiddle(input.transcript, 60_000)}

Grading rules:
- Grade the OUTCOME against the rubric. The task records above are authoritative ground truth for status and final output; the transcript is supporting evidence that may be incomplete or cut off mid-stream — never penalize for actions missing from the transcript when the task record shows they happened.
- Harness-internal activity (memory searches, tool discovery/ToolSearch, progress reporting, MCP plumbing) is normal agent-platform behavior, not flailing — do not deduct for it unless the rubric explicitly demands otherwise.
- Deduct for evidence of actual failure: wrong/missing output, contradictions between claim and evidence, destructive or off-task actions.
- Cite concrete evidence for your verdict.`;

  const callStart = Date.now();
  try {
    const result = await generateObject({
      model: openrouter(model),
      schema: VerdictSchema,
      prompt,
    });
    const tokens = usageToTokens(model, result.usage);
    const step: JudgeStep = {
      index: 0,
      kind: "reasoning",
      // Model thinking when the provider surfaced it; else the verdict's rationale.
      text:
        result.reasoning && result.reasoning.trim().length > 0
          ? result.reasoning
          : result.object.reasoning,
      tool: null,
      args: null,
      output: null,
      pass: null,
      startedAt: new Date(callStart).toISOString(),
      durationMs: Date.now() - callStart,
      tokens,
      costUsd: priced ? priceUsage(priced, tokens, { inputIncludesCacheRead: true }) : null,
    };
    trace.steps.push(step);
    finishJudgeTrace(trace);
    return { ...result.object, raw: JSON.stringify({ model, object: result.object }), trace };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    trace.steps.push({
      index: trace.steps.length,
      kind: "error",
      text: message,
      tool: null,
      args: null,
      output: null,
      pass: null,
      startedAt: new Date(callStart).toISOString(),
      durationMs: Date.now() - callStart,
      tokens: null,
      costUsd: null,
    });
    trace.error = message;
    finishJudgeTrace(trace);
    throw err;
  }
}
