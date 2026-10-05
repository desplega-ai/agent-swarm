import { loadModelsDevCache } from "../be/modelsdev-cache";
import { buildPricingSeedRows } from "../be/seed-pricing";
import type { PricingTokenClass } from "../types";

/** The `amp` rows the boot seeder inserts, as a lookup the recompute path can use. */
export function ampPricingLookup() {
  const cache = loadModelsDevCache();
  if (!cache) throw new Error("the vendored models.dev snapshot is missing");
  const rows = new Map(
    buildPricingSeedRows(cache)
      .filter((row) => row.provider === "amp")
      .map((row) => [`${row.model}|${row.tokenClass}`, row.pricePerMillionUsd]),
  );
  return async (_provider: string, model: string, tokenClass: PricingTokenClass) =>
    rows.get(`${model}|${tokenClass}`) ?? null;
}
