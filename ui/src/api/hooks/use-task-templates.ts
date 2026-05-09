/**
 * Task templates (Phase 6 ≥1.76.0). Powers the "To start" inbox bucket.
 *
 * v1 callers always pass `kind="task"` (per the v2-aware schema discriminator
 * in `src/types.ts:286-300`). `staleTime: Infinity` because the registry is
 * read-only / seed-only in v1 — see plan section "What We're NOT Doing".
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { TaskTemplate, TaskTemplateKind } from "../types";

export interface UseTaskTemplatesOptions {
  category?: string;
  kind?: TaskTemplateKind;
  query?: string;
}

export function useTaskTemplates(options?: UseTaskTemplatesOptions) {
  const kind = options?.kind ?? "task";
  return useQuery<TaskTemplate[]>({
    queryKey: ["task-templates", { category: options?.category, kind, query: options?.query }],
    queryFn: () =>
      api.listTaskTemplates({
        category: options?.category,
        kind,
        query: options?.query,
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
