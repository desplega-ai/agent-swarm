import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";
import type { Scenario, SwarmTask } from "../types.ts";

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
}

/** Cap transcript size so judge calls stay cheap; keep head + tail. */
function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - maxChars} chars truncated ...]\n\n${text.slice(-half)}`;
}

export async function judgeWithLlm(input: LlmJudgeInput): Promise<LlmVerdict & { raw: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the LLM judge");
  const openrouter = createOpenRouter({ apiKey });
  const model = input.model ?? process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;

  const taskSummaries = input.tasks
    .map(
      (t, i) =>
        `### Task ${i + 1}: ${t.title}\nStatus: ${t.status}\nDescription: ${t.description}\nResult: ${t.result ?? "(none)"}`,
    )
    .join("\n\n");

  const prompt = `You are grading the outcome of an autonomous-agent evaluation scenario.

## Scenario: ${input.scenario.name}
${input.scenario.description ?? ""}

## Rubric (what a successful outcome looks like)
${input.rubric}

## Final task records (authoritative — written by the orchestrator on completion)
${taskSummaries}

## Agent transcript (supporting evidence; streamed asynchronously and MAY BE TRUNCATED)
${truncateMiddle(input.transcript, 60_000)}

Grading rules:
- Grade the OUTCOME against the rubric. The task records above are authoritative ground truth for status and final output; the transcript is supporting evidence that may be incomplete or cut off mid-stream — never penalize for actions missing from the transcript when the task record shows they happened.
- Harness-internal activity (memory searches, tool discovery/ToolSearch, progress reporting, MCP plumbing) is normal agent-platform behavior, not flailing — do not deduct for it unless the rubric explicitly demands otherwise.
- Deduct for evidence of actual failure: wrong/missing output, contradictions between claim and evidence, destructive or off-task actions.
- Cite concrete evidence for your verdict.`;

  const { object } = await generateObject({
    model: openrouter(model),
    schema: VerdictSchema,
    prompt,
  });

  return { ...object, raw: JSON.stringify({ model, object }) };
}
