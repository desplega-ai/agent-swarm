import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { JudgeContext, Scenario, SwarmTask } from "../types.ts";
import type { LlmVerdict } from "./llm.ts";

const DEFAULT_AGENTIC_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_MAX_STEPS = 10;

/** Clone for the tool log with string fields clipped, so `raw` stays bounded. */
function clipForLog(value: Record<string, unknown>, max = 2_000): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = typeof v === "string" && v.length > max ? `${v.slice(0, max)}…` : v;
  }
  return out;
}

const VerdictInput = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Overall quality of the outcome, 0 = total failure, 1 = flawless"),
  pass: z.boolean().describe("Whether the outcome satisfies the rubric"),
  reasoning: z
    .string()
    .describe("Concise justification citing the evidence you gathered with the tools"),
});

export interface AgenticJudgeInput {
  scenario: Pick<Scenario, "name" | "description">;
  rubric: string;
  tasks: SwarmTask[];
  transcript: string;
  /** Live attempt context — the agent verifies through these tools. */
  ctx: JudgeContext;
  model?: string;
  maxSteps?: number;
}

/**
 * Agentic judge: an AI SDK tool-loop (https://ai-sdk.dev/docs/agents/overview)
 * that actively verifies the outcome inside the live sandbox/API before
 * submitting a verdict, instead of trusting the transcript alone.
 *
 * Throws when the agent never calls submit_verdict — callers should fall back
 * to the plain LLM judge.
 */
export async function judgeAgentic(
  input: AgenticJudgeInput,
): Promise<LlmVerdict & { raw: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the agentic judge");
  const openrouter = createOpenRouter({ apiKey });
  const model = input.model ?? process.env.EVAL_JUDGE_MODEL ?? DEFAULT_AGENTIC_MODEL;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;

  let verdict: LlmVerdict | null = null;
  const toolLog: { tool: string; args: unknown; output: unknown }[] = [];

  const taskSummaries = input.tasks
    .map(
      (t, i) =>
        `### Task ${i + 1}: ${t.title}\nStatus: ${t.status}\nDescription: ${t.description}\nResult: ${t.result ?? "(none)"}`,
    )
    .join("\n\n");

  const { steps } = await generateText({
    model: openrouter(model),
    tools: {
      run_command: tool({
        description:
          "Run a shell command inside the worker sandbox the agent worked in (e.g. inspect /workspace). Returns exit code, stdout, stderr.",
        inputSchema: z.object({ command: z.string().describe("Shell command to run") }),
        execute: async ({ command }) => {
          const res = await input.ctx.exec(command);
          const output = {
            exitCode: res.exitCode,
            stdout: res.stdout.slice(0, 8_000),
            stderr: res.stderr.slice(0, 4_000),
          };
          toolLog.push({ tool: "run_command", args: { command }, output: clipForLog(output) });
          return output;
        },
      }),
      read_file: tool({
        description: "Read a file from the worker sandbox. Returns null when the file is missing.",
        inputSchema: z.object({ path: z.string().describe("Absolute file path") }),
        execute: async ({ path }) => {
          const content = await input.ctx.readFile(path);
          const output = { exists: content !== null, content: content?.slice(0, 16_000) ?? null };
          toolLog.push({ tool: "read_file", args: { path }, output: clipForLog(output) });
          return output;
        },
      }),
      api_get: tool({
        description:
          "Authenticated GET against the attempt's swarm API (paths under /api/, e.g. /api/tasks/<id>/session-logs).",
        inputSchema: z.object({ path: z.string().describe("Path starting with /api/") }),
        execute: async ({ path }) => {
          let output: Record<string, unknown>;
          if (!path.startsWith("/api/") && path !== "/health") {
            output = { error: "path must start with /api/" };
          } else {
            try {
              const result = await input.ctx.apiGet(path);
              output = { result: JSON.stringify(result).slice(0, 16_000) };
            } catch (err) {
              output = { error: err instanceof Error ? err.message : String(err) };
            }
          }
          toolLog.push({ tool: "api_get", args: { path }, output: clipForLog(output) });
          return output;
        },
      }),
      submit_verdict: tool({
        description:
          "Submit your final verdict. Call exactly once, after you have verified the rubric with the other tools.",
        inputSchema: VerdictInput,
        execute: async (v) => {
          verdict = v;
          const output = { recorded: true };
          toolLog.push({ tool: "submit_verdict", args: v, output });
          return output;
        },
      }),
    },
    stopWhen: [stepCountIs(maxSteps), hasToolCall("submit_verdict")],
    prompt: `You are an agentic judge grading the outcome of an autonomous-agent evaluation scenario. You have live access to the worker sandbox and the swarm API — verify, don't trust.

## Scenario: ${input.scenario.name}
${input.scenario.description ?? ""}

## Rubric (what a successful outcome looks like)
${input.rubric}

## Final task records (authoritative orchestrator state)
${taskSummaries}

## Transcript excerpt (may be truncated mid-stream)
${input.transcript.slice(0, 30_000)}

Verify the rubric's claims with the tools (inspect files, run commands, query the API), then call submit_verdict exactly once. Harness-internal activity (memory searches, tool discovery, progress reporting) is normal — judge the outcome, not the style. Keep tool use focused: a handful of targeted verifications, not an exhaustive crawl.`,
  });

  if (!verdict) {
    throw new Error(
      `agentic judge finished ${steps.length} step(s) without submitting a verdict (tools used: ${toolLog.map((t) => t.tool).join("; ") || "none"})`,
    );
  }
  const v = verdict as LlmVerdict;
  return { ...v, raw: JSON.stringify({ model, steps: steps.length, toolLog, verdict: v }) };
}
