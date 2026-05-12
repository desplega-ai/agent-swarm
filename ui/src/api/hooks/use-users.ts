/**
 * Identity (Phase 2 ≥1.76.0) — react-query bindings for the new `users` table.
 *
 * Soft-degrade: callers must wrap usage of these hooks in
 * `useFeatureGate("1.76.0")` so older API servers (which 404 these endpoints)
 * don't render the identity surface.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { CreateUserInput } from "../types";

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => api.listUsers(),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUserInput) => api.createUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
