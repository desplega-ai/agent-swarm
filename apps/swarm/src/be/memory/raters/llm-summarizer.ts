/**
 * `runMemoryRater` — Stop-hook helper that calls OpenRouter for the combined
 * session-summary + LLM-rater piggyback prompt and returns a schema-validated
 * `SummaryWithRatings`.
 *
 * Refactored out of `src/hooks/hook.ts` so the rater logic stays out of the
 * hook (review feedback on PR #450). The hook just calls `runMemoryRater(...)`
 * and inspects the typed result.
 *
 * Worker-safe — uses raw `fetch` + the tolerant JSON parser landed in PR #447.
 * No `bun:sqlite` / `src/be/db` imports. Boundary script enforces this.
 */
import { z } from "zod";
import { type SummaryWithRatings, SummaryWithRatingsSchema } from "./llm";

/**
 * Default model used when `MEMORY_RATER_MODEL` is unset. Gemini 3 Flash on
 * OpenRouter — the only Gemini 3 Flash variant published as of this PR (no
 * stable non-preview slug exists yet). CLAUDE.md project-wide default.
 */
export const DEFAULT_MEMORY_RATER_MODEL = "google/gemini-3-flash-preview";

/**
 * `response_format.json_schema.name` sent to OpenRouter. Used by some
 * providers as a tag in their structured-output telemetry — keep it stable
 * so model behaviour stays comparable across calls.
 */
export const MEMORY_RATER_SCHEMA_NAME = "memory_rater_output";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * JSON Schema derived from {@link SummaryWithRatingsSchema}, the source of
 * truth. Computed once at module load via Zod v4's native `z.toJSONSchema`
 * (Zod v3's `zod-to-json-schema` is incompatible with the v4 runtime we
 * pin). The `$schema` key is stripped because OpenRouter / OpenAI strict
 * json_schema mode rejects unrecognized top-level keys.
 *
 * Probed end-to-end against `google/gemini-3-flash-preview` with
 * `response_format.json_schema.strict: true` — accepted, no rewrite needed.
 */
export const MEMORY_RATER_JSON_SCHEMA: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(SummaryWithRatingsSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

/**
 * Resolve the OpenRouter model slug. Reads `MEMORY_RATER_MODEL` from the env;
 * falls back to {@link DEFAULT_MEMORY_RATER_MODEL}. Self-hosters can pin a
 * different slug (e.g. `anthropic/claude-haiku-4.5`) without a code change.
 */
export function getMemoryRaterModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MEMORY_RATER_MODEL;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return DEFAULT_MEMORY_RATER_MODEL;
}

/**
 * Best-effort parse of a JSON string that may be wrapped in markdown fences
 * (```json … ``` or plain ``` … ```), have a prose preamble, or both. Returns
 * the parsed value or `null`. NEVER throws.
 *
 * Strategy: try strict parse first. On failure, strip a leading ```json /
 * ```<lang> / ``` fence + matching trailing ```; on second failure, slice
 * from the first `{` to the last `}` and retry.
 *
 * Originally landed in PR #447 to recover ratings from Haiku's occasional
 * fenced/preambled output despite `response_format: {type: "json_object"}`.
 * Restored here to harden the OpenRouter direct-HTTP path against the same
 * class of provider quirks (Gemini Flash also occasionally fences output).
 */
export function tryParseLooseJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence-stripping
  }
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

export type RunMemoryRaterOpts = {
  /** The fully-built prompt (e.g. from `buildSummaryWithRatingsPrompt`). */
  prompt: string;
  /** OpenRouter API key. Caller is responsible for the no-op-when-unset gate. */
  apiKey: string;
  /** Model slug override; falls through to {@link getMemoryRaterModel}. */
  model?: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Bytes to keep when logging unexpected response payloads. Capped to avoid
   * leaking very large bodies into stderr.
   */
  responseLogCap?: number;
};

export type RunMemoryRaterResult =
  | { ok: true; data: SummaryWithRatings; model: string }
  | {
      ok: false;
      reason: "transport" | "http_error" | "empty_content" | "parse" | "schema";
      status?: number;
    };

/**
 * Call OpenRouter's chat completions endpoint with `response_format` =
 * `json_object`, then parse and schema-validate the assistant's content.
 *
 * Returns a tagged union: `ok: true` with a typed `SummaryWithRatings`, or
 * `ok: false` with a `reason` discriminator the caller can branch on for
 * logging. NEVER throws — the hook wraps this in its own try/catch as a
 * second line of defence, but this function is designed to short-circuit
 * cleanly rather than propagate exceptions.
 */
export async function runMemoryRater(opts: RunMemoryRaterOpts): Promise<RunMemoryRaterResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const model = opts.model ?? getMemoryRaterModel();
  const responseLogCap = opts.responseLogCap ?? 200;

  let res: Response;
  try {
    res = await fetchFn(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        // OpenRouter strict json_schema — forces the provider's structured-
        // output guardrails on instead of the looser `json_object` mode.
        // Schema is derived from the same Zod source of truth, so the
        // request and the post-validation Zod check can't drift.
        // https://openrouter.ai/docs/guides/features/structured-outputs
        response_format: {
          type: "json_schema",
          json_schema: {
            name: MEMORY_RATER_SCHEMA_NAME,
            strict: true,
            schema: MEMORY_RATER_JSON_SCHEMA,
          },
        },
        messages: [{ role: "user", content: opts.prompt }],
      }),
    });
  } catch (err) {
    console.error("[memory-rater:llm] runMemoryRater fetch threw:", (err as Error).message);
    return { ok: false, reason: "transport" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[memory-rater:llm] OpenRouter ${res.status} ${res.statusText}: ${text.slice(0, responseLogCap)}`,
    );
    return { ok: false, reason: "http_error", status: res.status };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    console.error("[memory-rater:llm] OpenRouter response was not JSON:", (err as Error).message);
    return { ok: false, reason: "parse" };
  }

  const content = extractContent(body);
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, reason: "empty_content" };
  }

  const candidate = tryParseLooseJson(content);
  if (candidate === null || typeof candidate !== "object") {
    return { ok: false, reason: "parse" };
  }

  const parsed = SummaryWithRatingsSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: "schema" };
  }
  return { ok: true, data: parsed.data, model };
}

/**
 * Pull `choices[0].message.content` out of an OpenRouter chat-completion
 * response defensively. Returns the string, or `null` when the shape doesn't
 * match — caller treats that as `empty_content`.
 */
function extractContent(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}
