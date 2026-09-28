/**
 * Bare-alias resolution for Anthropic model shortnames (v7 spec §8 — FROZEN).
 * The pure rule lives in `@desplega/model-catalog`; re-exported here so evals
 * call sites stay unchanged.
 */
export {
  type AliasSourceModel,
  buildClaudeAliasMap,
  resolveClaudeAlias,
} from "@desplega/model-catalog";
