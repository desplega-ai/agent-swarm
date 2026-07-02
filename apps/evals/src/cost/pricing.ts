import type { HarnessProvider, TokenTotals } from "../types.ts";
import { buildClaudeAliasMap, resolveClaudeAlias } from "./model-alias.ts";

export interface PricedModel {
  id: string; // models.dev model id, e.g. "deepseek/deepseek-v4-pro" (openrouter section)
  name: string;
  reasoning: boolean;
  toolCall: boolean;
  context: number | null;
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
}

interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  release_date?: string;
  limit?: { context?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface ModelsDevSection {
  id: string;
  name: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDevCache = Record<string, ModelsDevSection>;

let cachePromise: Promise<ModelsDevCache> | null = null;

/** Repo-root models.dev snapshot — in-repo and offline-safe. Loaded once per process. */
function loadCache(): Promise<ModelsDevCache> {
  if (!cachePromise) {
    const url = new URL("../../../../apps/swarm/src/be/modelsdev-cache.json", import.meta.url);
    cachePromise = Bun.file(url).json() as Promise<ModelsDevCache>;
  }
  return cachePromise;
}

function toPriced(id: string, m: ModelsDevModel): PricedModel {
  return {
    id,
    name: m.name ?? id,
    reasoning: m.reasoning ?? false,
    toolCall: m.tool_call ?? false,
    context: m.limit?.context ?? null,
    inputPerM: m.cost?.input ?? null,
    outputPerM: m.cost?.output ?? null,
    cacheReadPerM: m.cost?.cache_read ?? null,
    cacheWritePerM: m.cost?.cache_write ?? null,
  };
}

/** All models of the models.dev `openrouter` section, sorted by name. Cached after first load. */
export async function listOpenrouterModels(): Promise<PricedModel[]> {
  const cache = await loadCache();
  const section = cache.openrouter;
  if (!section) return [];
  return Object.entries(section.models)
    .map(([id, m]) => toPriced(id, m))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const PROVIDER_SECTION: Record<HarnessProvider, string> = {
  claude: "anthropic",
  codex: "openai",
  pi: "openrouter",
  opencode: "openrouter",
};

let claudeAliasPromise: Promise<Record<string, string>> | null = null;

/**
 * Frozen bare-alias map (v7 §8): "fable" → "claude-fable-5", "opus" → the
 * latest opus, … — computed once per process from the snapshot's `anthropic`
 * section via the pure rule in model-alias.ts. Shared by claude pricing
 * lookups here and shipped to the UI on GET /api/models (`aliases`).
 */
export function getClaudeAliasMap(): Promise<Record<string, string>> {
  claudeAliasPromise ??= loadCache().then((cache) => {
    const section = cache.anthropic;
    if (!section) return {};
    return buildClaudeAliasMap(
      Object.entries(section.models).map(([id, m]) => ({
        id,
        releaseDate: m.release_date ?? null,
      })),
    );
  });
  return claudeAliasPromise;
}

/**
 * Resolve a concrete model id observed in harness output (or a config MODEL_OVERRIDE)
 * to a priced model. Provider → models.dev section mapping:
 *   claude  → "anthropic" section. Bare aliases ("haiku"/"opus"/"fable") resolve
 *             FIRST to the latest family member via the frozen alias map (v7 §8);
 *             dated ids strip their suffix /-\d{8}$/
 *             (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
 *   codex   → "openai" section, bare id
 *   pi / opencode → strip leading "openrouter/" then look up in the "openrouter" section
 *             (e.g. "openrouter/deepseek/deepseek-v4-flash" → "deepseek/deepseek-v4-flash");
 *             ids without the prefix (as emitted in harness session files) look up directly.
 * Returns null when not found.
 */
export async function lookupModelCost(
  provider: HarnessProvider,
  modelId: string,
): Promise<PricedModel | null> {
  const cache = await loadCache();
  const section = cache[PROVIDER_SECTION[provider]];
  if (!section) return null;
  const candidates: string[] = [];
  if (provider === "pi" || provider === "opencode") {
    candidates.push(
      modelId.startsWith("openrouter/") ? modelId.slice("openrouter/".length) : modelId,
    );
  } else if (provider === "claude") {
    // Bare alias ("fable") → latest family member ("claude-fable-5") — v7 §8.
    const aliased = resolveClaudeAlias(modelId, await getClaudeAliasMap());
    if (aliased) candidates.push(aliased);
    // Prefer the canonical undated entry; the snapshot carries dated aliases too.
    const stripped = modelId.replace(/-\d{8}$/, "");
    if (stripped !== modelId) candidates.push(stripped);
    candidates.push(modelId);
  } else {
    candidates.push(modelId);
  }
  for (const id of candidates) {
    const m = section.models[id];
    if (m) return toPriced(id, m);
  }
  return null;
}

/**
 * Price lookup for judge models (OpenRouter ids, e.g. "deepseek/deepseek-v4-pro").
 * Delegates to the pi mapping: "openrouter" section + optional "openrouter/" prefix strip.
 */
export async function lookupOpenrouterModel(modelId: string): Promise<PricedModel | null> {
  return lookupModelCost("pi", modelId);
}

/**
 * USD for a usage block. `inputIncludesCacheRead` handles the codex semantic
 * (OpenAI input_tokens INCLUDE cached tokens → uncachedInput = input - cacheRead);
 * Anthropic/pi/opencode input EXCLUDES cache tokens → use input directly.
 * Returns null when inputPerM or outputPerM is null.
 */
export function priceUsage(
  model: PricedModel,
  usage: TokenTotals,
  opts: { inputIncludesCacheRead: boolean },
): number | null {
  if (model.inputPerM === null || model.outputPerM === null) return null;
  const uncachedInput = opts.inputIncludesCacheRead
    ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
    : usage.inputTokens;
  return (
    (uncachedInput * model.inputPerM +
      usage.cacheReadTokens * (model.cacheReadPerM ?? model.inputPerM) +
      usage.cacheWriteTokens * (model.cacheWritePerM ?? 0) +
      usage.outputTokens * model.outputPerM) /
    1e6
  );
}
