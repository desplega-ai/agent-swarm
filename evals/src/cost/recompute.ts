/**
 * Cost recompute fallback: when the harness reported no priced session-cost
 * rows (e.g. Claude OAuth sessions), extract per-message token usage from the
 * captured raw session logs / harness session files and price it against the
 * models.dev snapshot. Must never throw — unparseable input yields nulls.
 */
import type { HarnessProvider, RecomputeInput, RecomputeResult, TokenTotals } from "../types.ts";
import { lookupModelCost, type PricedModel, priceUsage } from "./pricing.ts";

/** One model API call's worth of usage, as extracted from a harness artifact. */
interface UsageEvent {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported USD (pi/opencode session files) — preferred over tokens × rates. */
  costUsd: number | null;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parse JSONL (or a single whole-JSON document) into objects, skipping bad lines. */
function parseJsonObjects(content: string): Rec[] {
  const out: Rec[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = asRecord(JSON.parse(trimmed));
      if (rec) out.push(rec);
    } catch {
      // not a complete JSON line — ignored; whole-document parse below
    }
  }
  if (out.length === 0 && lines.length > 1) {
    try {
      const rec = asRecord(JSON.parse(content));
      if (rec) out.push(rec);
    } catch {
      // unparseable file — nothing extractable
    }
  }
  return out;
}

/** Anthropic stream-json usage block ({input_tokens, output_tokens, cache_*}). */
function claudeUsageEvent(message: Rec): UsageEvent | null {
  const usage = asRecord(message.usage);
  if (!usage) return null;
  return {
    model: typeof message.model === "string" ? message.model : null,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    costUsd: null,
  };
}

/**
 * claude: swarm log rows carry full stream-json assistant events. Usage repeats
 * per content block of the same API response — dedupe by `message.id`.
 */
function extractClaudeFromLogRows(logRows: RecomputeInput["logRows"]): UsageEvent[] {
  const byMessageId = new Map<string, UsageEvent>();
  for (const row of logRows) {
    try {
      const parsed = asRecord(JSON.parse(row.content));
      if (!parsed || parsed.type !== "assistant") continue;
      const message = asRecord(parsed.message);
      if (!message || typeof message.id !== "string") continue;
      const event = claudeUsageEvent(message);
      if (event) byMessageId.set(message.id, event);
    } catch {
      // non-JSON row — skip
    }
  }
  return [...byMessageId.values()];
}

/** claude fallback: ~/.claude/projects/**\/*.jsonl lines — dedupe by requestId, keep last. */
function extractClaudeFromSessionFiles(files: RecomputeInput["sessionFiles"]): UsageEvent[] {
  const byRequestId = new Map<string, UsageEvent>();
  for (const file of files) {
    for (const rec of parseJsonObjects(file.content)) {
      if (rec.type !== "assistant" || typeof rec.requestId !== "string") continue;
      const message = asRecord(rec.message);
      if (!message) continue;
      const event = claudeUsageEvent(message);
      if (event) byRequestId.set(rec.requestId, event);
    }
  }
  return [...byRequestId.values()];
}

/**
 * pi: ~/.pi/agent/sessions/**\/*.jsonl — assistant messages carry
 * `message.usage` = {input, output, cacheRead, cacheWrite, cost: {total}}.
 */
function extractPi(files: RecomputeInput["sessionFiles"]): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const file of files) {
    for (const rec of parseJsonObjects(file.content)) {
      if (rec.type !== "message") continue;
      const message = asRecord(rec.message);
      if (!message || message.role !== "assistant") continue;
      const usage = asRecord(message.usage);
      if (!usage) continue;
      const cost = asRecord(usage.cost);
      events.push({
        model: typeof message.model === "string" ? message.model : null,
        inputTokens: num(usage.input),
        outputTokens: num(usage.output),
        cacheReadTokens: num(usage.cacheRead),
        cacheWriteTokens: num(usage.cacheWrite),
        costUsd: typeof cost?.total === "number" ? cost.total : null,
      });
    }
  }
  return events;
}

/**
 * opencode: ~/.local/share/opencode storage — finalized message objects carry
 * `tokens: {input, output, cache: {read, write}}`, `cost`, `modelID`.
 */
function extractOpencode(files: RecomputeInput["sessionFiles"]): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const file of files) {
    for (const rec of parseJsonObjects(file.content)) {
      if (rec.role !== undefined && rec.role !== "assistant") continue;
      const tokens = asRecord(rec.tokens);
      if (!tokens || typeof tokens.input !== "number") continue;
      const cache = asRecord(tokens.cache);
      events.push({
        model: typeof rec.modelID === "string" ? rec.modelID : null,
        inputTokens: num(tokens.input),
        outputTokens: num(tokens.output),
        cacheReadTokens: num(cache?.read),
        cacheWriteTokens: num(cache?.write),
        costUsd: typeof rec.cost === "number" ? rec.cost : null,
      });
    }
  }
  return events;
}

/** Depth-first search for codex `token_count` usage shapes inside a rollout line. */
function findCodexUsage(value: unknown, depth = 0): Rec | null {
  if (depth > 6) return null;
  const rec = asRecord(value);
  if (!rec) return null;
  if (
    typeof rec.input_tokens === "number" &&
    typeof rec.output_tokens === "number" &&
    "cached_input_tokens" in rec
  ) {
    return rec;
  }
  // Prefer the cumulative block when the info object carries both.
  if (asRecord(rec.total_token_usage)) {
    const total = findCodexUsage(rec.total_token_usage, depth + 1);
    if (total) return total;
  }
  for (const v of Object.values(rec)) {
    const found = findCodexUsage(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Last string `model` field seen in a rollout record (session/turn context lines). */
function findModelString(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.model === "string" && rec.model) return rec.model;
  for (const v of Object.values(rec)) {
    const found = findModelString(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * codex backstop: rollout files in ~/.codex/sessions carry cumulative
 * `token_count` events — use the LAST one per rollout file.
 */
function extractCodex(files: RecomputeInput["sessionFiles"]): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const file of files) {
    let lastUsage: Rec | null = null;
    let lastModel: string | null = null;
    for (const rec of parseJsonObjects(file.content)) {
      const model = findModelString(rec);
      if (model) lastModel = model;
      const usage = findCodexUsage(rec);
      if (usage) lastUsage = usage;
    }
    if (!lastUsage) continue;
    events.push({
      model: lastModel,
      inputTokens: num(lastUsage.input_tokens),
      outputTokens: num(lastUsage.output_tokens),
      cacheReadTokens: num(lastUsage.cached_input_tokens),
      cacheWriteTokens: 0,
      costUsd: null,
    });
  }
  return events;
}

function extractEvents(input: RecomputeInput): UsageEvent[] {
  switch (input.provider) {
    case "claude": {
      const fromLogs = extractClaudeFromLogRows(input.logRows);
      return fromLogs.length > 0 ? fromLogs : extractClaudeFromSessionFiles(input.sessionFiles);
    }
    case "pi":
      return extractPi(input.sessionFiles);
    case "opencode":
      return extractOpencode(input.sessionFiles);
    case "codex":
      return extractCodex(input.sessionFiles);
  }
}

/** Most frequent non-null model id across events. */
function dominantModel(events: UsageEvent[]): string | null {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.model) counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

function aggregateTokens(events: UsageEvent[]): TokenTotals {
  return {
    model: dominantModel(events),
    inputTokens: events.reduce((s, e) => s + e.inputTokens, 0),
    outputTokens: events.reduce((s, e) => s + e.outputTokens, 0),
    cacheReadTokens: events.reduce((s, e) => s + e.cacheReadTokens, 0),
    cacheWriteTokens: events.reduce((s, e) => s + e.cacheWriteTokens, 0),
  };
}

async function resolvePricedModel(
  provider: HarnessProvider,
  eventModel: string | null,
  configModel: string | null,
  cache: Map<string, PricedModel | null>,
): Promise<PricedModel | null> {
  // Prefer the concrete per-event id; fall back to the config's MODEL_OVERRIDE
  // (which may be a shortname like "haiku" → lookup returns null → unpriced).
  for (const id of [eventModel, configModel]) {
    if (!id) continue;
    if (!cache.has(id)) cache.set(id, await lookupModelCost(provider, id));
    const model = cache.get(id) ?? null;
    if (model) return model;
  }
  return null;
}

/** Price one provider's events: provider-reported USD wins, else tokens × rates. */
async function priceEvents(
  provider: HarnessProvider,
  configModel: string | null,
  events: UsageEvent[],
): Promise<{ totalUsd: number; pricedAny: boolean }> {
  const lookupCache = new Map<string, PricedModel | null>();
  let totalUsd = 0;
  let pricedAny = false;
  for (const event of events) {
    if (event.costUsd !== null) {
      totalUsd += event.costUsd;
      pricedAny = true;
      continue;
    }
    const model = await resolvePricedModel(provider, event.model, configModel, lookupCache);
    if (!model) continue;
    const usd = priceUsage(
      model,
      {
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
      },
      // OpenAI input_tokens INCLUDE cached tokens; Anthropic/pi/opencode exclude them.
      { inputIncludesCacheRead: provider === "codex" },
    );
    if (usd !== null) {
      totalUsd += usd;
      pricedAny = true;
    }
  }
  return { totalUsd, pricedAny };
}

export async function recomputeCost(input: RecomputeInput): Promise<RecomputeResult> {
  try {
    const events = extractEvents(input);
    if (events.length === 0) return { costUsd: null, tokens: null };

    const tokens = aggregateTokens(events);
    const { totalUsd, pricedAny } = await priceEvents(input.provider, input.configModel, events);
    return { costUsd: pricedAny ? totalUsd : null, tokens };
  } catch {
    // Extraction must never fail an attempt.
    return { costUsd: null, tokens: null };
  }
}

/**
 * Heterogeneous-roster recompute (v7 §12.5 — FROZEN): the extractor runs PER
 * MEMBER — each input carries that member's provider, configModel, session
 * files, and the log rows of that member's tasks. The attempt result is the
 * Σ of member costs (null when none priced) and the field-wise Σ of member
 * tokens; `tokens.model` = the dominant model across ALL members' events.
 * Homogeneous rosters keep using {@link recomputeCost} (bit-for-bit).
 */
export async function recomputeCostMulti(inputs: RecomputeInput[]): Promise<RecomputeResult> {
  try {
    const allEvents: UsageEvent[] = [];
    let totalUsd = 0;
    let pricedAny = false;
    for (const input of inputs) {
      const events = extractEvents(input);
      if (events.length === 0) continue;
      allEvents.push(...events);
      const priced = await priceEvents(input.provider, input.configModel, events);
      totalUsd += priced.totalUsd;
      pricedAny = pricedAny || priced.pricedAny;
    }
    if (allEvents.length === 0) return { costUsd: null, tokens: null };
    return { costUsd: pricedAny ? totalUsd : null, tokens: aggregateTokens(allEvents) };
  } catch {
    // Extraction must never fail an attempt.
    return { costUsd: null, tokens: null };
  }
}
