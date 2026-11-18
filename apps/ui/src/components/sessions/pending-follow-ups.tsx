/**
 * Optimistic follow-ups in a session. A text-only follow-up from the Sessions
 * composer shows at once as the person's bubble, read from the mutation's
 * variables (`useMutationState`), while `POST /api/tasks` runs. The box clears
 * on send and stays editable.
 *
 * - On success the created task goes straight into the session cache, and the
 *   bubble goes once the chain holds the task id (a refetch that raced the
 *   insert brings the bubble back until the next one).
 * - On failure the bubble stays with "Not sent · Retry · Edit", so the text is
 *   never lost. Retry sends the same variables, with the same idempotency key:
 *   a first request that did commit gives back its task, not a second one.
 *   Edit moves the text back into the box and drops the bubble.
 *
 * Follow-ups with files keep the composer's own send path (upload, then
 * promote); they never show here.
 *
 * Each viewer of the tab (`useCurrentUser`) has their own follow-ups: the
 * mutation key holds the viewer, so a switch to another person hides the
 * bubbles, Retry and Edit of the one before. A send keeps the session cache
 * key of the viewer who made it, so its task lands in their chain even when
 * the response comes back after the switch.
 */

import {
  type QueryKey,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "@/api/client";
import { sessionDetailKey } from "@/api/hooks/session-query-keys";
import type { AgentTask, SessionDetailResponse } from "@/api/types";
import { MessageText } from "@/components/shared/transcript/message-text";
import { useCurrentUser } from "@/contexts/current-user-context";
import { CHAT_COLUMN } from "@/lib/chat-width";
import { composerDraftStorageKey, composerDrafts } from "@/lib/composer-drafts";
import { cn } from "@/lib/utils";

export interface FollowUpVariables {
  task: string;
  parentTaskId?: string;
  agentId?: string;
  routingReason?: "continuity";
  requestedByUserId?: string;
  /** One per bubble: a Retry reuses it. */
  idempotencyKey: string;
}

function followUpMutationKey(rootTaskId: string, viewerId: string | null) {
  return ["session-follow-up", rootTaskId, viewerId];
}

/** Kept on the mutation at send time: the session cache of the viewer who sent it. */
interface FollowUpContext {
  detailKey: QueryKey;
}

/**
 * Sends a follow-up in `rootTaskId`'s session as the current viewer; its
 * bubble shows through that viewer's `usePendingFollowUps`.
 */
export function useSendFollowUp(rootTaskId: string) {
  const queryClient = useQueryClient();
  const viewerId = useCurrentUser().userId ?? null;
  return useMutation<AgentTask, Error, FollowUpVariables, FollowUpContext>({
    mutationKey: followUpMutationKey(rootTaskId, viewerId),
    // A failed send is the only copy of its text: keep it until Edit or the chain takes it.
    gcTime: Number.POSITIVE_INFINITY,
    mutationFn: ({ idempotencyKey, ...input }: FollowUpVariables) =>
      api.createTask({ ...input, source: "ui" }, { idempotencyKey }),
    // Runs at send time: the observer's options (and this closure's viewer)
    // can change before the response, the mutation's context cannot.
    onMutate: () => ({ detailKey: sessionDetailKey(rootTaskId, viewerId) }),
    onSuccess: (created, input, context) => {
      queryClient.setQueryData<SessionDetailResponse>(context.detailKey, (detail) =>
        detail && !detail.chain.some((task) => task.id === created.id)
          ? { ...detail, chain: [...detail.chain, created] }
          : detail,
      );
      queryClient.invalidateQueries({ queryKey: ["session", rootTaskId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (input.parentTaskId) {
        // `exact`: the parent's log, context and steering reads stay as they are.
        queryClient.invalidateQueries({ queryKey: ["task", input.parentTaskId], exact: true });
        queryClient.invalidateQueries({ queryKey: ["session", input.parentTaskId] });
      }
    },
  });
}

interface PendingFollowUp {
  mutationId: number;
  status: "pending" | "error";
  variables: FollowUpVariables;
  error: string | null;
}

function findMutation(queryClient: ReturnType<typeof useQueryClient>, mutationId: number) {
  return queryClient
    .getMutationCache()
    .find({ predicate: (mutation) => mutation.mutationId === mutationId });
}

/** The current viewer's follow-ups still sending or failed, in send order. */
export function usePendingFollowUps(rootTaskId: string, chain: AgentTask[] | undefined) {
  const queryClient = useQueryClient();
  const viewerId = useCurrentUser().userId ?? null;
  const sent = useMutationState({
    filters: { mutationKey: followUpMutationKey(rootTaskId, viewerId) },
    select: (mutation) => ({
      mutationId: mutation.mutationId,
      status: mutation.state.status,
      variables: mutation.state.variables as FollowUpVariables,
      createdId: (mutation.state.data as AgentTask | undefined)?.id ?? null,
      error: mutation.state.error instanceof Error ? mutation.state.error.message : null,
    }),
  });
  const inChain = useMemo(() => new Set(chain?.map((task) => task.id)), [chain]);

  // A sent follow-up the chain shows is done: drop it from the cache.
  useEffect(() => {
    for (const item of sent) {
      if (item.createdId && inChain.has(item.createdId)) {
        const mutation = findMutation(queryClient, item.mutationId);
        if (mutation) queryClient.getMutationCache().remove(mutation);
      }
    }
  }, [sent, inChain, queryClient]);

  return useMemo(
    () =>
      sent.flatMap((item): PendingFollowUp[] =>
        item.createdId && inChain.has(item.createdId)
          ? []
          : [
              {
                mutationId: item.mutationId,
                status: item.status === "error" ? "error" : "pending",
                variables: item.variables,
                error: item.error,
              },
            ],
      ),
    [sent, inChain],
  );
}

/**
 * The bubbles of `usePendingFollowUps`, under the timeline. `draftKey` is the
 * composer's draft key: Edit puts the text back there.
 */
export function PendingFollowUps({
  rootTaskId,
  items,
  draftKey,
}: {
  rootTaskId: string;
  items: PendingFollowUp[];
  draftKey: string;
}) {
  const queryClient = useQueryClient();
  const send = useSendFollowUp(rootTaskId);
  if (items.length === 0) return null;

  const drop = (mutationId: number) => {
    const mutation = findMutation(queryClient, mutationId);
    if (mutation) queryClient.getMutationCache().remove(mutation);
  };
  const retry = (item: PendingFollowUp) => {
    drop(item.mutationId);
    send.mutate(item.variables);
  };
  const edit = (item: PendingFollowUp) => {
    const key = composerDraftStorageKey(draftKey);
    const current = composerDrafts.get(key);
    composerDrafts.set(
      key,
      current.trim() ? `${item.variables.task}\n\n${current}` : item.variables.task,
    );
    drop(item.mutationId);
  };

  return (
    <div className={cn("mt-6 flex flex-col gap-6", CHAT_COLUMN)}>
      {items.map((item) => (
        <section
          key={item.mutationId}
          aria-label="Your message"
          aria-busy={item.status === "pending"}
          className="flex min-w-0 flex-col items-end gap-1.5"
        >
          <div
            className={cn(
              "max-w-full min-w-0 rounded-2xl rounded-tr-sm bg-muted px-3.5 py-2 text-base leading-relaxed whitespace-pre-wrap wrap-anywhere md:text-sm",
              item.status === "pending" && "opacity-70",
            )}
          >
            <MessageText text={item.variables.task} raw={false} />
          </div>
          {item.status === "error" ? (
            <p
              role="alert"
              className="flex items-center gap-1.5 text-meta text-status-error-strong"
              title={item.error ?? undefined}
            >
              <span>Not sent</span>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => retry(item)}
              >
                Retry
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => edit(item)}
              >
                Edit
              </button>
            </p>
          ) : (
            <span className="text-meta text-muted-foreground">Sending…</span>
          )}
        </section>
      ))}
    </div>
  );
}
