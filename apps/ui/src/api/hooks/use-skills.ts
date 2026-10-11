import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { SkillUsageWindow } from "../types";

/** Usage aggregates move slowly; poll them far less than the 10s default. */
const SKILL_USAGE_REFETCH_MS = 60_000;

/** Minutes east of UTC, so the server buckets days by the viewer's local day. */
function viewerTzOffset(): number {
  return -new Date().getTimezoneOffset();
}

export function useSkillUsage(window: SkillUsageWindow) {
  const tzOffset = viewerTzOffset();
  return useQuery({
    queryKey: ["skill-usage", window, tzOffset],
    queryFn: () => api.fetchSkillUsage(window, tzOffset),
    refetchInterval: SKILL_USAGE_REFETCH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useSkillUsageDetail(skillId: string, window: SkillUsageWindow) {
  const tzOffset = viewerTzOffset();
  return useQuery({
    queryKey: ["skill-usage-detail", skillId, window, tzOffset],
    queryFn: () => api.fetchSkillUsageDetail(skillId, window, tzOffset),
    enabled: !!skillId,
    refetchInterval: SKILL_USAGE_REFETCH_MS,
    // Keep the old window's numbers while a new window loads, never another skill's.
    placeholderData: (previous) => (previous?.skillId === skillId ? previous : undefined),
  });
}

export interface SkillFilters {
  type?: string;
  scope?: string;
  agentId?: string;
  enabled?: string;
  search?: string;
}

export function useSkills(filters?: SkillFilters) {
  return useQuery({
    queryKey: ["skills", filters],
    queryFn: () => api.fetchSkills(filters),
    select: (data) => ({ skills: data.skills, total: data.total }),
  });
}

export function useSkill(id: string) {
  return useQuery({
    queryKey: ["skill", id],
    queryFn: () => api.fetchSkill(id),
    enabled: !!id,
  });
}

export function useSkillFiles(skillId: string) {
  return useQuery({
    queryKey: ["skill-files", skillId],
    queryFn: () => api.fetchSkillFiles(skillId),
    enabled: !!skillId,
    select: (data) => data.files,
  });
}

export function useSkillFile(skillId: string, path: string | null) {
  return useQuery({
    queryKey: ["skill-file", skillId, path],
    queryFn: () => api.fetchSkillFile(skillId, path!),
    enabled: !!skillId && !!path,
    select: (data) => data.file,
  });
}

export function useAgentSkills(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["agent-skills", agentId],
    queryFn: () => api.fetchAgentSkills(agentId),
    enabled: !!agentId && enabled,
    select: (data) => ({ skills: data.skills, total: data.total }),
  });
}

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { content: string; type?: string; scope?: string; ownerAgentId?: string }) =>
      api.createSkill(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.updateSkill(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["skill", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["agent-skills"] });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["agent-skills"] });
    },
  });
}

export function useInstallSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, agentId }: { skillId: string; agentId: string }) =>
      api.installSkill(skillId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["agent-skills"] });
    },
  });
}

export function useUninstallSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, agentId }: { skillId: string; agentId: string }) =>
      api.uninstallSkill(skillId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["agent-skills"] });
    },
  });
}

export function useInstallRemoteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      sourceRepo: string;
      sourcePath?: string;
      scope?: string;
      isComplex?: boolean;
    }) => api.installRemoteSkill(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useSyncRemoteSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options?: { skillId?: string; force?: boolean }) => api.syncRemoteSkills(options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}
