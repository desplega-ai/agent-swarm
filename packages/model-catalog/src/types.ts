/** Pure models.dev catalog types (https://models.dev/api.json). */

export interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
  /** Which reasoning controls the model takes (`effort` lists its levels); see `reasoningLevelsFor`. */
  reasoning_options?: { type?: string; values?: string[] }[];
  tool_call?: boolean;
  release_date?: string;
  limit?: { context?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevSection {
  id: string;
  name: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevSection>;
