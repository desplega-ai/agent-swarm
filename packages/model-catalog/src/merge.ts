import type { ModelsDevCatalog, ModelsDevModel } from "./types.ts";

/** Overlay shape: any section may omit id/name, and models may be partial. */
export type ModelsDevOverlay = Record<
  string,
  { id?: string; name?: string; models?: Record<string, ModelsDevModel> }
>;

/**
 * Merge `overlay` over `base` by provider section + model id. Overlay wins
 * field-by-field (shallow per model); sections and models present on only one
 * side are kept. Inputs are not mutated.
 */
export function mergeCatalog(base: ModelsDevCatalog, overlay: ModelsDevOverlay): ModelsDevCatalog {
  const out: ModelsDevCatalog = {};
  for (const [key, section] of Object.entries(base)) {
    out[key] = { ...section, models: { ...section.models } };
  }
  for (const [key, section] of Object.entries(overlay)) {
    const current = out[key] ?? { id: key, name: key, models: {} };
    const models = { ...current.models };
    for (const [id, model] of Object.entries(section.models ?? {})) {
      models[id] = { ...(models[id] ?? {}), ...model };
    }
    out[key] = { id: section.id ?? current.id, name: section.name ?? current.name, models };
  }
  return out;
}
