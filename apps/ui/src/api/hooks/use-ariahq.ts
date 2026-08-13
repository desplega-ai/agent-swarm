import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/current-user-context";
import { api } from "../client";

function useAriaUserId(): string {
  return useCurrentUser().userId ?? "";
}

export function useAriaEngineCatalog() {
  const userId = useAriaUserId();
  return useQuery({
    queryKey: ["ariahq", "engines", userId],
    queryFn: () => api.fetchAriaEngineCatalog(userId),
    enabled: !!userId,
    refetchInterval: 5_000,
  });
}

export function useCreateAriaEngineDraft() {
  const userId = useAriaUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; brief: string }) =>
      api.createAriaEngineDraft(userId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ariahq", "engines"] });
      toast.success("Aria is drafting the engine contract");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useReconcileAriaEngineDraft() {
  const userId = useAriaUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.reconcileAriaEngineDraft(userId, id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["ariahq", "engines"] }),
    onError: (error) => toast.error(error.message),
  });
}

export function usePublishAriaEngineDraft() {
  const userId = useAriaUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.publishAriaEngineDraft(userId, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ariahq", "engines"] });
      toast.success("Engine published with immutable workflow authority");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useAskAria() {
  const userId = useAriaUserId();
  return useMutation({
    mutationFn: (question: string) => api.askAria(userId, question),
    onError: (error) => toast.error(error.message),
  });
}

export function useAriaClientIntakes() {
  const userId = useAriaUserId();
  return useQuery({
    queryKey: ["ariahq", "client-intakes", userId],
    queryFn: () => api.fetchAriaClientIntakes(userId),
    enabled: !!userId,
    refetchInterval: 5_000,
  });
}

export function useAriaKnowledgeSources() {
  const userId = useAriaUserId();
  return useQuery({
    queryKey: ["ariahq", "knowledge-sources", userId],
    queryFn: () => api.fetchAriaKnowledgeSources(userId),
    enabled: !!userId,
    refetchInterval: 10_000,
  });
}

export function useAriaSlackSurfaces() {
  const userId = useAriaUserId();
  return useQuery({
    queryKey: ["ariahq", "slack-surfaces", userId],
    queryFn: () => api.fetchAriaSlackSurfaces(userId),
    enabled: !!userId,
    refetchInterval: 10_000,
  });
}

export function useVerifyAriaSlackSurface() {
  const userId = useAriaUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (surfaceId: string) => api.verifyAriaSlackSurface(userId, surfaceId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["ariahq", "slack-surfaces"] });
      const surface = result.surfaces[0];
      if (surface?.verificationStatus === "verified") toast.success("Slack surface verified");
      else toast.error(surface?.verificationError ?? "Slack surface could not be verified");
    },
    onError: (error) => toast.error(error.message),
  });
}
