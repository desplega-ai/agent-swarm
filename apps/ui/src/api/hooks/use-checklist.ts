import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/contexts/current-user-context";
import { api } from "../client";
import type { ChecklistAddRequest, ChecklistItem, ChecklistUpdateRequest } from "../types";

/** The checklist belongs to the picked user, so a user switch reads a fresh list. */
function checklistQueryKey(userId: string | null) {
  return ["checklist", userId] as const;
}

/**
 * The post-onboarding checklist. Polls on the app default, so an item whose
 * signal turns true (a channel saved elsewhere) checks itself.
 */
export function useChecklist(options?: { enabled?: boolean }) {
  const { userId } = useCurrentUser();
  return useQuery({
    queryKey: checklistQueryKey(userId),
    queryFn: () => api.getChecklist(),
    enabled: options?.enabled ?? true,
    // An API without the route answers 404: hide the card, do not retry.
    retry: false,
  });
}

type ChecklistMutation =
  | { type: "add"; body: ChecklistAddRequest }
  | { type: "update"; id: string; body: ChecklistUpdateRequest };

/** Add or change an item. The server recomputes `done`, so the list refetches after the write. */
export function useChecklistMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChecklistMutation): Promise<ChecklistItem> =>
      input.type === "add"
        ? api.addChecklistItem(input.body)
        : api.updateChecklistItem(input.id, input.body),
    // A GET that started before the write must not overwrite its result.
    onMutate: () => queryClient.cancelQueries({ queryKey: ["checklist"] }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["checklist"] }),
  });
}
