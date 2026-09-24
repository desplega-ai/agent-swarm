import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExtensionInstallInput, ExtensionPatchInput } from "@/api/types";
import { api } from "../client";

/** Run-log tail refresh cadence while the detail page is mounted. */
const RUNS_REFETCH_MS = 10_000;

export function useExtensions() {
  return useQuery({
    queryKey: ["extensions"],
    queryFn: () => api.fetchExtensions(),
  });
}

export function useExtension(id: string | undefined) {
  return useQuery({
    queryKey: ["extension", id],
    queryFn: () => api.fetchExtension(id as string),
    enabled: !!id,
  });
}

export function useExtensionVersions(id: string | undefined) {
  return useQuery({
    queryKey: ["extension-versions", id],
    queryFn: () => api.fetchExtensionVersions(id as string),
    enabled: !!id,
  });
}

export function useExtensionRuns(id: string | undefined, limit = 50) {
  return useQuery({
    queryKey: ["extension-runs", id, limit],
    queryFn: () => api.fetchExtensionRuns(id as string, limit),
    enabled: !!id,
    refetchInterval: RUNS_REFETCH_MS,
  });
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
