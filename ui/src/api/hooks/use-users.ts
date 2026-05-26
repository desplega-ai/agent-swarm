/**
 * Identity (Phase 2 ≥1.76.0) — react-query bindings for the new `users` table.
 *
 * Step-9 (Phase 064 ≥1.80.0): extended with the operator People-page
 * surface — detail fetch, PATCH, identity link/unlink, paginated events,
 * merge, and the kv-backed unmapped triage queue.
 *
 * Soft-degrade: callers must wrap usage of these hooks in
 * `useFeatureGate("1.76.0")` so older API servers (which 404 these endpoints)
 * don't render the identity surface.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type {
  CreateUserInput,
  ResolveUnmappedInput,
  UpdateUserInput,
  UserIdentity,
} from "../types";

export function useUsers(opts?: { recentEvents?: number }) {
  return useQuery({
    queryKey: ["users", { recentEvents: opts?.recentEvents ?? null }],
    queryFn: () => api.listUsers(opts),
    refetchInterval: 5000,
  });
}

export function useUser(id: string | undefined, opts?: { recentEvents?: number }) {
  return useQuery({
    queryKey: ["user", id, { recentEvents: opts?.recentEvents ?? null }],
    queryFn: () => api.getUser(id!, opts),
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUserInput) => api.createUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["unmapped"] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateUserInput }) => api.updateUser(id, data),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user", id] });
      queryClient.invalidateQueries({ queryKey: ["user-events", id] });
    },
  });
}

export function useMintUserToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label?: string | null }) =>
      api.mintUserToken(id, label),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user", id] });
      queryClient.invalidateQueries({ queryKey: ["user-events", id] });
    },
  });
}

export function useRevokeUserToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tokenId }: { id: string; tokenId: string }) =>
      api.revokeUserToken(id, tokenId),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user", id] });
      queryClient.invalidateQueries({ queryKey: ["user-events", id] });
    },
  });
}

export function useAddUserIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, identity }: { id: string; identity: UserIdentity }) =>
      api.addUserIdentity(id, identity),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user", id] });
      queryClient.invalidateQueries({ queryKey: ["user-events", id] });
    },
  });
}

export function useRemoveUserIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kind, externalId }: { id: string; kind: string; externalId: string }) =>
      api.removeUserIdentity(id, kind, externalId),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user", id] });
      queryClient.invalidateQueries({ queryKey: ["user-events", id] });
    },
  });
}

export function useUserEvents(id: string | undefined, opts?: { limit?: number }) {
  return useQuery({
    queryKey: ["user-events", id, opts?.limit ?? null],
    queryFn: () => api.listUserEvents(id!, opts),
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export function useMergeUsers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targetId, sourceUserId }: { targetId: string; sourceUserId: string }) =>
      api.mergeUsers(targetId, sourceUserId),
    onSuccess: (_data, { targetId, sourceUserId }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user", targetId] });
      queryClient.invalidateQueries({ queryKey: ["user", sourceUserId] });
      queryClient.invalidateQueries({ queryKey: ["user-events", targetId] });
    },
  });
}

export function useUnmapped(opts?: { kind?: string; limit?: number }) {
  return useQuery({
    queryKey: ["unmapped", opts?.kind ?? "all", opts?.limit ?? null],
    queryFn: () => api.listUnmapped(opts),
    refetchInterval: 5000,
  });
}

export function useResolveUnmapped() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      externalId,
      body,
    }: {
      kind: string;
      externalId: string;
      body: ResolveUnmappedInput;
    }) => api.resolveUnmapped(kind, externalId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["unmapped"] });
    },
  });
}
