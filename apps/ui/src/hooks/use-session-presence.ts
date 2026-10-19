/**
 * Session presence: one realtime room per open session. Publishes this tab's
 * `{ who, typing }` and returns the other people in the session (own tabs
 * hidden, several tabs of one person folded together).
 *
 * `who` is the tab's identity: `/api/whoami` for a user token, the picked
 * identity on the shared operator key (see `useCurrentUser`). A tab with no
 * identity still sees others but publishes nothing.
 *
 * A refused ticket or join (no access, an older server) stops the client
 * silently: the header then shows no avatars.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { PresenceWho } from "@/lib/comb/presence";
import { PresenceClient } from "@/lib/comb/presence-client";
import {
  type ParsedSessionPeer,
  parseSessionPeer,
  SESSION_HEARTBEAT_MS,
  type SessionPresenceData,
  type SessionViewer,
  sessionPresenceNamespace,
  sessionViewers,
  TYPING_THROTTLE_MS,
} from "@/lib/session-presence";

export interface SessionPresence {
  /** The other people in the session. */
  viewers: SessionViewer[];
  /** Report whether this tab is typing. Throttled to one change per 2 s. */
  setTyping: (typing: boolean) => void;
}

/** A ticket route that 404s predates session presence: stop like a refusal. */
async function sessionTicket(): Promise<string> {
  try {
    return await api.fetchRealtimeTicket();
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) {
      throw Object.assign(new Error("Session presence is not supported"), { status: 403 });
    }
    throw error;
  }
}

export function useSessionPresence(rootTaskId: string | undefined, enabled: boolean) {
  const { userId, user } = useCurrentUser();
  const who = useMemo<PresenceWho | null>(
    () => (userId ? { id: userId, name: user?.name || userId.slice(0, 8) } : null),
    [userId, user?.name],
  );
  const namespace = enabled && rootTaskId ? sessionPresenceNamespace(rootTaskId) : null;

  const [peers, setPeers] = useState<ParsedSessionPeer[]>([]);
  const clientRef = useRef<PresenceClient | null>(null);
  const state = useRef({ who, typing: false, lastSent: 0 });
  state.current.who = who;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { who: self, typing } = state.current;
    const client = clientRef.current;
    if (!self || !client) return;
    state.current.lastSent = Date.now();
    const data: SessionPresenceData = { v: 1, who: self, typing, t: Date.now() };
    client.publish(data);
  }, []);

  const setTyping = useCallback(
    (typing: boolean) => {
      if (state.current.typing === typing) return;
      state.current.typing = typing;
      if (timer.current) return;
      const wait = state.current.lastSent + TYPING_THROTTLE_MS - Date.now();
      if (wait <= 0) publishNow();
      else timer.current = setTimeout(publishNow, wait);
    },
    [publishNow],
  );

  useEffect(() => {
    if (!namespace) return;
    const client = new PresenceClient({
      namespace,
      getTicket: sessionTicket,
      socketUrl: (ticket) => api.realtimeSocketUrl(ticket),
      onPeers: (raw) =>
        setPeers(
          raw.flatMap((entry) => {
            const peer = parseSessionPeer(entry);
            return peer ? [peer] : [];
          }),
        ),
    });
    clientRef.current = client;
    client.start();
    publishNow();

    const onPageHide = () => client.stop();
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      client.start();
      publishNow();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    // The heartbeat keeps this tab's avatar alive on other screens.
    const heartbeat = setInterval(publishNow, SESSION_HEARTBEAT_MS);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      clearInterval(heartbeat);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      state.current.typing = false;
      client.stop();
      clientRef.current = null;
      setPeers([]);
    };
  }, [namespace, publishNow]);

  // A new name (users loaded) goes out at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: publish when the identity changes
  useEffect(() => {
    publishNow();
  }, [who, publishNow]);

  const viewers = useMemo(() => sessionViewers(peers, who?.id), [peers, who?.id]);
  return useMemo<SessionPresence>(() => ({ viewers, setTyping }), [viewers, setTyping]);
}
