/**
 * `LlmRater` — second live rater, source = "llm".
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-4.md §2-3
 *
 * The worker-side flow does NOT call `LlmRater.rate(ctx)` from the in-process
 * server-rater orchestrator. Instead, the rating LLM call is piggybacked on
 * the existing session-summary call in `src/hooks/hook.ts` (cost optimization
 * — same Haiku invocation produces both summary text + per-memory ratings).
 * The hook then POSTs the constructed `RatingEvent[]` to `/api/memory/rate`.
 *
 * `LlmRater.rate(ctx)` is wired up so the class still satisfies `MemoryRater`
 * for registry consistency / future direct integrations / unit tests, but is
 * never invoked by `runServerRaters` (LlmRater is NOT in `SERVER_RATERS`).
 *
 * This module is imported from worker-side `src/hooks/hook.ts` so it MUST NOT
 * touch `bun:sqlite` or `src/be/db`. The boundary check enforces it.
 */
import { z } from "zod";
import { ClaudeCliLlmRaterClient, type LlmRaterClient, type LlmRaterResult } from "./llm-client";
import {
  type MemoryRater,
  type RatingContext,
  type RatingEvent,
  REFERENCES_SOURCE_MAX_LENGTH,
  sanitizeReferencesSource,
} from "./types";

/**
 * Per-rating weight, fixed at 0.8 per the research-doc convention
 * ("LLM intent_weight"). Encoded here once so neither callers nor tests can
 * silently drift the constant.
 */
export const LLM_RATER_WEIGHT = 0.8;

const RatingSchema = z.object({
  id: z.string().min(1),
  score: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(500),
  // Step-6 §6 — optional free-form external source ID. Q2 contract: ≤512
  // chars, no closed enum, no prefix parser. Sanitization (control-char
  // strip + NUL rejection) happens in `buildRatingsFromLlm` so a single
  // bad rating drops the field rather than failing the whole batch.
  referencesSource: z.string().min(1).max(REFERENCES_SOURCE_MAX_LENGTH).optional(),
});

/**
 * Zod schema for the structured-output piggyback prompt. The hook asks the
 * summarizer LLM to return summary + per-memory ratings in one JSON object so
 * we don't pay for N additional LLM calls.
 */
export const SummaryWithRatingsSchema = z.object({
  summary: z.string(),
  ratings: z.array(RatingSchema).default([]),
});

export type LlmRating = z.infer<typeof RatingSchema>;
export type SummaryWithRatings = z.infer<typeof SummaryWithRatingsSchema>;

/** Context augmentations LlmRater consumes when called directly (per-memory path). */
export type LlmRatingContext = RatingContext & {
  /** What the agent asked the memory system. */
  query?: string;
  /** Final agent response / summary used as the "did this help?" signal. */
  response?: string;
  /** Snapshots for memories listed in `retrievedMemoryIds` (id-aligned by id). */
  retrievedMemories?: { id: string; name: string; content: string }[];
};

export class LlmRater implements MemoryRater {
  readonly name = "llm";

  constructor(public readonly client: LlmRaterClient = new ClaudeCliLlmRaterClient()) {}

  /**
   * Per-memory scoring path. The production hook bypasses this method and
   * calls {@link buildRatingsFromLlm} on the piggybacked summarizer JSON
   * (one LLM invocation, not N). Direct callers (tests, future integrations)
   * MUST pass {@link LlmRatingContext} — the base `RatingContext` carries
   * only memory IDs, which is insufficient to drive `LlmRaterClient.rate`.
   *
   * Returns `[]` when the augmented fields are missing so the rater stays a
   * no-op rather than crashing on a `RatingContext`-only invocation.
   */
  async rate(ctx: RatingContext): Promise<RatingEvent[]> {
    const enriched = ctx as LlmRatingContext;
    if (enriched.retrievedMemoryIds.length === 0) return [];
    const memories = enriched.retrievedMemories;
    if (!memories || memories.length === 0) return [];

    const events: RatingEvent[] = [];
    for (const memoryId of enriched.retrievedMemoryIds) {
      const memory = memories.find((m) => m.id === memoryId);
      if (!memory) continue;
      let result: LlmRaterResult | null;
      try {
        result = await this.client.rate({
          query: enriched.query ?? "",
          memory,
          response: enriched.response ?? enriched.evidence ?? "",
        });
      } catch (err) {
        console.error(
          `[memory-rater:llm] client.rate threw for memoryId=${memoryId}:`,
          (err as Error).message,
        );
        continue;
      }
      if (!result) continue;
      events.push({
        memoryId,
        signal: 2 * result.score - 1,
        weight: LLM_RATER_WEIGHT,
        // Framework stamps `source = rater.name` in `runServerRaters`. Raters
        // that populate `source` themselves are rejected by `applyRating`.
        source: "",
        reasoning: result.reasoning,
      });
    }
    return events;
  }
}

/**
 * Convert the piggybacked summary's `ratings` array into `RatingEvent[]` for
 * `POST /api/memory/rate`. Drops ratings whose `id` was not in the original
 * retrieval set (defence-in-depth — the LLM occasionally hallucinates memory
 * IDs; the server-side R6 check catches it too, but rejecting upstream keeps
 * the audit log cleaner).
 *
 * Mapping: `signal = 2 * score - 1` (0 → -1, 0.5 → 0, 1 → +1).
 * Weight = {@link LLM_RATER_WEIGHT} (0.8).
 * Source = `"llm"` (the HTTP rate endpoint enums `["llm", "explicit-self"]`).
 */
export function buildRatingsFromLlm(
  ratings: LlmRating[],
  retrievals: { id: string }[],
): RatingEvent[] {
  const allowed = new Set(retrievals.map((r) => r.id));
  const events: RatingEvent[] = [];
  for (const r of ratings) {
    if (!allowed.has(r.id)) continue;
    // Step-6 §6 — sanitize before propagation. If the LLM emits a NUL byte
    // or an all-control-chars string, drop the edge but keep the rating
    // (best-effort: the memory's own posterior still gets the signal).
    let cleanedReferencesSource: string | undefined;
    if (r.referencesSource !== undefined) {
      const cleaned = sanitizeReferencesSource(r.referencesSource);
      if (cleaned !== null) {
        cleanedReferencesSource = cleaned;
      }
    }
    events.push({
      memoryId: r.id,
      signal: 2 * r.score - 1,
      weight: LLM_RATER_WEIGHT,
      source: "llm",
      reasoning: r.reasoning,
      ...(cleanedReferencesSource !== undefined
        ? { referencesSource: cleanedReferencesSource }
        : {}),
    });
  }
  return events;
}

/**
 * Append a structured-output instruction to the existing summary prompt so
 * the same `claude -p` invocation produces both summary text AND per-memory
 * ratings against `SummaryWithRatingsSchema`.
 *
 * Memory `content` is truncated to {@link RETRIEVAL_PROMPT_CONTENT_CAP} chars
 * to keep the prompt within Haiku's context budget on long sessions; the
 * server already truncates `agent_memory.content` to 500 chars in the
 * retrievals endpoint, so this is the typical case.
 */
const RETRIEVAL_PROMPT_CONTENT_CAP = 600;

export function buildSummaryWithRatingsPrompt(
  basePrompt: string,
  retrievals: { id: string; name: string; content: string }[],
): string {
  if (retrievals.length === 0) return basePrompt;
  const memoryBlock = retrievals
    .map((m, i) => {
      const content =
        m.content.length > RETRIEVAL_PROMPT_CONTENT_CAP
          ? `${m.content.slice(0, RETRIEVAL_PROMPT_CONTENT_CAP)}…`
          : m.content;
      return `Memory #${i + 1}\n  id: ${m.id}\n  name: ${m.name}\n  content: ${content}`;
    })
    .join("\n\n");

  return `${basePrompt}

CRITICAL: Your entire response MUST be a single JSON object that conforms to the schema below. Do NOT wrap it in triple-backtick fences (no \`\`\`json or \`\`\`), do NOT add a prose preamble, do NOT add trailing commentary. Just the JSON object, nothing else.

Schema:
{
  "summary": string,                        // your existing summary text
  "ratings": [                              // one entry per memory you can score
    {
      "id": string,                         // memory id, copied from the list below
      "score": number,                      // 0 = misleading/unhelpful, 1 = highly useful
      "reasoning": string,                  // 1..500 chars, why
      "referencesSource": string            // OPTIONAL — see note below
    }
  ]
}

Score ONLY memories present in the list below. Use the exact ids. Omit any you cannot evaluate.

Optionally for each rating, if the memory clearly references a specific external source (a GitHub PR/issue, a Linear issue, a customer, a Slack thread, an AgentMail thread, etc.), include a \`referencesSource\` string using the convention "<source>:<identifier>" (e.g. "github:owner/repo#N", "linear:KEY-N", "customer:<slug>"). Any prefix is fine — pick what matches the source. Omit the field if no clear external source.

Memories retrieved during this session:

${memoryBlock}`;
}

/**
 * `MEMORY_RATERS=...` includes `llm`? Used by the hook to gate the piggyback
 * path — strict opt-in so existing deployments are byte-identical when unset.
 */
export function isLlmRaterEnabled(): boolean {
  const raw = process.env.MEMORY_RATERS;
  if (!raw || raw.trim() === "") return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes("llm");
}

/** Memory snapshot returned by `GET /api/memory/retrievals`. */
export type RetrievalRow = {
  id: string;
  name: string;
  content: string;
  scope?: string;
  similarity?: number | null;
  retrievedAt?: string;
};

/**
 * GET `/api/memory/retrievals?taskId=` — best-effort. Returns `[]` on any
 * failure so a transient API outage never blocks the summary-indexing path.
 */
export async function fetchRetrievalsForTask(opts: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId: string;
  fetchImpl?: typeof fetch;
}): Promise<RetrievalRow[]> {
  const fetchFn = opts.fetchImpl ?? fetch;
  try {
    const url = `${opts.apiUrl}/api/memory/retrievals?taskId=${encodeURIComponent(opts.taskId)}`;
    const res = await fetchFn(url, {
      headers: {
        "X-Agent-ID": opts.agentId,
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
    });
    if (!res.ok) {
      console.error(
        `[memory-rater:llm] GET /api/memory/retrievals failed: ${res.status} ${res.statusText}`,
      );
      return [];
    }
    const body = (await res.json()) as { results?: RetrievalRow[] };
    return body.results ?? [];
  } catch (err) {
    console.error("[memory-rater:llm] fetchRetrievalsForTask threw:", (err as Error).message);
    return [];
  }
}

/**
 * POST `/api/memory/rate` — best-effort. Logs on 4xx/5xx, never throws. The
 * worker hook wraps the whole rating block in its own try/catch as a final
 * line of defence — rater failure must never block summary indexing.
 */
export async function postRatings(opts: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId?: string;
  events: RatingEvent[];
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number }> {
  if (opts.events.length === 0) return { ok: true, status: 0 };
  const fetchFn = opts.fetchImpl ?? fetch;
  const events = opts.events.map((e) => ({
    memoryId: e.memoryId,
    signal: e.signal,
    weight: e.weight,
    source: e.source,
    ...(e.reasoning !== undefined ? { reasoning: e.reasoning } : {}),
    ...(e.referencesSource !== undefined ? { referencesSource: e.referencesSource } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
  }));
  try {
    const res = await fetchFn(`${opts.apiUrl}/api/memory/rate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-ID": opts.agentId,
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[memory-rater:llm] POST /api/memory/rate failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
      );
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error("[memory-rater:llm] postRatings threw:", (err as Error).message);
    return { ok: false, status: 0 };
  }
}
