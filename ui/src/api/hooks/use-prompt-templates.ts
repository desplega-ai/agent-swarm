import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { UpsertPromptTemplateInput } from "../types";

export interface PromptTemplateFilters {
  eventType?: string;
  scope?: string;
  isDefault?: boolean;
}

export function usePromptTemplates(filters?: PromptTemplateFilters) {
  return useQuery({
    queryKey: ["prompt-templates", filters],
    queryFn: () => api.fetchPromptTemplates(filters),
    select: (data) => data.templates,
  });
}

export function usePromptTemplate(id?: string) {
  return useQuery({
    queryKey: ["prompt-template", id],
    queryFn: () => api.fetchPromptTemplate(id!),
    enabled: !!id,
  });
}

export function usePromptTemplateEvents() {
  return useQuery({
    queryKey: ["prompt-template-events"],
    queryFn: () => api.fetchPromptTemplateEvents(),
    select: (data) => data.events,
  });
}

export function usePreviewTemplate() {
  return useMutation({
    mutationFn: (data: { eventType: string; body?: string; variables?: Record<string, unknown> }) =>
      api.previewPromptTemplate(data),
  });
}

export function useRenderTemplate() {
  return useMutation({
    mutationFn: (data: {
      eventType: string;
      variables?: Record<string, unknown>;
      agentId?: string;
      repoId?: string;
    }) => api.renderPromptTemplate(data),
  });
}

export function useUpsertTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpsertPromptTemplateInput) => api.upsertPromptTemplate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
      queryClient.invalidateQueries({ queryKey: ["prompt-template"] });
    },
  });
}

export function useCheckoutTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.checkoutPromptTemplate(id, version),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
      queryClient.invalidateQueries({ queryKey: ["prompt-template", variables.id] });
    },
  });
}

export function useResetTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.resetPromptTemplate(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
      queryClient.invalidateQueries({ queryKey: ["prompt-template", id] });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deletePromptTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
    },
  });
}
