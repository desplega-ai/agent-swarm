// The optimistic share-edit mutation behind the Share dialog, kept free of
// React and the API client so `bun:test` can drive it with a bare QueryClient.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { MutationOptions, QueryClient } from "@tanstack/react-query";
import type { SessionShares } from "../api/types";

type ShareEditContext = { previous: SessionShares | null | undefined };

/**
 * Each PUT carries the full desired state and they run one at a time (shared
 * `scope`), but each edit is applied to the cache at once. So a response may
 * only land when no newer edit is pending: an older response would bring back
 * a person the newer edit removed, and the next edit would send them again.
 */
export function sessionSharesMutationOptions(
  queryClient: QueryClient,
  rootTaskId: string,
  put: (next: SessionShares) => Promise<SessionShares>,
  onFailure: (error: unknown) => void,
): MutationOptions<SessionShares, unknown, SessionShares, ShareEditContext> {
  const key = ["session-shares", rootTaskId];
  const newerEditPending = () => queryClient.isMutating({ mutationKey: key }) > 1;
  return {
    mutationKey: key,
    scope: { id: `session-shares:${rootTaskId}` },
    mutationFn: put,
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SessionShares | null>(key);
      queryClient.setQueryData(key, next);
      return { previous };
    },
    onError: (error, _next, context) => {
      // A newer pending edit already holds the state the user wants.
      if (!newerEditPending()) {
        queryClient.setQueryData(key, context?.previous);
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onFailure(error);
    },
    onSuccess: (saved) => {
      if (!newerEditPending()) queryClient.setQueryData(key, saved);
    },
  };
}
