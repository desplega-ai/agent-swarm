/**
 * Task title generation: a short display title for a task prompt.
 *
 * Consumer of `completeStructuredWithModel`. Walks `TASK_TITLE_MODEL_CANDIDATES`
 * (provider order, then model order) and returns the first title a configured
 * credential produces. Every candidate is a cheap, fast model: one title costs
 * well under a tenth of a cent, so thousands of weekly tasks stay in cents.
 *
 * Worker-safe: no bun:sqlite import. The API server wires it to task creation
 * in `src/be/task-auto-title-listener.ts`.
 */

import { Type } from "typebox";
import { z } from "zod";
import { scrubSecrets } from "../secret-scrubber.js";
import { completeStructuredWithModel } from "./complete-structured.js";
import { type CredentialKind, type ResolvedCredential, resolveCredentials } from "./credentials.js";
import { kindForModelString } from "./models.js";

/** Longest generated title. The PATCH /api/tasks/{id}/title route allows 120. */
export const TASK_TITLE_MAX_CHARS = 100;
/** Prompts shorter than this keep the prompt itself as the display title. */
export const TASK_TITLE_MIN_TASK_CHARS = 48;
/** Prompt text sent to the model is cut here. Keeps every call small. */
export const TASK_TITLE_MAX_TASK_CHARS = 2000;
/** Whole generation, across every candidate. */
export const TASK_TITLE_TIMEOUT_MS = 20_000;

/** Env var that pins one model (`provider/model-id`, or a `claude -p` alias). */
export const TASK_TITLE_MODEL_ENV = "TASK_AUTO_TITLE_MODEL";

export interface TaskTitleCandidateGroup {
  kind: CredentialKind;
  /** Full model strings for this credential kind, best first. */
  models: readonly string[];
}

/**
 * Provider order, then model order within a provider. Cheapest and fastest
 * first: pay-per-token API keys before subscription OAuth, and the `claude -p`
 * shellout last (it spawns a full CLI process per call).
 *
 * Model prices (input / output, USD per million tokens, models.dev snapshot):
 *   deepseek-v4.1-flash 0.034 / 0.137 · claude-haiku-5.5 0.10 / 0.50 ·
 *   gpt-6-luna 0.10 / 0.50 · gpt-5-nano 0.05 / 0.40
 */
export const TASK_TITLE_MODEL_CANDIDATES: readonly TaskTitleCandidateGroup[] = [
  {
    kind: "openrouter",
    models: [
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/anthropic/claude-haiku-5.5",
      "openrouter/openai/gpt-6-luna",
    ],
  },
  { kind: "anthropic", models: ["anthropic/claude-haiku-5-5"] },
  { kind: "openai", models: ["openai/gpt-6-luna", "openai/gpt-5-nano"] },
  { kind: "openai-codex", models: ["openai-codex/gpt-6-luna"] },
  { kind: "claude-cli", models: ["haiku"] },
];

export { kindForModelString };

/**
 * The candidate list for one environment. `TASK_AUTO_TITLE_MODEL` moves its
 * provider to the front and puts the pinned model first inside it; the rest of
 * the list stays as fallback. An unknown provider is ignored with a warning.
 */
export function buildTaskTitlePlan(
  env: Record<string, string | undefined> = process.env,
): readonly TaskTitleCandidateGroup[] {
  const pinned = env[TASK_TITLE_MODEL_ENV]?.trim();
  if (!pinned) return TASK_TITLE_MODEL_CANDIDATES;
  const kind = kindForModelString(pinned);
  if (!kind) {
    console.warn(
      `[task-title] ${TASK_TITLE_MODEL_ENV}=${pinned} names an unsupported provider; ignored`,
    );
    return TASK_TITLE_MODEL_CANDIDATES;
  }
  const own = TASK_TITLE_MODEL_CANDIDATES.find((group) => group.kind === kind);
  const rest = TASK_TITLE_MODEL_CANDIDATES.filter((group) => group.kind !== kind);
  const models = [pinned, ...(own?.models ?? []).filter((model) => model !== pinned)];
  return [{ kind, models }, ...rest];
}

const SIBLING_OPEN = "<sibling_tasks_in_progress>";
const SIBLING_CLOSE = "</sibling_tasks_in_progress>";

/**
 * Task text as the model should see it: without the sibling-awareness block
 * the API prepends to child tasks, with runs of blank lines collapsed, and cut
 * to `TASK_TITLE_MAX_TASK_CHARS`.
 */
export function prepareTaskTextForTitle(task: string): string {
  let text = task;
  if (text.startsWith(SIBLING_OPEN)) {
    const close = text.indexOf(SIBLING_CLOSE);
    if (close !== -1) text = text.slice(close + SIBLING_CLOSE.length);
  }
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > TASK_TITLE_MAX_TASK_CHARS) {
    text = `${text.slice(0, TASK_TITLE_MAX_TASK_CHARS).trimEnd()} …`;
  }
  return text;
}

const WRAPPING_QUOTES: ReadonlyArray<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
  ["«", "»"],
];

/**
 * Clean a model-produced title: one line, no wrapping quotes or `Title:`
 * prefix, no markdown emphasis, no trailing sentence punctuation, at most
 * `TASK_TITLE_MAX_CHARS` (cut at a word boundary). Empty string when nothing
 * usable remains.
 */
export function normalizeTaskTitle(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  title = title.replace(/^title\s*:\s*/i, "");
  title = title.replace(/\*\*|__|^#+\s*/g, "");
  const stripTrailingPunctuation = () => {
    title = title.replace(/[.!…]+$/u, "").trim();
  };
  // Quotes can sit inside or outside the trailing punctuation: `"Title".` and `"Title…"`.
  stripTrailingPunctuation();
  for (const [open, close] of WRAPPING_QUOTES) {
    if (title.length >= 2 && title.startsWith(open) && title.endsWith(close)) {
      title = title.slice(open.length, title.length - close.length).trim();
    }
  }
  stripTrailingPunctuation();
  if (title.length > TASK_TITLE_MAX_CHARS) {
    const cut = title.slice(0, TASK_TITLE_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    title = (lastSpace >= TASK_TITLE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
    title = title.replace(/[,;:\-–—]+$/u, "").trimEnd();
  }
  return title;
}

export const TASK_TITLE_SYSTEM_PROMPT = [
  "You write titles for tasks on a software team's dashboard.",
  "Rules:",
  "- 3 to 8 words, at most 80 characters.",
  "- Sentence case. No trailing period. No quotes, markdown, emoji, or task ids.",
  "- Name the concrete subject (feature, bug, repo, file, system, person), not a generic verb alone.",
  "- Keep the language of the request.",
  "- Ignore pasted logs, code, and context blocks; title the request itself.",
  "Call the set_title tool with the title.",
].join("\n");

export const TASK_TITLE_TOOL_NAME = "set_title";

const TaskTitleZodSchema = z.object({ title: z.string().trim().min(1).max(200) });
const TaskTitleToolSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, description: "The task title." }),
});

export interface GenerateTaskTitleOptions {
  /** Full task prompt as stored on the task. */
  task: string;
  /** Credential lookup env. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Optional loopback context for the codex OAuth probe (see `resolveCredentials`). */
  apiUrl?: string;
  apiKey?: string;
  signal?: AbortSignal;
  /** Diagnostic tag forwarded to `completeStructured` logs. */
  callerTag?: string;
  // Test injection points:
  _resolveCredentials?: typeof resolveCredentials;
  _completeStructured?: typeof completeStructuredWithModel;
}

export type GenerateTaskTitleResult =
  | { ok: true; title: string; model: string; kind: CredentialKind }
  | { ok: false; reason: "short-task" | "no-credentials" | "all-models-failed" };

/**
 * Generate a title for `task`. Never throws: a provider error moves on to the
 * next candidate, and exhausting the list returns `{ ok: false }`.
 */
export async function generateTaskTitle(
  opts: GenerateTaskTitleOptions,
): Promise<GenerateTaskTitleResult> {
  const text = prepareTaskTextForTitle(opts.task);
  if (text.length < TASK_TITLE_MIN_TASK_CHARS) return { ok: false, reason: "short-task" };

  const env = opts.env ?? process.env;
  const resolve = opts._resolveCredentials ?? resolveCredentials;
  const complete = opts._completeStructured ?? completeStructuredWithModel;
  const callerTag = opts.callerTag ?? "task-title";
  const plan = buildTaskTitlePlan(env);

  // One lookup per kind, on demand, so the codex OAuth probe (an HTTP call
  // that can rotate a refresh token) runs only when its turn comes.
  const credentialCache = new Map<CredentialKind, ResolvedCredential | null>();
  const credentialFor = async (kind: CredentialKind): Promise<ResolvedCredential | null> => {
    const cached = credentialCache.get(kind);
    if (cached !== undefined) return cached;
    const [cred] = await resolve({
      env,
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      callerTag,
      kinds: [kind],
      limit: 1,
    });
    credentialCache.set(kind, cred ?? null);
    return cred ?? null;
  };

  let sawCredential = false;
  for (const group of plan) {
    if (opts.signal?.aborted) break;
    const cred = await credentialFor(group.kind);
    if (!cred) continue;
    sawCredential = true;
    for (const model of group.models) {
      if (opts.signal?.aborted) break;
      const title = await attemptTitle(complete, {
        cred,
        model,
        text,
        env,
        callerTag,
        signal: opts.signal,
      });
      if (title) return { ok: true, title, model, kind: cred.kind };
    }
  }
  return { ok: false, reason: sawCredential ? "all-models-failed" : "no-credentials" };
}

interface TitleAttempt {
  cred: ResolvedCredential;
  model: string;
  text: string;
  env: Record<string, string | undefined>;
  callerTag: string;
  signal?: AbortSignal;
}

/** One model call. `completeStructuredWithModel` swallows provider errors; a throw here is still just a miss. */
async function attemptTitle(
  complete: typeof completeStructuredWithModel,
  attempt: TitleAttempt,
): Promise<string> {
  try {
    const result = await complete({
      zodSchema: TaskTitleZodSchema,
      toolSchema: TaskTitleToolSchema,
      toolName: TASK_TITLE_TOOL_NAME,
      toolDescription: "Record the title for this task.",
      systemPrompt: TASK_TITLE_SYSTEM_PROMPT,
      userPrompt: `Task request:\n\n${attempt.text}`,
      env: attempt.env,
      retries: 1,
      signal: attempt.signal,
      callerTag: `${attempt.callerTag}:${attempt.model}`,
      _credentialOverride: { ...attempt.cred, modelDefault: attempt.model },
    });
    return result ? normalizeTaskTitle(result.data.title) : "";
  } catch (error) {
    // Provider errors can echo request fragments; scrub before logging.
    console.error(
      scrubSecrets(
        `[task-title] ${attempt.model} threw: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return "";
  }
}
