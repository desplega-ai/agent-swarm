export {
  buildClaudeShortnameMap,
  compareNewestFirst,
  HARNESS_CATALOG_SECTION,
  type HarnessCatalogModel,
  harnessCatalogSection,
  harnessModelIds,
  isHarnessCatalogModel,
  modelFamilyKey,
} from "./harness-models.ts";
export { type ModelsDevOverlay, mergeCatalog } from "./merge.ts";
export { type AliasSourceModel, buildClaudeAliasMap, resolveClaudeAlias } from "./model-alias.ts";
export {
  type AliasChannel,
  type AliasPolicy,
  globToRegExp,
  isAlias,
  isNewer,
  type ParsedAlias,
  parseAlias,
  resolveAlias,
} from "./resolve-alias.ts";
export type { ModelsDevCatalog, ModelsDevModel, ModelsDevSection } from "./types.ts";
