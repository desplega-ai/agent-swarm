import { normalizeModelKey } from "../be/pricing-normalize";
import type {
  PricingProvider,
  PricingTokenClass,
  SessionCostModelBreakdown,
  SessionCostSource,
} from "../types";
import { AMP_ESTIMATE_MODELS, ampBillsCacheWrites, resolveAmpModel } from "../utils/amp-models";

const PER_MILLION = 1_000_000;

// Providers whose reported input token counts INCLUDE cache reads
// (OpenAI-style), so uncached input = max(0, input − cacheRead). Only codex is
// verified inclusive (its own SDK contract, see codex-adapter.ts). Everyone
// else reports input DISJOINT from cache reads and is billed as-is:
// claude/claude-managed/pi per Anthropic semantics, opencode verified against
// prod events 2026-08-06 (53/53 finalized messages show input < cacheRead —
// subtraction would zero nearly all opencode input).
const INCLUSIVE_INPUT_PROVIDERS: ReadonlySet<PricingProvider> = new Set(["codex"]);

type PricingRateLookup = (
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  atEpochMs: number,
) => Promise<number | null>;

type SessionCostModelUsageInput = Omit<SessionCostModelBreakdown, "costUsd">;

interface SessionCostRecomputeInput {
  provider?: PricingProvider;
  model: string;
  harnessCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  models?: SessionCostModelUsageInput[];
  durationMs?: number;
  atEpochMs: number;
}

interface SessionCostRecomputeResult {
  totalCostUsd: number;
  costSource: SessionCostSource;
  modelBreakdown: SessionCostModelBreakdown[] | undefined;
}

interface CacheWriteSplit {
  fiveMinuteRatio: number;
  oneHourRatio: number;
}

function cacheWriteSplit(input: SessionCostRecomputeInput): CacheWriteSplit | null {
  if (input.cacheWrite5mTokens == null || input.cacheWrite1hTokens == null) return null;
  const total = input.cacheWrite5mTokens + input.cacheWrite1hTokens;
  // A 0/0 split says nothing about how writes were billed — fall back to the
  // legacy single-class path rather than pricing a non-zero aggregate at $0.
  if (total === 0) return null;
  return {
    fiveMinuteRatio: input.cacheWrite5mTokens / total,
    oneHourRatio: input.cacheWrite1hTokens / total,
  };
}

async function priceModel(
  provider: PricingProvider,
  usage: SessionCostModelUsageInput,
  split: CacheWriteSplit | null,
  atEpochMs: number,
  lookupRate: PricingRateLookup,
): Promise<number | null> {
  const lookupModel = normalizeModelKey(provider, usage.model);
  const inputRate = await lookupRate(provider, lookupModel, "input", atEpochMs);
  const outputRate = await lookupRate(provider, lookupModel, "output", atEpochMs);
  if (inputRate == null || outputRate == null) return null;

  const cacheReadRate = (await lookupRate(provider, lookupModel, "cached_input", atEpochMs)) ?? 0;
  const uncachedInputTokens = INCLUSIVE_INPUT_PROVIDERS.has(provider)
    ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
    : usage.inputTokens;

  let cacheWriteCostUnits = 0;
  if (split) {
    // The TTL split is session-level; every entry's aggregate writes are
    // distributed by the session ratio. Exact whenever 5m+1h equals the
    // aggregate (the claude CLI contract for the main thread); a documented
    // approximation for sidechain entries — and a residual between split and
    // aggregate is billed proportionally rather than dropped.
    const fiveMinuteTokens = usage.cacheWriteTokens * split.fiveMinuteRatio;
    const oneHourTokens = usage.cacheWriteTokens * split.oneHourRatio;
    const fiveMinuteRate = (await lookupRate(provider, lookupModel, "cache_write", atEpochMs)) ?? 0;
    const oneHourRate = await lookupRate(provider, lookupModel, "cache_write_1h", atEpochMs);
    // A missing 1h rate is not permission to silently make billed writes free.
    if (oneHourTokens > 0 && oneHourRate == null) return null;
    cacheWriteCostUnits = fiveMinuteTokens * fiveMinuteRate + oneHourTokens * (oneHourRate ?? 0);
  } else {
    // Legacy payloads carry only the aggregate and retain the historical 5m class.
    const cacheWriteRate = (await lookupRate(provider, lookupModel, "cache_write", atEpochMs)) ?? 0;
    cacheWriteCostUnits = usage.cacheWriteTokens * cacheWriteRate;
  }

  return (
    (uncachedInputTokens * inputRate +
      usage.cacheReadTokens * cacheReadRate +
      cacheWriteCostUnits +
      usage.outputTokens * outputRate) /
    PER_MILLION
  );
}

function unpricedResult(
  input: SessionCostRecomputeInput,
  modelBreakdown: SessionCostModelBreakdown[] | undefined,
): SessionCostRecomputeResult {
  return {
    totalCostUsd: input.harnessCostUsd,
    costSource: "unpriced",
    modelBreakdown,
  };
}

/**
 * An amp row with no per-model usage means the thread export failed, and the
 * adapter sent the stream's token totals under the requested mode or pin.
 * Recording $0 would let the session skip budget admission, so the totals are
 * priced at the pin, or at the model the mode is known to run, falling back to
 * the `medium` model when the pin has no rates. The row is tagged `estimated`.
 */
async function estimateAmpCost(
  input: SessionCostRecomputeInput,
  lookupRate: PricingRateLookup,
): Promise<SessionCostRecomputeResult> {
  let selection: ReturnType<typeof resolveAmpModel> | undefined;
  try {
    selection = resolveAmpModel(input.model);
  } catch {
    selection = undefined;
  }
  const candidates = [
    ...new Set([
      selection?.pin,
      selection ? AMP_ESTIMATE_MODELS[selection.baseMode] : undefined,
      AMP_ESTIMATE_MODELS.medium,
    ]),
  ].filter((model): model is string => !!model);
  for (const model of candidates) {
    // Same rule as the export parser: only Anthropic bills cache creation as writes.
    const writes = ampBillsCacheWrites(model);
    const costUsd = await priceModel(
      "amp",
      {
        model,
        inputTokens: input.inputTokens + (writes ? 0 : input.cacheWriteTokens),
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: writes ? input.cacheWriteTokens : 0,
      },
      null,
      input.atEpochMs,
      lookupRate,
    );
    if (costUsd != null)
      return { totalCostUsd: costUsd, costSource: "estimated", modelBreakdown: undefined };
  }
  return unpricedResult(input, undefined);
}

export async function recomputeSessionCost(
  input: SessionCostRecomputeInput,
  lookupRate: PricingRateLookup,
): Promise<SessionCostRecomputeResult> {
  const modelUsageEntries = input.models?.length ? input.models : undefined;
  const modelBreakdown = modelUsageEntries?.map((model) => ({ ...model }));
  if (!input.provider) {
    return {
      totalCostUsd: input.harnessCostUsd,
      costSource: "harness",
      modelBreakdown,
    };
  }

  // Amp's own recorded cost (`amp threads usage`) is what it billed, including
  // subagent threads the token counts miss. The adapter sends it only when
  // every request was billed through Amp, so it wins over the token price,
  // which still fills the per-model breakdown.
  if (input.provider === "amp" && input.harnessCostUsd > 0) {
    const priced = await recomputeSessionCost({ ...input, harnessCostUsd: 0 }, lookupRate);
    return {
      totalCostUsd: input.harnessCostUsd,
      costSource: "harness",
      modelBreakdown: priced.modelBreakdown,
    };
  }

  // An ACP target can fall back from the requested model, so the swarm keeps no
  // (acp, model) rates. The cost the target reports does not depend on the
  // model id, so the adapter sends it only when the target reported USD.
  if (input.provider === "acp" && input.harnessCostUsd > 0) {
    return { totalCostUsd: input.harnessCostUsd, costSource: "harness", modelBreakdown };
  }

  // amp's top-level model is the mode or pin it was asked for; only the thread
  // export's per-model usage says what ran and how its cache tokens bill.
  if (input.provider === "amp" && !modelUsageEntries) return estimateAmpCost(input, lookupRate);

  const split = cacheWriteSplit(input);
  const usages: SessionCostModelUsageInput[] = modelUsageEntries
    ? modelUsageEntries
    : input.model
      ? [
          {
            model: input.model,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cacheReadTokens: input.cacheReadTokens,
            cacheWriteTokens: input.cacheWriteTokens,
          },
        ]
      : [];

  // Preserve the legacy no-model harness path; a tagged but unknown model is
  // handled below as unpriced once there is a pricing target to attempt.
  if (usages.length === 0) {
    return {
      totalCostUsd: input.harnessCostUsd,
      costSource: "harness",
      modelBreakdown,
    };
  }

  const pricedModels: SessionCostModelBreakdown[] = [];
  let pricedCostUsd = 0;
  const hasWebSearchRequests = usages.some((usage) => (usage.webSearchRequests ?? 0) > 0);
  // Deliberate asymmetry with the fail-loud token-rate paths: a missing
  // web-search rate prices requests at $0 instead of unpricing the row.
  // Search fees are cents on multi-dollar sessions, so discarding an
  // otherwise-exact token recompute over them would cost more accuracy than
  // it protects; the drift metric still exposes the residual.
  const webSearchRate = hasWebSearchRequests
    ? await lookupRate(input.provider, "*", "web_search", input.atEpochMs)
    : null;
  for (const usage of usages) {
    const tokenCostUsd = await priceModel(
      input.provider,
      usage,
      split,
      input.atEpochMs,
      lookupRate,
    );
    if (tokenCostUsd == null) return unpricedResult(input, modelBreakdown);
    const webSearchCostUsd = ((usage.webSearchRequests ?? 0) * (webSearchRate ?? 0)) / PER_MILLION;
    const costUsd = tokenCostUsd + webSearchCostUsd;
    pricedCostUsd += costUsd;
    if (modelUsageEntries) pricedModels.push({ ...usage, costUsd });
  }

  let sessionFeesUsd = 0;
  const durationMs = input.durationMs ?? 0;
  if (input.provider === "claude-managed" && durationMs > 0) {
    const runtimeRate = await lookupRate(input.provider, "*", "runtime_hour", input.atEpochMs);
    if (runtimeRate == null) return unpricedResult(input, modelBreakdown);
    sessionFeesUsd += (durationMs / 3_600_000) * (runtimeRate / PER_MILLION);
  }

  return {
    totalCostUsd: pricedCostUsd + sessionFeesUsd,
    costSource: "pricing-table",
    modelBreakdown: modelUsageEntries ? pricedModels : undefined,
  };
}
