import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Extension, ExtensionInstallInput, ExtensionPatchInput } from "@/api/types";
import { api } from "../client";

/** Run-log tail refresh cadence while the detail page is mounted. */
const RUNS_REFETCH_MS = 10_000;

export function useExtensions() {
  return useQuery({
    queryKey: ["extensions"],
    queryFn: () => api.fetchExtensions(),
  });
}

/**
 * Per-extension queries take `enabled: false` to stop fetching and polling
 * while keeping the cache key, so a closing sheet can still render the last
 * data without refetching (or re-creating) a removed query.
 */
interface ExtensionQueryOptions {
  enabled?: boolean;
}

export function useExtension(
  id: string | undefined,
  { enabled = true }: ExtensionQueryOptions = {},
) {
  return useQuery({
    queryKey: ["extension", id],
    queryFn: () => api.fetchExtension(id as string),
    enabled: enabled && !!id,
  });
}

export function useExtensionVersions(
  id: string | undefined,
  { enabled = true }: ExtensionQueryOptions = {},
) {
  return useQuery({
    queryKey: ["extension-versions", id],
    queryFn: () => api.fetchExtensionVersions(id as string),
    enabled: enabled && !!id,
  });
}

export function useExtensionRuns(
  id: string | undefined,
  { enabled = true, limit = 50 }: ExtensionQueryOptions & { limit?: number } = {},
) {
  return useQuery({
    queryKey: ["extension-runs", id, limit],
    queryFn: () => api.fetchExtensionRuns(id as string, limit),
    enabled: enabled && !!id,
    refetchInterval: RUNS_REFETCH_MS,
  });
}

/**
 * Cancel the in-flight fetches and pending retries of one extension's per-id
 * queries. `enabled: false` only stops new fetches: a retained observer keeps
 * an already-failing fetch retrying. A removed query is not re-created.
 */
export function useCancelExtensionRequests() {
  const queryClient = useQueryClient();
  return useCallback(
    (id: string) => {
      void queryClient.cancelQueries({ queryKey: ["extension", id] });
      void queryClient.cancelQueries({ queryKey: ["extension-versions", id] });
      void queryClient.cancelQueries({ queryKey: ["extension-runs", id] });
    },
    [queryClient],
  );
}

export function useExtensionTypeDefs() {
  return useQuery({
    queryKey: ["extension-type-defs"],
    queryFn: () => api.fetchExtensionTypeDefs(),
    // The generated `swarm-extension.d.ts` is baked into the server binary, so
    // it only changes on deploy — keep it out of the global 10s poll.
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
}

/** Predefined bundles from `templates/extensions/`, each with its installed state. */
export function useExtensionCatalog() {
  return useQuery({
    queryKey: ["extension-catalog"],
    queryFn: () => api.fetchExtensionCatalog(),
  });
}

/**
 * Invalidate every query that reads an extension after a write. The catalog
 * carries each template's installed state, so it is refreshed on every write.
 */
function useExtensionInvalidator() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["extensions"] });
    void queryClient.invalidateQueries({ queryKey: ["extension-catalog"] });
    if (id) {
      void queryClient.invalidateQueries({ queryKey: ["extension", id] });
      void queryClient.invalidateQueries({ queryKey: ["extension-versions", id] });
      void queryClient.invalidateQueries({ queryKey: ["extension-runs", id] });
    }
  };
}

export function useInstallExtension() {
  const invalidate = useExtensionInvalidator();
  return useMutation({
    mutationFn: (input: ExtensionInstallInput) => api.installExtension(input),
    onSuccess: (result) => invalidate(result.extension.id),
  });
}

export function useDeleteExtension(id: string) {
  const invalidate = useExtensionInvalidator();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteExtension(id),
    onSuccess: () => {
      // Drop the card now: the list refetch below can be slow, and until it
      // lands the grid would still render the deleted card.
      queryClient.setQueryData<Extension[]>(["extensions"], (list) =>
        list?.filter((extension) => extension.id !== id),
      );
      invalidate();
      // The record is gone; drop its per-id caches instead of refetching a 404.
      queryClient.removeQueries({ queryKey: ["extension", id] });
      queryClient.removeQueries({ queryKey: ["extension-versions", id] });
      queryClient.removeQueries({ queryKey: ["extension-runs", id] });
    },
  });
}

export function usePatchExtension(id: string) {
  const invalidate = useExtensionInvalidator();
  return useMutation({
    mutationFn: (input: ExtensionPatchInput) => api.patchExtension(id, input),
    onSuccess: () => invalidate(id),
  });
}

export function useEnableExtension(id: string) {
  const invalidate = useExtensionInvalidator();
  return useMutation({
    mutationFn: () => api.enableExtension(id),
    onSuccess: () => invalidate(id),
  });
}

export function useDisableExtension(id: string) {
  const invalidate = useExtensionInvalidator();
  return useMutation({
    mutationFn: () => api.disableExtension(id),
    onSuccess: () => invalidate(id),
  });
}

export function useActivateExtensionVersion(id: string) {
  const invalidate = useExtensionInvalidator();
  return useMutation({
    mutationFn: (version: number) => api.activateExtensionVersion(id, version),
    onSuccess: () => invalidate(id),
  });
}
