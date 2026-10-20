/**
 * Sessions surface: presence for the open session. The provider owns the one
 * realtime room; the header shows who else is here and the composer reports
 * typing through `useSessionPresenceContext`. Without a provider (the
 * contextual session panel) presence is off and typing is a no-op.
 */

import { createContext, type ReactNode, useContext } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { AvatarStack } from "@/components/comb/presence-avatars";
import { type SessionPresence, useSessionPresence } from "@/hooks/use-session-presence";
import { SESSION_PRESENCE_MIN_VERSION } from "@/lib/session-sharing";

const OFF: SessionPresence = { viewers: [], setTyping: () => {} };

const SessionPresenceContext = createContext<SessionPresence>(OFF);

export function SessionPresenceProvider({
  rootTaskId,
  enabled = true,
  children,
}: {
  rootTaskId: string;
  /** Off until the session loads, so a viewer with no access never asks for a ticket. */
  enabled?: boolean;
  children: ReactNode;
}) {
  const gate = useFeatureGate(SESSION_PRESENCE_MIN_VERSION);
  const presence = useSessionPresence(rootTaskId, gate.supported && enabled);
  return (
    <SessionPresenceContext.Provider value={presence}>{children}</SessionPresenceContext.Provider>
  );
}

export function useSessionPresenceContext(): SessionPresence {
  return useContext(SessionPresenceContext);
}

/** The other people in this session, as a small avatar stack ("Viewing" / "Typing…"). */
export function SessionPresenceAvatars() {
  const { viewers } = useSessionPresenceContext();
  return (
    <AvatarStack
      peers={viewers.map((viewer) => ({
        id: viewer.id,
        name: viewer.name,
        avatar: viewer.avatar,
        color: viewer.color,
        doing: viewer.typing ? "Typing…" : "Viewing",
      }))}
    />
  );
}
