import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.js";
import type { SwarmClient } from "./swarm-client.js";
import type { LitmusResult } from "./types.js";

/**
 * Parse litmus test JSON from reviewer output.
 * Handles raw JSON, markdown code blocks, and embedded JSON.
 */
export function parseLitmusResult(output: string): LitmusResult | null {
  // Strategy 1: Direct JSON parse
  try {
    const parsed = JSON.parse(output.trim());
    if (typeof parsed.approved === "boolean") return normalizeLitmusResult(parsed);
  } catch {
    // continue
  }

  // Strategy 2: Extract from markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]!);
      if (typeof parsed.approved === "boolean") return normalizeLitmusResult(parsed);
    } catch {
      // continue
    }
  }

  // Strategy 3: Find JSON object with "approved" key
  const jsonMatch = output.match(/\{[^{}]*"approved"\s*:\s*(?:true|false)[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeLitmusResult(parsed);
    } catch {
      // continue
    }
  }

  // Strategy 4: Try to find a larger JSON block
  const bigJsonMatch = output.match(/\{[\s\S]*"approved"\s*:\s*(?:true|false)[\s\S]*\}/);
  if (bigJsonMatch) {
    try {
      const parsed = JSON.parse(bigJsonMatch[0]);
      return normalizeLitmusResult(parsed);
    } catch {
      // continue
    }
  }

  console.log("[litmus] Failed to parse litmus result from output");
  return null;
}

/** Normalize various litmus JSON formats into a consistent structure */
function normalizeLitmusResult(raw: Record<string, unknown>): LitmusResult {
  const scores: Record<string, number> = {};
  let totalScore = 0;
  let maxScore = 0;

  // Collect all numeric score fields
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value === "number" &&
      key !== "totalScore" &&
      key !== "total_score" &&
      key !== "maxScore" &&
      key !== "max_score"
    ) {
      // Likely a score field if between 1-10
      if (value >= 1 && value <= 10) {
        scores[key] = value;
      }
    }
  }

  // Check for explicit scores object
  if (raw.scores && typeof raw.scores === "object") {
    for (const [key, value] of Object.entries(raw.scores as Record<string, unknown>)) {
      if (typeof value === "number") {
        scores[key] = value;
        totalScore += value;
        maxScore += 10;
      }
    }
  }

  // Calculate totals if not already done from scores object
  if (totalScore === 0) {
    for (const v of Object.values(scores)) {
      totalScore += v;
      maxScore += 10;
    }
  }

  // Override with explicit total if provided
  if (typeof raw.totalScore === "number") totalScore = raw.totalScore;
  if (typeof raw.total_score === "number") totalScore = raw.total_score;

  return {
    approved: raw.approved === true,
    scores,
    totalScore,
    maxScore: maxScore || 50,
    rejectionReasons: toStringArray(raw.rejection_reasons ?? raw.rejectionReasons),
    improvementSuggestions: toStringArray(
      raw.improvement_suggestions ?? raw.improvementSuggestions ?? raw.suggestions,
    ),
  };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

/** Load a prompt template from the prompts directory */
export function loadPrompt(promptFile: string): string {
  const fullPath = join(CONFIG.PROMPTS_PATH, promptFile);
  return readFileSync(fullPath, "utf-8");
}

/**
 * Execute a task with litmus test validation and retry logic.
 *
 * 1. Send task to the producing agent (strategist/writer)
 * 2. Send litmus test to the reviewer agent
 * 3. If rejected, retry with feedback injection up to maxRetries times
 */
export async function executeWithLitmusTest(
  swarmClient: SwarmClient,
  step: {
    agentId: string;
    buildTaskDescription: (retryContext?: {
      previousAttempt: string;
      rejectionReasons: string[];
      improvementSuggestions: string[];
      attemptNumber: number;
    }) => string;
  },
  litmus: {
    promptFile: string;
    maxRetries: number;
  },
  opts: {
    taskTimeout?: number;
    litmusTimeout?: number;
    tags?: string[];
  } = {},
): Promise<{
  status: "approved" | "validation_failed" | "task_failed";
  output?: string;
  litmusResult?: LitmusResult;
}> {
  const maxAttempts = litmus.maxRetries + 1;
  let lastOutput: string | undefined;
  let lastLitmusResult: LitmusResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `[litmus] Attempt ${attempt}/${maxAttempts} for ${litmus.promptFile}`,
    );

    // Build task description, injecting retry context if applicable
    let retryContext: Parameters<typeof step.buildTaskDescription>[0];
    if (attempt > 1 && lastOutput && lastLitmusResult) {
      retryContext = {
        previousAttempt: lastOutput,
        rejectionReasons: lastLitmusResult.rejectionReasons,
        improvementSuggestions: lastLitmusResult.improvementSuggestions,
        attemptNumber: attempt,
      };
    }
    const taskDescription = step.buildTaskDescription(retryContext);

    // Step 1: Execute the producing task
    const taskResult = await swarmClient.sendTaskAndWait(
      step.agentId,
      taskDescription,
      {
        timeoutMs: opts.taskTimeout ?? CONFIG.LLM_TASK_TIMEOUT_MS,
        tags: opts.tags,
      },
    );

    if (taskResult.status !== "completed" || !taskResult.output) {
      console.log(
        `[litmus] Task failed: ${taskResult.failureReason ?? taskResult.status}`,
      );
      return { status: "task_failed" };
    }

    lastOutput = taskResult.output;

    // Step 2: Run litmus test
    let litmusPromptContent: string;
    try {
      litmusPromptContent = loadPrompt(litmus.promptFile);
    } catch (e) {
      console.log(
        `[litmus] Could not load prompt file ${litmus.promptFile}, skipping litmus test`,
      );
      return { status: "approved", output: lastOutput };
    }

    const litmusTaskDesc = `Review the following content using the litmus test criteria below.

## Litmus Test Criteria
${litmusPromptContent}

## Content to Evaluate
${lastOutput}

IMPORTANT: Return a JSON object with "approved" (boolean), "scores" (object with criteria names as keys and 1-10 values), "rejection_reasons" (array of strings), and "improvement_suggestions" (array of strings).`;

    const litmusResult = await swarmClient.sendTaskAndWait(
      CONFIG.CONTENT_REVIEWER_ID,
      litmusTaskDesc,
      {
        timeoutMs: opts.litmusTimeout ?? CONFIG.LITMUS_TASK_TIMEOUT_MS,
        tags: ["litmus-test"],
      },
    );

    if (litmusResult.status !== "completed" || !litmusResult.output) {
      console.log("[litmus] Litmus test task failed, approving by default");
      return { status: "approved", output: lastOutput };
    }

    lastLitmusResult = parseLitmusResult(litmusResult.output) ?? undefined;

    if (!lastLitmusResult) {
      console.log("[litmus] Could not parse litmus result, approving by default");
      return { status: "approved", output: lastOutput };
    }

    if (lastLitmusResult.approved) {
      console.log(
        `[litmus] Approved with score ${lastLitmusResult.totalScore}/${lastLitmusResult.maxScore}`,
      );
      return {
        status: "approved",
        output: lastOutput,
        litmusResult: lastLitmusResult,
      };
    }

    console.log(
      `[litmus] Rejected (${lastLitmusResult.totalScore}/${lastLitmusResult.maxScore}): ${lastLitmusResult.rejectionReasons.join(", ")}`,
    );
  }

  // All retries exhausted
  console.log(
    `[litmus] All ${maxAttempts} attempts failed for ${litmus.promptFile}`,
  );
  return {
    status: "validation_failed",
    output: lastOutput,
    litmusResult: lastLitmusResult,
  };
}
