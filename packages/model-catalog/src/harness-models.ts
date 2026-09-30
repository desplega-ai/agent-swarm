/**
 * Harness-scoped views of the model catalog (model-catalog phase 4).
 *
 * The direct harnesses (claude, claude-managed, codex) used to carry
 * hand-maintained allowlists, pricing and context-window tables. They now
 * derive their model list from the catalog section their CLI talks to, with
 * the rules below. A new model therefore appears in every harness list as
 * soon as it lands in `model_catalog` (refresh or overlay row), with no code
 * change. The rules only change when a vendor ships a new *kind* of SKU
 * (e.g. an audio-only line), never per model.
 *
 * Pure module: no IO, no Bun APIs.
 */

import { isAlias, parseAlias } from "./resolve-alias.ts";

/** Minimal per-model facts the filters read. */
export interface HarnessCatalogModel {
  release_date?: string | null;
  reasoning?: boolean | null;
  status?: string | null;
}

/** Catalog section (models.dev provider id) a direct harness's CLI talks to. */
export const HARNESS_CATALOG_SECTION: Readonly<Record<string, "anthropic" | "openai">> = {
  claude: "anthropic",
  "claude-managed": "anthropic",
  codex: "openai",
};

export function harnessCatalogSection(harness: string): "anthropic" | "openai" | null {
  return HARNESS_CATALOG_SECTION[harness] ?? null;
}

const DATED_ID_RE = /-\d{8}$/;
const ISO_DATED_ID_RE = /-\d{4}-\d{2}-\d{2}$/;

/**
 * OpenAI id tokens that mark a SKU Codex cannot drive as an agent (chat-only
 * aliases, audio/realtime/image lines, research previews, pro tiers that only
 * serve the background Responses API, ChatGPT-only research previews such as
 * `-spark`).
 */
const CODEX_EXCLUDED_TOKENS = new Set([
  "chat",
  "latest",
  "pro",
  "nano",
  "spark",
  "realtime",
  "audio",
  "image",
  "search",
  "transcribe",
  "tts",
  "deep",
  "research",
  "oss",
]);

/** Oldest GPT major the Codex CLI drives (the Responses-API agentic line). */
const CODEX_MIN_GPT_MAJOR = 5;

/**
 * Whether a catalog model belongs in a harness's model list. Deprecated
 * models are dropped everywhere; pricing and context lookups still resolve
 * them (see the runtime catalog), only pickers and allowlists hide them.
 */
export function isHarnessCatalogModel(
  harness: string,
  id: string,
  model: HarnessCatalogModel = {},
): boolean {
  const lower = id.toLowerCase();
  if (model.status === "deprecated") return false;
  const section = harnessCatalogSection(harness);
  if (section === "anthropic") {
    if (!lower.startsWith("claude-")) return false;
    if (DATED_ID_RE.test(lower) || lower.endsWith("-latest")) return false;
    // Pre-4 generations (claude-3-5-sonnet ...) are retired for agent use.
    if (/^claude-\d/.test(lower)) return false;
    return true;
  }
  if (section === "openai") {
    const match = /^gpt-(\d+)/.exec(lower);
    if (!match || Number(match[1]) < CODEX_MIN_GPT_MAJOR) return false;
    if (DATED_ID_RE.test(lower) || ISO_DATED_ID_RE.test(lower)) return false;
    if (model.reasoning === false) return false;
    for (const token of lower.split("-")) {
      if (CODEX_EXCLUDED_TOKENS.has(token)) return false;
    }
    return true;
  }
  return false;
}

/** Newest first: release_date desc (missing dates sort first — just-launched overlay rows), then id desc. */
export function compareNewestFirst(
  a: { id: string; release_date?: string | null },
  b: { id: string; release_date?: string | null },
): number {
  const ra = a.release_date ?? "9999";
  const rb = b.release_date ?? "9999";
  if (ra !== rb) return ra > rb ? -1 : 1;
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

/** Harness model ids from one catalog section, filtered and newest first. */
export function harnessModelIds(
  harness: string,
  models: Record<string, HarnessCatalogModel> | undefined,
): string[] {
  return Object.entries(models ?? {})
    .filter(([id, m]) => isHarnessCatalogModel(harness, id, m))
    .map(([id, m]) => ({ id, release_date: m.release_date ?? null }))
    .sort(compareNewestFirst)
    .map((m) => m.id);
}

/**
 * Version-free family key used for CLI-unsupported fallback:
 * `claude-opus-5-5` → `claude-opus`, `gpt-5.6-terra` → `gpt-terra`,
 * `gpt-5.4-mini` → `gpt-mini`, `claude-haiku-4-5-20251001` → `claude-haiku`.
 */
export function modelFamilyKey(id: string): string {
  const slash = id.lastIndexOf("/");
  const tail = (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
  return tail
    .split("-")
    .filter((token) => token !== "" && !/^\d+(\.\d+)*$/.test(token))
    .join("-");
}

/**
 * Bare Claude CLI shortnames (`opus`, `sonnet`, ...) → newest canonical id,
 * derived from the anthropic section. Same token rule as the frozen
 * `buildClaudeAliasMap`, except a model with no `release_date` ranks as the
 * newest of its family: only just-launched models (pinned snapshot entries,
 * overlay rows written before models.dev lists them) lack a date.
 */
export function buildClaudeShortnameMap(
  models: Record<string, HarnessCatalogModel> | undefined,
): Record<string, string> {
  const best = new Map<string, { id: string; release_date: string | null }>();
  for (const [rawId, m] of Object.entries(models ?? {})) {
    const id = rawId.toLowerCase();
    if (!id.startsWith("claude")) continue;
    if (DATED_ID_RE.test(id) || id.endsWith("-latest")) continue;
    if (m.status === "deprecated") continue;
    const candidate = { id: rawId, release_date: m.release_date ?? null };
    for (const token of id.split("-")) {
      if (token === "claude" || !/^[a-z]+$/.test(token)) continue;
      const current = best.get(token);
      if (!current || compareNewestFirst(candidate, current) < 0) best.set(token, candidate);
    }
  }
  const out: Record<string, string> = {};
  for (const [alias, model] of best) out[alias] = model.id;
  return out;
}

/** Catalog sections as the guard reads them (a subset of `ModelsDevCatalog`). */
export type HarnessCatalogSections = Record<
  string,
  { models?: Record<string, HarnessCatalogModel> } | undefined
>;

/** Claude CLI context-window suffix (`sonnet[1m]`): the CLI reads it, the catalog does not list it. */
const CONTEXT_SUFFIX_RE = /\[1m\]$/i;
const MAX_EXAMPLE_IDS = 8;

/**
 * Null when `model` runs on `harness`, else the reason. Only the pinned
 * harnesses (claude, claude-managed, codex) are judged; every other harness,
 * and an id the catalog does not know at all, passes (the catalog membership
 * check decides those). Legacy shortnames and `modelTier` never reach here as
 * a cross-harness problem: a bare `opus` on codex is unknown to every section.
 *
 * Pure: no IO, so the worker can call it with the runtime catalog.
 */
export function harnessModelMismatch(
  model: string,
  harness: string | null | undefined,
  sections: HarnessCatalogSections,
  context: { agentName?: string | null; agentId?: string | null } = {},
): string | null {
  const section = harness ? harnessCatalogSection(harness) : null;
  if (!harness || !section) return null;
  const id = model.trim().replace(CONTEXT_SUFFIX_RE, "");
  if (!id) return null;
  const own = sections[section]?.models ?? {};
  const fail = () => harnessMismatchMessage(model.trim(), harness, section, own, context);

  if (isAlias(id)) {
    const parsed = parseAlias(id);
    // Bad grammar is the alias check's job, not this one.
    if (!parsed) return null;
    return parsed.kind === section ? null : fail();
  }

  let bare = id;
  const slash = id.indexOf("/");
  if (slash > 0) {
    if (id.slice(0, slash) !== section) return fail();
    // The harness's own namespace: judge the rest like a bare id, so an
    // uncatalogued id defers to the caller's custom-model check.
    bare = id.slice(slash + 1);
  }

  if (section === "anthropic" && Object.hasOwn(buildClaudeShortnameMap(own), bare)) return null;
  if (Object.hasOwn(own, bare)) {
    return isHarnessCatalogModel(harness, bare, own[bare]) ? null : fail();
  }
  for (const [name, other] of Object.entries(sections)) {
    if (name === section) continue;
    if (other?.models && Object.hasOwn(other.models, bare)) return fail();
  }
  return null;
}

function harnessMismatchMessage(
  model: string,
  harness: string,
  section: string,
  own: Record<string, HarnessCatalogModel>,
  context: { agentName?: string | null; agentId?: string | null },
): string {
  const agent = context.agentId
    ? ` of agent "${context.agentName ?? context.agentId}" (${context.agentId})`
    : "";
  const ids = harnessModelIds(harness, own);
  const extra = ids.length - MAX_EXAMPLE_IDS;
  const examples =
    ids.slice(0, MAX_EXAMPLE_IDS).join(", ") + (extra > 0 ? ` and ${extra} more` : "");
  return `Model "${model}" does not run on the ${harness} harness${agent}. The ${harness} harness accepts ${section} catalog models, for example: ${examples}. Use modelTier (smol, regular, smart, ultra) for portable intent, or omit model and let the assignee resolve it.`;
}
