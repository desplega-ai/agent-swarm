/**
 * General-purpose structured-output LLM wrapper.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 0 § "complete-structured.ts"
 *
 * Context-agnostic: callable from both worker subprocesses and the API
 * server. Resolves a credential per the precedence in `./credentials.ts`,
 * then either:
 *   - Calls pi-ai's `complete()` with a single typebox-defined tool and
 *     extracts the tool-call payload (provider/anthropic/openai/openai-codex
 *     paths), OR
 *   - Shells out to `claude -p` (CLAUDE_CODE_OAUTH_TOKEN fallback path).
 *
 * Worker-safe: uses fetch() only, no bun:sqlite import.
 */

import type { ToolCall } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import type { TSchema } from "typebox";
import { z } from "zod";
import { type ResolvedCredential, resolveCredential } from "./credentials.js";
import { parseModelStr } from "./models.js";

export interface CompleteStructuredOptions<TZod extends z.ZodTypeAny> {
  /** Zod schema used for output validation (final source of truth). */
  zodSchema: TZod;
  /** Typebox schema used as pi-ai `Tool.parameters` (provider-side validation). */
  toolSchema: TSchema;
  toolName: string;
  toolDescription: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Optional context for codex-OAuth lookup. When omitted, only env vars are tried.
   * - Workers: pass `config.apiUrl` / `config.apiKey`.
   * - API server: pass `MCP_BASE_URL` / `API_KEY` (loopback).
   * - Skip entirely to disable codex OAuth probing.
   */
  apiUrl?: string;
  apiKey?: string;
  /** Default: 3. */
  retries?: number;
  signal?: AbortSignal;
  /** Optional diagnostic tag (e.g. `"session-summary:pi"`). */
  callerTag?: string;
  // Test injection points:
  _resolveCredential?: typeof resolveCredential;
  _complete?: typeof complete;
  _spawnClaudeCli?: (
    prompt: string,
    model: string,
    signal?: AbortSignal,
    jsonSchema?: object,
  ) => Promise<string>;
  /**
   * Bypass `resolveCredential` entirely — opencode auth path (and tests)
   * pass an already-resolved credential.
   */
  _credentialOverride?: ResolvedCredential;
}

/**
 * Default 30s timeout for the `claude -p` shellout — matches the existing
 * pattern in `src/providers/pi-mono-extension.ts:328-351` (the call site
 * being retired in Phase 1).
 */
const CLAUDE_CLI_TIMEOUT_MS = 30_000;

/**
 * Tolerant JSON extractor for `claude -p` `result` strings. Claude sometimes
 * wraps JSON in ```json … ``` fences despite a "no code fences" prompt; this
 * peels off the fence so `JSON.parse` can handle it.
 */
function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenced?.[1] ? fenced[1].trim() : trimmed;
}

/** Exported for tests only — production callers go through `completeStructured`. */
export async function defaultSpawnClaudeCli(
  prompt: string,
  model: string,
  signal?: AbortSignal,
  jsonSchema?: object,
): Promise<string> {
  // CLAUDE_BINARY may be a single binary, an absolute path, or a
  // whitespace-separated command string.
  const claudeBinaryRaw = (process.env.CLAUDE_BINARY ?? "claude").trim();
  const claudeBinaryArgv = (claudeBinaryRaw || "claude").split(/\s+/);
  const cmd = [...claudeBinaryArgv, "-p", "--model", model, "--output-format", "json"];
  if (jsonSchema) {
    cmd.push("--json-schema", JSON.stringify(jsonSchema));
  }
  // The hook subprocess receives an empty CLAUDE_CODE_OAUTH_TOKEN (claude
  // CLI strips it from hooks). Restore it from the mirror set by
  // claude-adapter.ts so the inner `claude -p` invocation authenticates.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && env.AGENT_SWARM_CLAUDE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = env.AGENT_SWARM_CLAUDE_OAUTH_TOKEN;
  }
  // Recursion guard: this shellout is itself a full claude session — on exit it
  // fires the same global Stop hook, whose session-summary path would spawn
  // another `claude -p`, recursively (each level holds a ~0.5-1GB node process;
  // observed OOM-wedging 8GB E2B worker sandboxes within ~90s, leaving 10+
  // near-identical summarizer transcripts in ~/.claude/projects). The hook's
  // `runStopHookSessionSummary` honors this flag — same convention as the
  // `claude -p` shellout in `src/be/memory/raters/llm-client.ts`.
  env.SKIP_SESSION_SUMMARY = "1";
  const proc = Bun.spawn({
    cmd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore — process may have already exited
    }
  }, CLAUDE_CLI_TIMEOUT_MS);
  const abortHandler = () => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };
  signal?.addEventListener("abort", abortHandler, { once: true });
  try {
    proc.stdin.write(prompt);
    await proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      console.error(`internal-ai: claude -p exited ${exitCode}; stderr=${stderr.slice(0, 500)}`);
    }
    // claude -p --output-format json envelope shape:
    //   { ..., result: "<text>", structured_output?: <validated-object> }
    // When --json-schema is passed, prefer `structured_output` (validated
    // by claude server-side). When it's absent, fall back to `result` — the
    // caller has also embedded the schema in the prompt so `result` should
    // be valid JSON; if it isn't, the caller's JSON.parse retry surfaces it.
    try {
      const envelope = JSON.parse(stdout) as { result?: string; structured_output?: unknown };
      if (jsonSchema && envelope.structured_output !== undefined) {
        return JSON.stringify(envelope.structured_output);
      }
      return envelope.result ?? stdout;
    } catch {
      return stdout;
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortHandler);
  }
}

/**
 * Run a structured-output completion. Returns the parsed object on success,
 * `null` on auth-missing or exhausted retries (errors logged, never thrown).
 */
export async function completeStructured<TZod extends z.ZodTypeAny>(
  opts: CompleteStructuredOptions<TZod>,
): Promise<z.infer<TZod> | null> {
  const retries = opts.retries ?? 3;
  const callerTag = opts.callerTag ?? "<unset>";

  // 1. Resolve credential (or use override).
  let cred: ResolvedCredential | null;
  if (opts._credentialOverride) {
    cred = opts._credentialOverride;
  } else {
    const resolver = opts._resolveCredential ?? resolveCredential;
    cred = await resolver({
      env: process.env,
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      callerTag: opts.callerTag,
    });
  }
  if (!cred) {
    // No auth — graceful no-op. Don't log noisily; callers may invoke this
    // routinely in environments without LLM credentials.
    return null;
  }

  // Always-on debug log — relied on by Manual E2E Scenario 5 + Phase 4 QA.
  console.log(`internal-ai: kind=${cred.kind} callerTag=${callerTag}`);

  // 2. Claude-CLI fallback path.
  if (cred.kind === "claude-cli") {
    const spawn = opts._spawnClaudeCli ?? defaultSpawnClaudeCli;
    // Belt-and-suspenders: pass the schema both as `--json-schema` (sets
    // `envelope.structured_output` when the model complies) AND inline in
    // the prompt (forces JSON-only `envelope.result` when it doesn't).
    // The CLI flag alone is unreliable — claude sometimes asks "where's
    // the schema?" if the prompt doesn't reference one.
    const jsonSchema = z.toJSONSchema(opts.zodSchema) as object;
    const schemaStr = JSON.stringify(jsonSchema);
    const claudeUserPrompt = `${opts.userPrompt}\n\nRespond with ONLY a JSON object (no prose, no code fences) matching this schema:\n${schemaStr}`;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const raw = await spawn(
          `${opts.systemPrompt}\n\n${claudeUserPrompt}`,
          cred.modelDefault,
          opts.signal,
          jsonSchema,
        );
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(stripJsonFences(raw));
        } catch (err) {
          lastErr = err;
          continue;
        }
        const validated = opts.zodSchema.safeParse(parsedJson);
        if (validated.success) {
          return validated.data;
        }
        lastErr = validated.error;
      } catch (err) {
        lastErr = err;
      }
    }
    console.error(
      `internal-ai: structured output failed after ${retries} retries (callerTag=${callerTag} kind=${cred.kind})`,
      lastErr,
    );
    return null;
  }

  // 3. pi-ai path (openrouter / anthropic / openai / openai-codex).
  const [provider, modelId] = parseModelStr(cred.modelDefault);
  let model: ReturnType<typeof getModel>;
  try {
    // The typed overload is too restrictive for our dynamic-string case; the
    // runtime tolerates any registered (provider, id) pair.
    model = getModel(provider as Parameters<typeof getModel>[0], modelId as never);
  } catch (err) {
    console.error(
      `internal-ai: getModel(${provider}, ${modelId}) threw (callerTag=${callerTag})`,
      err,
    );
    return null;
  }

  const completeFn = opts._complete ?? complete;
  let userPrompt = opts.userPrompt;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const msg = await completeFn(
        model,
        {
          systemPrompt: opts.systemPrompt,
          messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
          tools: [
            {
              name: opts.toolName,
              description: opts.toolDescription,
              parameters: opts.toolSchema,
            },
          ],
        },
        // pi-ai's ProviderStreamOptions type only allows known providers;
        // we pass the validated apiKey through verbatim.
        { apiKey: cred.apiKey, signal: opts.signal } as Parameters<typeof completeFn>[2],
      );

      const toolCall = msg.content.find(
        (c): c is ToolCall => c.type === "toolCall" && c.name === opts.toolName,
      );
      if (!toolCall) {
        userPrompt = `${userPrompt}\n\nYou did not call the ${opts.toolName} tool. You MUST call it with the requested arguments.`;
        lastErr = new Error("no tool call in response");
        continue;
      }

      const validated = opts.zodSchema.safeParse(toolCall.arguments);
      if (validated.success) {
        return validated.data;
      }
      userPrompt = `${userPrompt}\n\nThe ${opts.toolName} arguments did not validate: ${validated.error.message}. Please retry with correct arguments.`;
      lastErr = validated.error;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(
    `internal-ai: structured output failed after ${retries} retries (callerTag=${callerTag} kind=${cred.kind})`,
    lastErr,
  );
  return null;
}
