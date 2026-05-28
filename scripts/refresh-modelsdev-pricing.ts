#!/usr/bin/env bun
/**
 * Refresh the vendored models.dev snapshot at `src/be/modelsdev-cache.json`.
 *
 * Usage: `bun run scripts/refresh-modelsdev-pricing.ts`
 *
 * Not a CI job — operators run this periodically. Prints a diff summary
 * (added / removed / changed rates) before writing so reviewers see what
 * moved. See `src/providers/pricing-sources.md` for the surrounding workflow.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CACHE_PATH = path.join(process.cwd(), "src", "be", "modelsdev-cache.json");
const MODELSDEV_URL = "https://models.dev/api.json";

interface CostBlock {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

interface ModelEntry {
  id?: string;
  cost?: CostBlock;
}

interface ProviderEntry {
  models?: Record<string, ModelEntry>;
}

type Cache = Record<string, ProviderEntry>;

function loadCurrent(): Cache | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Cache;
  } catch {
    return null;
  }
}

async function fetchLatest(): Promise<Cache> {
  const res = await fetch(MODELSDEV_URL);
  if (!res.ok) {
    throw new Error(`models.dev fetch failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Cache;
}

function summarize(prev: Cache | null, next: Cache): void {
  let added = 0;
  let removed = 0;
  let changed = 0;
  const prevProviders = new Set(prev ? Object.keys(prev) : []);
  const nextProviders = new Set(Object.keys(next));
  for (const p of nextProviders) {
    const prevModels = prev?.[p]?.models ?? {};
    const nextModels = next[p]?.models ?? {};
    for (const id of Object.keys(nextModels)) {
      if (!(id in prevModels)) {
        added += 1;
        console.log(`  + ${p}/${id}`);
        continue;
      }
      const a = prevModels[id]?.cost ?? {};
      const b = nextModels[id]?.cost ?? {};
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changed += 1;
        console.log(`  ~ ${p}/${id}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
    }
    for (const id of Object.keys(prevModels)) {
      if (!(id in nextModels)) {
        removed += 1;
        console.log(`  - ${p}/${id}`);
      }
    }
  }
  for (const p of prevProviders) {
    if (!nextProviders.has(p)) {
      console.log(`  - provider removed: ${p}`);
    }
  }
  console.log(`\nSummary: ${added} added, ${removed} removed, ${changed} changed.`);
}

async function main(): Promise<void> {
  console.log(`Fetching ${MODELSDEV_URL} ...`);
  const next = await fetchLatest();
  const prev = loadCurrent();
  summarize(prev, next);
  writeFileSync(CACHE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote ${CACHE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
