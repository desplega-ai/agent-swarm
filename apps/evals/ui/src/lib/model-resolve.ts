import type { ModelJson } from "../types.ts";

/**
 * Pure model-id resolution behind `useModels().resolve` (hooks.ts). Kept free of
 * React and DOM so the server-side tests can exercise it.
 */

/** Candidate catalog ids for an observed model id (config override, harness output, …). */
export function modelIdCandidates(id: string): string[] {
  const out = [id];
  const unprefixed = id.startsWith("openrouter/") ? id.slice("openrouter/".length) : id;
  if (unprefixed !== id) out.push(unprefixed);
  const dateless = unprefixed.replace(/-\d{8}$/, ""); // claude-haiku-4-5-20251001 → claude-haiku-4-5
  if (dateless !== unprefixed) out.push(dateless);
  const dotted = dateless.replace(/-(\d+)-(\d+)$/, "-$1.$2"); // claude-haiku-4-5 → claude-haiku-4.5
  if (dotted !== dateless) out.push(dotted);
  return out;
}

export interface ModelSources {
  /** Openrouter entries (the judge picker list). */
  models: ModelJson[];
  /** Claude (anthropic) + codex (openai) entries; display-only. */
  harnessModels?: ModelJson[];
  /** Frozen claude bare-alias map ("fable" → "claude-fable-5-1"). */
  aliases?: Record<string, string>;
}

/**
 * Resolve any observed model-id shape to a catalog entry (null when unknown).
 *
 * Order: bare claude aliases ("fable") map to the latest family member first
 * (v7 §8); then exact ids across the harness entries (`claude-sonnet-5-5`,
 * `gpt-5.6-sol`), then across the openrouter entries, each trying the
 * candidate chain (prefix / date / dotted); last resort is a suffix match
 * ("deepseek-v4-flash" → "deepseek/deepseek-v4-flash") over openrouter.
 */
export function buildModelResolver(sources: ModelSources): (id: string | null) => ModelJson | null {
  const openrouter = sources.models;
  const harness = sources.harnessModels ?? [];
  const aliases = sources.aliases ?? {};
  const openrouterById = new Map(openrouter.map((m) => [m.id, m]));
  const harnessById = new Map(harness.map((m) => [m.id, m]));
  return (id) => {
    if (id === null || id.length === 0) return null;
    if (openrouter.length === 0 && harness.length === 0) return null;
    const target = aliases[id.trim().toLowerCase()] ?? id;
    const candidates = modelIdCandidates(target);
    for (const candidate of candidates) {
      const hit = harnessById.get(candidate);
      if (hit) return hit;
    }
    for (const candidate of candidates) {
      const hit = openrouterById.get(candidate);
      if (hit) return hit;
    }
    for (const candidate of candidates) {
      const hit = openrouter.find((m) => m.id.endsWith(`/${candidate}`));
      if (hit) return hit;
    }
    return null;
  };
}
