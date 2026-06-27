/**
 * Bare-alias resolution for Anthropic model shortnames (v7 spec §8 — FROZEN).
 *
 * Claude configs use bare aliases as MODEL_OVERRIDE ("haiku", "sonnet",
 * "opus", "fable") that the Claude Code harness resolves internally.
 * Historical attempt rows store those aliases verbatim, so pricing and
 * display must resolve them at READ time against the models.dev snapshot's
 * `anthropic` section — never persist the resolved id back onto old rows.
 *
 * Frozen resolution rule — alias → the LATEST family member:
 *   1. Candidates: `anthropic`-section ids starting with "claude" whose
 *      dash-tokenized form contains the alias as a purely-alphabetic token
 *      ("claude-fable-5" → ["claude","fable","5"] → family "fable";
 *       "claude-3-5-haiku-20241022" → family "haiku").
 *   2. Dated ids (trailing -YYYYMMDD) and "-latest" ids are EXCLUDED — the
 *      undated canonical id always coexists with them in the snapshot.
 *   3. Winner: max `release_date`; ties broken by the lexicographically
 *      greatest id. Fully deterministic for a given snapshot.
 *
 * Pure module — no IO, no Bun APIs. `evals/src/cost/pricing.ts` owns snapshot
 * loading and feeds this the section; the evals API ships the computed map to
 * the UI on `GET /api/models` (`aliases`), so both sides resolve identically.
 */

/** One anthropic-section model as the alias rule consumes it. */
export interface AliasSourceModel {
  id: string;
  /** models.dev `release_date` (ISO date); null sorts before any real date. */
  releaseDate: string | null;
}

/** Dated snapshot variants ("claude-haiku-4-5-20251001") never win an alias. */
const DATED_ID_RE = /-\d{8}$/;

/** Purely-alphabetic dash token = a family name; numeric tokens are versions. */
const FAMILY_TOKEN_RE = /^[a-z]+$/;

/**
 * Build the frozen alias map (e.g. `{ fable: "claude-fable-5", opus: "claude-opus-4-8" }`)
 * from the models.dev `anthropic` section. Families are DERIVED (not a frozen
 * list) so future Anthropic families alias automatically.
 */
export function buildClaudeAliasMap(models: AliasSourceModel[]): Record<string, string> {
  const best = new Map<string, AliasSourceModel>();
  for (const model of models) {
    const id = model.id.toLowerCase();
    if (!id.startsWith("claude")) continue;
    if (DATED_ID_RE.test(id) || id.endsWith("-latest")) continue;
    for (const token of id.split("-")) {
      if (token === "claude" || !FAMILY_TOKEN_RE.test(token)) continue;
      const current = best.get(token);
      if (!current || isNewer(model, current)) best.set(token, model);
    }
  }
  const out: Record<string, string> = {};
  for (const [alias, model] of best) out[alias] = model.id;
  return out;
}

/** Strict ordering: release_date first (null < any date), then id (lexicographic). */
function isNewer(a: AliasSourceModel, b: AliasSourceModel): boolean {
  const ra = a.releaseDate ?? "";
  const rb = b.releaseDate ?? "";
  if (ra !== rb) return ra > rb;
  return a.id > b.id;
}

/**
 * Resolve a bare alias ("fable") to its canonical anthropic-section id
 * ("claude-fable-5"). Case/whitespace-insensitive. Null when the input is not
 * a known alias — concrete ids pass through lookup untouched elsewhere.
 */
export function resolveClaudeAlias(alias: string, aliasMap: Record<string, string>): string | null {
  return aliasMap[alias.trim().toLowerCase()] ?? null;
}
