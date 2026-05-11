/**
 * Opencode session summarization — vendored implementation.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 2
 *
 * WHY VENDORED: opencode loads plugins as raw TS inside its own bundled Bun
 * runtime, which exposes only `@opencode-ai/{plugin,sdk}` to plugin files.
 * The agent-swarm package (and its dep `@mariozechner/pi-ai`) is NOT
 * resolvable from inside the plugin sandbox, so the helpers from
 * `src/utils/internal-ai/*` and `src/be/memory/raters/llm.ts` are
 * re-implemented here with the same contracts but minimal surface area.
 *
 * Scope reductions vs the source-of-truth helpers in `src/`:
 *   - Direct HTTP calls to OpenRouter / Anthropic / OpenAI (no pi-ai
 *     adapter layer).
 *   - No codex-OAuth probe — opencode's auth.json already handles its own
 *     OAuth refresh via `opencode-auth.ts`.
 *   - No `claude-cli` fallback — opencode users with only
 *     `CLAUDE_CODE_OAUTH_TOKEN` get a graceful no-op (same as having no
 *     creds at all).
 *
 * Anything that needs to change here MUST also change in the corresponding
 * `src/` source-of-truth files (and vice versa). Drift will be caught by
 * the unit tests under `plugin/opencode-plugins/tests/` and
 * `src/tests/opencode-plugin.test.ts`.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";
import { type ResolvedCredential, resolveOpencodeAuth } from "./opencode-auth";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SwarmConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId: string;
  isLead: boolean;
}

export interface LlmRating {
  id: string;
  score: number;
  reasoning: string;
  referencesSource?: string;
}

export interface SummaryWithRatings {
  summary: string;
  ratings: LlmRating[];
}

export interface RetrievalRow {
  id: string;
  name: string;
  content: string;
  scope?: string;
  source?: string;
  scheduleId?: string | null;
}

export interface RatingEvent {
  memoryId: string;
  signal: number;
  weight: number;
  source: string;
  reasoning?: string;
  referencesSource?: string;
}

// Mirrored from src/be/memory/raters/llm.ts.
const LLM_RATER_WEIGHT = 0.8;
const REFERENCES_SOURCE_MAX_LENGTH = 512;
const RETRIEVAL_PROMPT_CONTENT_CAP = 600;

// ── Prompt building (mirrors src/be/memory/raters/llm.ts) ─────────────────────

const BASE_SUMMARIZE_PROMPT = `You are summarizing an AI agent's work session. Extract ONLY high-value learnings.

DO NOT include:
- Generic descriptions of what was done ("worked on task X")
- Tool calls or file reads
- Routine progress updates

DO include (if present):
- **Mistakes made and corrections** — what went wrong and what fixed it
- **Discovered patterns** — reusable approaches, APIs, or codebase conventions
- **Codebase knowledge** — important file paths, architecture decisions, gotchas
- **Environment knowledge** — service URLs, config details, tool quirks
- **Failed approaches** — what was tried and didn't work (and why)

Format as a bulleted list of concrete, reusable facts. If the session was routine with no significant learnings, respond with exactly: "No significant learnings."`;

export function buildSummaryWithRatingsPrompt(
  basePrompt: string,
  retrievals: RetrievalRow[],
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
  "summary": string,
  "ratings": [
    {
      "id": string,
      "score": number,
      "reasoning": string,
      "referencesSource": string
    }
  ]
}

Score ONLY memories present in the list below. Use the exact ids. Omit any you cannot evaluate.

Optionally for each rating, if the memory clearly references a specific external source (a GitHub PR/issue, a Linear issue, a customer, a Slack thread, an AgentMail thread, etc.), include a \`referencesSource\` string using the convention "<source>:<identifier>" (e.g. "github:owner/repo#N", "linear:KEY-N", "customer:<slug>"). Any prefix is fine — pick what matches the source. Omit the field if no clear external source.

Memories retrieved during this session:

${memoryBlock}`;
}

// ── Transcript flattening ─────────────────────────────────────────────────────

/**
 * Convert opencode's `Array<{info: Message; parts: Part[]}>` into a flat
 * `User:`/`Assistant:`/`Tool[name]: input=... output=...` line stream suitable
 * for the summarizer prompt. Drops reasoning, file, step-start, step-finish,
 * snapshot, patch, agent, retry, compaction parts — they're high-volume noise
 * for the learnings-extraction prompt.
 */
export function flattenOpencodeTranscript(items: Array<{ info: Message; parts: Part[] }>): string {
  const lines: string[] = [];
  for (const { info, parts } of items) {
    const role = info.role === "user" ? "User" : "Assistant";
    for (const part of parts) {
      if (part.type === "text") {
        lines.push(`${role}: ${part.text}`);
      } else if (part.type === "tool") {
        const tool = part.tool ?? "tool";
        const state = part.state;
        if (state && state.status === "completed") {
          const input = JSON.stringify(state.input ?? {}).slice(0, 500);
          const output = JSON.stringify(state.output ?? {}).slice(0, 1000);
          lines.push(`Tool[${tool}]: input=${input} output=${output}`);
        }
      }
      // ignore reasoning, file, step-start, step-finish, snapshot, patch,
      // agent, retry, compaction — see header comment.
    }
  }
  return lines.join("\n");
}

// ── LLM client (direct HTTP) ──────────────────────────────────────────────────

/**
 * Run the summary+ratings prompt against the resolved provider. Returns the
 * structured payload or `null` if the LLM repeatedly fails to produce
 * schema-valid JSON.
 */
export async function runSummaryLlm(
  cred: ResolvedCredential,
  systemPrompt: string,
  userPrompt: string,
  opts: { signal?: AbortSignal; retries?: number } = {},
): Promise<SummaryWithRatings | null> {
  const retries = opts.retries ?? 3;
  if (cred.kind === "claude-cli") {
    // Phase 2 scope reduction — see header comment. Fall through to no-op.
    return null;
  }

  let userPromptVar = userPrompt;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const raw = await callProvider(cred, systemPrompt, userPromptVar, opts.signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripJsonFence(raw));
      } catch (err) {
        lastErr = err;
        userPromptVar = `${userPromptVar}\n\nYour previous response did not parse as JSON. Return ONLY a single JSON object with the requested schema.`;
        continue;
      }
      const validated = validateSummaryWithRatings(parsed);
      if (validated) {
        return validated;
      }
      userPromptVar = `${userPromptVar}\n\nYour previous response did not match the schema. Return ONLY a single JSON object with keys "summary" (string) and "ratings" (array).`;
      lastErr = new Error("schema mismatch");
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(
    `[opencode-plugin] summary LLM failed after ${retries} retries (kind=${cred.kind}):`,
    lastErr,
  );
  return null;
}

function stripJsonFence(s: string): string {
  // Tolerant fallback for models that ignore the "no fences" instruction.
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  return trimmed;
}

function validateSummaryWithRatings(obj: unknown): SummaryWithRatings | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.summary !== "string") return null;
  const ratingsRaw = o.ratings ?? [];
  if (!Array.isArray(ratingsRaw)) return null;
  const ratings: LlmRating[] = [];
  for (const r of ratingsRaw) {
    if (!r || typeof r !== "object") continue;
    const rr = r as Record<string, unknown>;
    if (
      typeof rr.id !== "string" ||
      rr.id.length === 0 ||
      typeof rr.score !== "number" ||
      rr.score < 0 ||
      rr.score > 1 ||
      typeof rr.reasoning !== "string" ||
      rr.reasoning.length === 0 ||
      rr.reasoning.length > 500
    ) {
      continue;
    }
    const rating: LlmRating = {
      id: rr.id,
      score: rr.score,
      reasoning: rr.reasoning,
    };
    if (
      typeof rr.referencesSource === "string" &&
      rr.referencesSource.length >= 1 &&
      rr.referencesSource.length <= REFERENCES_SOURCE_MAX_LENGTH
    ) {
      rating.referencesSource = rr.referencesSource;
    }
    ratings.push(rating);
  }
  return { summary: o.summary, ratings };
}

/**
 * Dispatch to the right provider HTTP endpoint based on `cred.kind`.
 * Returns raw text content from the model (the prompt instructs JSON output).
 */
async function callProvider(
  cred: Exclude<ResolvedCredential, { kind: "claude-cli" }>,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (cred.kind === "anthropic") {
    return callAnthropic(cred, systemPrompt, userPrompt, signal);
  }
  return callOpenAICompat(cred, systemPrompt, userPrompt, signal);
}

/** Anthropic native messages API. */
async function callAnthropic(
  cred: { kind: "anthropic"; apiKey: string; modelDefault: string },
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  // Model string is "anthropic/<model-id>" — strip prefix.
  const modelId = cred.modelDefault.replace(/^anthropic\//, "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": cred.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = body.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("anthropic returned no text content");
  return text;
}

/** OpenAI-compatible chat completions — covers OpenRouter / OpenAI / OpenAI-Codex. */
async function callOpenAICompat(
  cred: {
    kind: "openrouter" | "openai" | "openai-codex";
    apiKey: string;
    modelDefault: string;
  },
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  let baseUrl: string;
  let modelId: string;
  if (cred.kind === "openrouter") {
    baseUrl = "https://openrouter.ai/api/v1";
    // OpenRouter model strings retain the inner provider segment, e.g.
    // "openrouter/google/gemini-3-flash-preview" → "google/gemini-3-flash-preview".
    modelId = cred.modelDefault.replace(/^openrouter\//, "");
  } else if (cred.kind === "openai") {
    baseUrl = "https://api.openai.com/v1";
    modelId = cred.modelDefault.replace(/^openai\//, "");
  } else {
    // openai-codex — same OpenAI surface, different auth header convention.
    baseUrl = "https://api.openai.com/v1";
    modelId = cred.modelDefault.replace(/^openai-codex\//, "");
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cred.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`${cred.kind} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${cred.kind} returned no content`);
  return text;
}

// ── Ratings → events (mirrors src/be/memory/raters/llm.ts:buildRatingsFromLlm) ─

/**
 * Mirrors `src/be/memory/raters/types.ts:sanitizeReferencesSource`. Uses
 * char-code iteration (not a regex) so biome's no-control-chars-in-regex
 * rule stays happy.
 */
function sanitizeReferencesSource(s: string): string | null {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) return null;
    // Strip non-NUL C0 control bytes (1..31) and DEL (127).
    if (code < 32 || code === 127) continue;
    out += s[i];
  }
  const trimmed = out.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

export function buildRatingsFromLlm(
  ratings: LlmRating[],
  retrievals: { id: string }[],
): RatingEvent[] {
  const allowed = new Set(retrievals.map((r) => r.id));
  const events: RatingEvent[] = [];
  for (const r of ratings) {
    if (!allowed.has(r.id)) continue;
    let cleanedReferencesSource: string | undefined;
    if (r.referencesSource !== undefined) {
      const cleaned = sanitizeReferencesSource(r.referencesSource);
      if (cleaned !== null) cleanedReferencesSource = cleaned;
    }
    const ev: RatingEvent = {
      memoryId: r.id,
      signal: 2 * r.score - 1,
      weight: LLM_RATER_WEIGHT,
      source: "llm",
      reasoning: r.reasoning,
    };
    if (cleanedReferencesSource !== undefined) {
      ev.referencesSource = cleanedReferencesSource;
    }
    events.push(ev);
  }
  return events;
}

// ── Swarm API helpers ─────────────────────────────────────────────────────────

function apiHeaders(config: SwarmConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    "X-Agent-ID": config.agentId,
  };
}

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
        `[opencode-plugin] GET /api/memory/retrievals failed: ${res.status} ${res.statusText}`,
      );
      return [];
    }
    const body = (await res.json()) as { results?: RetrievalRow[] };
    return body.results ?? [];
  } catch (err) {
    console.error("[opencode-plugin] fetchRetrievalsForTask threw:", err);
    return [];
  }
}

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
        `[opencode-plugin] POST /api/memory/rate failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
      );
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error("[opencode-plugin] postRatings threw:", err);
    return { ok: false, status: 0 };
  }
}

// ── Top-level entry ───────────────────────────────────────────────────────────

export interface SummarizeSessionForOpencodeDeps {
  resolveAuth?: typeof resolveOpencodeAuth;
  runSummaryLlm?: typeof runSummaryLlm;
  fetchRetrievalsForTask?: typeof fetchRetrievalsForTask;
  postRatings?: typeof postRatings;
  buildRatingsFromLlm?: typeof buildRatingsFromLlm;
  fetchTaskDetails?: (
    config: SwarmConfig,
  ) => Promise<{ id: string; task: string; progress?: string } | null>;
}

/**
 * Source the session transcript from opencode's SDK (`client.session.messages`),
 * flatten to text, then call the vendored summary LLM. Mirrors the same flow
 * as `summarizeSessionForPi` in `src/providers/pi-mono-extension.ts` but
 * - reads the transcript from the SDK rather than a session JSONL file, and
 * - uses vendored helpers (see file header for why).
 *
 * Returns void — fire-and-forget by design, all errors logged via
 * `console.error("session_summary failed (opencode):", err)`.
 */
export async function summarizeSessionForOpencode(
  config: SwarmConfig,
  client: PluginInput["client"],
  sessionID: string,
  deps: SummarizeSessionForOpencodeDeps = {},
): Promise<void> {
  const _resolveAuth = deps.resolveAuth ?? resolveOpencodeAuth;
  const _runSummary = deps.runSummaryLlm ?? runSummaryLlm;
  const _fetchRetrievals = deps.fetchRetrievalsForTask ?? fetchRetrievalsForTask;
  const _postRatings = deps.postRatings ?? postRatings;
  const _buildRatings = deps.buildRatingsFromLlm ?? buildRatingsFromLlm;
  const _fetchTaskDetails = deps.fetchTaskDetails ?? (async () => null);

  try {
    const resp = await client.session.messages({ path: { id: sessionID } });
    // The client returns { data, error } (responseStyle="fields" default).
    // Treat both shapes defensively because the response may have already
    // been unwrapped in tests that stub it.
    const items: Array<{ info: Message; parts: Part[] }> =
      (resp as { data?: Array<{ info: Message; parts: Part[] }> }).data ??
      (resp as unknown as Array<{ info: Message; parts: Part[] }>);

    if (!Array.isArray(items) || items.length === 0) return;

    const transcriptRaw = flattenOpencodeTranscript(items);
    const transcript = transcriptRaw.length > 20_000 ? transcriptRaw.slice(-20_000) : transcriptRaw;
    if (transcript.length <= 100) return;

    const sourceTaskId = config.taskId;
    const agentId = config.agentId;
    if (!sourceTaskId || !agentId) return;

    const taskDetails = await _fetchTaskDetails(config).catch(() => null);

    const memoryRaters = (process.env.MEMORY_RATERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const wantRatings = memoryRaters.includes("llm");
    const retrievals = wantRatings
      ? await _fetchRetrievals({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          agentId,
          taskId: sourceTaskId,
        }).catch(() => [] as RetrievalRow[])
      : [];

    const cred = await _resolveAuth();
    if (!cred) {
      // No usable credentials — graceful no-op (matches Phase 0
      // `completeStructured`'s null-on-no-auth behavior).
      return;
    }

    const taskLine = taskDetails?.task ? `\nTask: ${taskDetails.task}` : "";
    const basePrompt = `${BASE_SUMMARIZE_PROMPT}${taskLine}\n\nTranscript:\n${transcript}`;
    const userPrompt = buildSummaryWithRatingsPrompt(basePrompt, retrievals);
    const systemPrompt =
      "You are an expert at extracting durable, generalizable learnings from agent sessions.";

    const result = await _runSummary(cred, systemPrompt, userPrompt);
    if (!result) return;

    const summary = result.summary.trim();
    if (summary.length <= 20 || summary.toLowerCase().includes("no significant learnings")) {
      return;
    }

    const indexResp = await fetch(`${config.apiUrl}/api/memory/index`, {
      method: "POST",
      headers: apiHeaders(config),
      body: JSON.stringify({
        scope: "agent",
        source: "session_summary",
        sourceTaskId,
        content: summary,
        name: "session-summary",
        agentId,
      }),
    });
    if (!indexResp.ok) {
      const text = await indexResp.text().catch(() => "");
      console.error(
        "session_summary: /api/memory/index POST failed (opencode):",
        indexResp.status,
        text,
      );
      return;
    }

    if (wantRatings && result.ratings && result.ratings.length > 0) {
      const ratingEvents = _buildRatings(result.ratings, retrievals);
      if (ratingEvents.length > 0) {
        await _postRatings({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          agentId,
          taskId: sourceTaskId,
          events: ratingEvents,
        }).catch((err) => console.error("session_summary: postRatings failed (opencode):", err));
      }
    }
  } catch (err) {
    console.error("session_summary failed (opencode):", err);
  }
}
