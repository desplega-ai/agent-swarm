import type { PromptTemplate } from "../../types";
import {
  type PromptTemplateFilters,
  type PromptTemplateRow,
  promptTemplateListQuery,
  rowToPromptTemplate,
} from "./prompt-templates";
import { getDb } from "./runtime";

/** List templates synchronously during startup seeding. */
export function getPromptTemplatesForBoot(filters?: PromptTemplateFilters): PromptTemplate[] {
  const { query, params } = promptTemplateListQuery(filters);
  return getDb()
    .prepare<PromptTemplateRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToPromptTemplate);
}
