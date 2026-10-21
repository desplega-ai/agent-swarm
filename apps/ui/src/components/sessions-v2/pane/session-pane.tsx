import { useSession } from "@/api/hooks/use-sessions";
import { SessionConversation } from "@/components/sessions/session-conversation";
import { SessionPresenceProvider } from "@/components/sessions/session-presence";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { useMarkReadOnOpen } from "./use-mark-read-on-open";

/**
 * The focused session in the v2 pane: today's conversation (timeline, prompt
 * attachments, composer, presence), without the legacy list shell. Phase 6
 * adds the two-row header above it, and Phase 7 swaps in the turn timeline.
 */
export function SessionPane({ rootTaskId }: { rootTaskId: string }) {
  const { data: detail } = useSession(rootTaskId);
  useMarkReadOnOpen(detail);
  // The legacy header's Handoffs toggle. Read here so a user who turned it on
  // sees the same timeline in both views. The v2 header (Phase 6) sets it.
  const [showInternalHandoffs] = useLocalToggle("sessions:show-internal-handoffs", false);
  return (
    // Off until the session loads, so a viewer with no access never asks for a ticket.
    <SessionPresenceProvider rootTaskId={rootTaskId} enabled={!!detail}>
      <SessionConversation rootTaskId={rootTaskId} showInternalHandoffs={showInternalHandoffs} />
    </SessionPresenceProvider>
  );
}
