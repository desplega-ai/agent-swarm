/**
 * Phase 2 of the cost-tracking plan — seed the `pricing` table at server boot.
 *
 * The vendored models.dev snapshot at `src/be/modelsdev-cache.json` is the
 * single source of truth for per-token rates. We project it into rows keyed by
 * `(provider, model, token_class)` so the recompute path in
 * `src/http/session-data.ts` can rebuild USD from tokens regardless of which
 * adapter wrote the row.
 *
 * Manual overrides (Anthropic runtime fee, Cognition ACU) live in
 * {@link MANUAL_PRICING_OVERRIDES} — models.dev doesn't surface those.
 *
 * The seeder uses `INSERT OR IGNORE` keyed on the pricing PK
 * `(provider, model, token_class, effective_from)` with `effective_from = 0`,
 * so re-runs on every boot are no-ops once seeded. Operators who need to bump
 * a rate insert a new row with a later `effective_from` via the existing
 * admin route (`POST /api/pricing`) — we don't overwrite seed rows.
 */

import type { PricingProvider, PricingTokenClass } from "../types";
import { getDb } from "./db";
import {
  loadModelsDevCache,
  type ModelsDevCache,
  type ModelsDevCostBlock,
} from "./modelsdev-cache";
import { normalizeModelKey } from "./pricing-normalize";

/**
 * Per-harness manual rates that models.dev doesn't carry. Keep the source URL
 * and a verification date next to each entry so {@link MANUAL_PRICING_OVERRIDES}
 * doubles as living documentation.
 */
const MANUAL_PRICING_OVERRIDES: Array<{
  provider: PricingProvider;
  model: string;
  tokenClass: PricingTokenClass;
  pricePerMillionUsd: number;
  source: string;
  verified: string; // YYYY-MM-DD
}> = [
  {
    provider: "claude-managed",
    // '*' = applies regardless of which Claude model the managed run picks.
    // The runtime fee is per session-hour, not per model.
    model: "*",
    tokenClass: "runtime_hour",
    // $0.08 / hour expressed as USD per "million units" so it fits the same
    // rate table. The adapter will multiply by hours, not by tokens — the
    // unit is a convention specific to `runtime_hour`.
    pricePerMillionUsd: 0.08 * 1_000_000,
    source: "https://docs.claude.com/en/api/agent-sdk/managed-runtime#pricing",
    verified: "2026-04-28",
  },
  {
    provider: "devin",
    model: "*",
    tokenClass: "acu",
    pricePerMillionUsd: 2.25 * 1_000_000,
    source: "https://devin.ai/pricing",
    verified: "2026-04-28",
  },
];

/**
 * Adapter-specific shortname → models.dev key. Some adapters report `model`
 * fields the models.dev snapshot doesn't index directly; we map them here.
 */
const ANTHROPIC_SHORTNAME_TO_MODELSDEV: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

interface PricingSeedRow {
  provider: PricingProvider;
  model: string;
  tokenClass: PricingTokenClass;
  pricePerMillionUsd: number;
}

/**
 * Project a models.dev `cost` block into our pricing-table token classes.
 * Returns one row per non-null cost field.
 */
function projectCostBlock(
  provider: PricingProvider,
  model: string,
  cost: ModelsDevCostBlock,
): PricingSeedRow[] {
  // Phase 2 fix — canonicalize the seed key with the same normalizer the
  // lookup path uses. Idempotent for keys models.dev already serves in
  // canonical form (the common case); also collapses any future drift.
  const key = normalizeModelKey(provider, model);
  const rows: PricingSeedRow[] = [];
  if (typeof cost.input === "number") {
    rows.push({ provider, model: key, tokenClass: "input", pricePerMillionUsd: cost.input });
  }
  if (typeof cost.output === "number") {
    rows.push({ provider, model: key, tokenClass: "output", pricePerMillionUsd: cost.output });
  }
  if (typeof cost.cache_read === "number") {
    rows.push({
      provider,
      model: key,
      tokenClass: "cached_input",
      pricePerMillionUsd: cost.cache_read,
    });
  }
  if (typeof cost.cache_write === "number") {
    rows.push({
      provider,
      model: key,
      tokenClass: "cache_write",
      pricePerMillionUsd: cost.cache_write,
    });
  }
  return rows;
}

/**
 * Build the full set of seed rows from a loaded models.dev cache.
 *
 * The mapping logic is intentionally per-provider so the matrix between
 * "what the adapter writes for `model`" and "what models.dev keys by" is
 * explicit and auditable.
 */
function buildModelsDevSeedRows(cache: ModelsDevCache): PricingSeedRow[] {
  const rows: PricingSeedRow[] = [];

  // ---- Anthropic / claude family ----------------------------------------
  // The 'claude' provider (local-CLI adapter) reports the model id as the
  // Anthropic CLI returns it. The 'claude-managed' provider may report
  // either a dated full id or a non-dated id. We project both keyed forms
  // for each model so the recompute path resolves either way.
  const anthropic = cache.anthropic?.models ?? {};
  for (const [id, model] of Object.entries(anthropic)) {
    if (!model?.cost) continue;
    for (const provider of ["claude", "claude-managed"] as const) {
      for (const row of projectCostBlock(provider, id, model.cost)) {
        rows.push(row);
      }
    }
  }
  // Anthropic shortnames (opus/sonnet/haiku) → resolve to the current default.
  for (const [shortname, fullId] of Object.entries(ANTHROPIC_SHORTNAME_TO_MODELSDEV)) {
    const target = anthropic[fullId];
    if (!target?.cost) continue;
    for (const provider of ["claude", "claude-managed"] as const) {
      for (const row of projectCostBlock(provider, shortname, target.cost)) {
        rows.push(row);
      }
    }
  }
  // Pi-mono uses anthropic models via OpenRouter mirrors; project those too.
  for (const [shortname, fullId] of Object.entries(ANTHROPIC_SHORTNAME_TO_MODELSDEV)) {
    const target = anthropic[fullId];
    if (!target?.cost) continue;
    for (const row of projectCostBlock("pi", shortname, target.cost)) {
      rows.push(row);
    }
  }

  // ---- OpenAI / codex family --------------------------------------------
  const openai = cache.openai?.models ?? {};
  for (const [id, model] of Object.entries(openai)) {
    if (!model?.cost) continue;
    for (const row of projectCostBlock("codex", id, model.cost)) {
      rows.push(row);
    }
    // Phase 2 fix — pi-mono can route to openai models through the
    // github-copilot proxy (`github-copilot/gpt-5.4`). The lookup helper
    // strips the prefix, so we seed the bare id under `pi` too. Without this
    // every gh-copilot-backed pi run fell through to `costSource='unpriced'`.
    for (const row of projectCostBlock("pi", id, model.cost)) {
      rows.push(row);
    }
  }

  // ---- OpenRouter passthrough (covers gemini + every opencode-routed model)
  const openrouter = cache.openrouter?.models ?? {};
  for (const [id, model] of Object.entries(openrouter)) {
    if (!model?.cost) continue;
    // opencode routes whatever model the user picks; we project them all.
    for (const row of projectCostBlock("opencode", id, model.cost)) {
      rows.push(row);
    }
    // pi-mono also routes via OpenRouter when only OPENROUTER_API_KEY is set
    // (see src/providers/pi-mono-adapter.ts). Without this projection, pi runs
    // against non-anthropic models (e.g. deepseek/deepseek-v4-flash) fall
    // through to costSource='unpriced' even though the model is in the
    // models.dev snapshot.
    for (const row of projectCostBlock("pi", id, model.cost)) {
      rows.push(row);
    }
    // Gemini specifically: also project under the 'gemini' provider so
    // internal-ai callers that tag with provider='gemini' find a hit.
    if (id.startsWith("google/")) {
      const geminiKey = id.replace(/^google\//, "");
      for (const row of projectCostBlock("gemini", geminiKey, model.cost)) {
        rows.push(row);
      }
      // Also store under the full openrouter id so the same row resolves
      // whether the caller passes "google/..." or the stripped name.
      for (const row of projectCostBlock("gemini", id, model.cost)) {
        rows.push(row);
      }
    }
  }

  return rows;
}

/**
 * Phase 2 entrypoint. Idempotent — safe to call on every boot. Logs a one-line
 * summary so operators can tell whether the boot picked up new rates.
 */
export function seedPricingFromModelsDev(opts?: { quiet?: boolean }): {
  inserted: number;
  modelsdevFound: boolean;
} {
  const db = getDb();
  const cache = loadModelsDevCache();
  const modelsdevRows = cache ? buildModelsDevSeedRows(cache) : [];
  const manualRows = MANUAL_PRICING_OVERRIDES.map((o) => ({
    provider: o.provider,
    model: o.model,
    tokenClass: o.tokenClass,
    pricePerMillionUsd: o.pricePerMillionUsd,
  }));
  const allRows = [...modelsdevRows, ...manualRows];

  const insert = db.prepare<null, [string, string, string, number]>(
    `INSERT OR IGNORE INTO pricing
       (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
     VALUES (?, ?, ?, 0, ?, 0, 0)`,
  );

  let inserted = 0;
  const tx = db.transaction((rows: PricingSeedRow[]) => {
    for (const row of rows) {
      const result = insert.run(row.provider, row.model, row.tokenClass, row.pricePerMillionUsd);
      if (result.changes > 0) inserted += 1;
    }
  });
  tx(allRows);

  if (!opts?.quiet) {
    console.log(
      `[pricing] seed: ${inserted} new row(s); ${allRows.length} candidate(s); modelsdev=${
        cache ? "loaded" : "missing"
      }`,
    );
  }
  return { inserted, modelsdevFound: !!cache };
}
