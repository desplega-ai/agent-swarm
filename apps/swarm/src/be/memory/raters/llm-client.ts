/**
 * `LlmRaterClient` — pluggable LLM driver used by `LlmRater` to score the
 * usefulness of a single retrieved memory against a (query, response) pair.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-4.md §1
 *
 * This module is imported from worker-side `src/hooks/hook.ts` (the session-
 * summary piggyback path), so it MUST NOT touch `bun:sqlite` or `src/be/db`.
 * The DB-boundary check in `scripts/check-db-boundary.sh` enforces this.
 *
 * Default implementation shells out to the same `claude -p` CLI the hook
 * already uses for session summarization — zero new SDK dependencies.
 */

export type LlmRaterInput = {
  /** What the agent asked the memory system for. */
  query: string;
  /** The memory we're scoring. */
  memory: {
    id: string;
    name: string;
    content: string;
  };
  /** The agent's eventual response (or session summary) — the "did this help?" signal. */
  response: string;
};

export type LlmRaterResult = {
  /** Usefulness score in [0, 1]. 0 = misleading, 1 = highly useful. */
  score: number;
  /** Short human-readable explanation. */
  reasoning: string;
};

export interface LlmRaterClient {
  /**
   * Score one memory. Returns null on parse failure / non-JSON output / timeout
   * — the caller (`LlmRater`) treats `null` as "skip this rating", no posterior
   * change. Implementations MUST NOT throw on transport errors; swallow + log
   * + return null so the worker hook can never crash on rater failure.
   */
  rate(input: LlmRaterInput): Promise<LlmRaterResult | null>;
}

/**
 * Configuration for the Claude-CLI implementation.
 */
export type ClaudeCliLlmRaterClientOptions = {
  /** Override the model. Defaults to `MEMORY_LLM_RATER_MODEL` env var or "haiku". */
  model?: string;
  /** Soft timeout (ms) for the `claude -p` shell-out. Default 30s. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30000;

const PROMPT_TEMPLATE = `You are scoring the usefulness of one retrieved memory.

Return ONLY a JSON object with these fields (no prose, no markdown):
{
  "score": number,        // 0 = misleading/unhelpful, 1 = highly useful
  "reasoning": string     // 1..500 chars, why
}

QUERY:
\${query}

MEMORY:
id: \${memoryId}
name: \${memoryName}
content: \${memoryContent}

AGENT RESPONSE / SUMMARY:
\${response}

Score 0..1.`;

const PLACEHOLDER_PREFIX = "$";
const QUERY_PLACEHOLDER = `${PLACEHOLDER_PREFIX}{query}`;
const MEMORY_ID_PLACEHOLDER = `${PLACEHOLDER_PREFIX}{memoryId}`;
const MEMORY_NAME_PLACEHOLDER = `${PLACEHOLDER_PREFIX}{memoryName}`;
const MEMORY_CONTENT_PLACEHOLDER = `${PLACEHOLDER_PREFIX}{memoryContent}`;
const RESPONSE_PLACEHOLDER = `${PLACEHOLDER_PREFIX}{response}`;

/**
 * `claude -p --output-format json` returns a JSON envelope of the shape
 * `{ result: string, ... }`. We parse the envelope, then JSON-parse the
 * inner `result` to recover the score+reasoning object.
 */
type ClaudeCliEnvelope = { result?: unknown };

function buildPrompt(input: LlmRaterInput): string {
  return PROMPT_TEMPLATE.replace(QUERY_PLACEHOLDER, input.query)
    .replace(MEMORY_ID_PLACEHOLDER, input.memory.id)
    .replace(MEMORY_NAME_PLACEHOLDER, input.memory.name)
    .replace(MEMORY_CONTENT_PLACEHOLDER, input.memory.content)
    .replace(RESPONSE_PLACEHOLDER, input.response);
}

function parseScoreAndReasoning(raw: unknown): LlmRaterResult | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { score?: unknown; reasoning?: unknown };
  const score = typeof obj.score === "number" ? obj.score : null;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : null;
  if (score == null || reasoning == null) return null;
  if (!Number.isFinite(score) || score < 0 || score > 1) return null;
  if (reasoning.length === 0 || reasoning.length > 500) return null;
  return { score, reasoning };
}

export class ClaudeCliLlmRaterClient implements LlmRaterClient {
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliLlmRaterClientOptions = {}) {
    this.model = opts.model ?? process.env.MEMORY_LLM_RATER_MODEL ?? "haiku";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async rate(input: LlmRaterInput): Promise<LlmRaterResult | null> {
    const prompt = buildPrompt(input);
    const tmpFile = `/tmp/llm-rater-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;

    let stdout = "";
    try {
      await Bun.write(tmpFile, prompt);
      const proc = Bun.spawn(
        ["bash", "-c", `cat "${tmpFile}" | claude -p --model ${this.model} --output-format json`],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, SKIP_SESSION_SUMMARY: "1" },
        },
      );
      const timeoutId = setTimeout(() => proc.kill(), this.timeoutMs);
      stdout = await new Response(proc.stdout).text();
      clearTimeout(timeoutId);
    } catch (err) {
      console.error("[memory-rater:llm] claude -p shell-out failed:", (err as Error).message);
      return null;
    } finally {
      try {
        await Bun.$`rm -f ${tmpFile}`.quiet();
      } catch {
        // best-effort
      }
    }

    let envelope: ClaudeCliEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
    } catch {
      return null;
    }
    return parseScoreAndReasoning(envelope.result);
  }
}

/**
 * Factory honouring `MEMORY_LLM_RATER_PROVIDER` — defaults to `claude-cli`.
 * Unknown providers fall back to the Claude CLI default and log a warning so
 * misconfiguration never crashes the worker.
 */
export function getDefaultLlmRaterClient(): LlmRaterClient {
  const provider = (process.env.MEMORY_LLM_RATER_PROVIDER ?? "claude-cli").trim();
  if (provider !== "claude-cli") {
    console.warn(
      `[memory-rater:llm] Unknown MEMORY_LLM_RATER_PROVIDER "${provider}" — falling back to claude-cli`,
    );
  }
  return new ClaudeCliLlmRaterClient();
}
