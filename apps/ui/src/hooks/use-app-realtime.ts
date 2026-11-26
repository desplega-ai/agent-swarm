/**
 * App realtime: one socket per open app page. It joins the page's presence
 * room (`presence:app:<appId>:<page>`) and subscribes to the app's event
 * channel (`app:<appId>`, `rows`). A `rows` event means rows of a model
 * changed on the server; the surface refetches the queries over it at once.
 *
 * The server checks `app.use` for both. A refused ticket or join (no access,
 * an older server) stops the client silently: polling still refreshes data.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import { useOptionalCurrentUser } from "@/contexts/current-user-context";
import type { PresenceWho } from "@/lib/comb/presence";
import { PresenceClient } from "@/lib/comb/presence-client";
import {
  type ParsedSessionPeer,
  parseSessionPeer,
  SESSION_HEARTBEAT_MS,
  SESSION_PRESENCE_VERSION,
  type SessionViewer,
  sessionViewers,
} from "@/lib/session-presence";

export function appPresenceNamespace(appId: string, page: string): string {
  return `presence:app:${appId}:${page}`;
}

export function appChannelNamespace(appId: string): string {
  return `app:${appId}`;
}

/** A ticket route that 404s predates app realtime: stop like a refusal. */
async function appTicket(): Promise<string> {
  try {
    return await api.fetchRealtimeTicket();
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) {
      throw Object.assign(new Error("App realtime is not supported"), { status: 403 });
    }
    throw error;
  }
}

/** `/presence/peers` entries: the other people on this app page. */
export type AppPresencePeer = Pick<SessionViewer, "id" | "name" | "avatar">;

export function useAppRealtime({
  appId,
  page,
  onRowsChanged,
}: {
  appId: string;
  page: string;
  onRowsChanged: (model: string) => void;
}): { peers: AppPresencePeer[] } {
  const current = useOptionalCurrentUser();
  const userId = current?.userId ?? null;
  const user = current?.user;
  const who = useMemo<PresenceWho | null>(
    () => (userId ? { id: userId, name: user?.name || userId.slice(0, 8) } : null),
    [userId, user?.name],
  );
  const whoRef = useRef(who);
  whoRef.current = who;
  const onRowsRef = useRef(onRowsChanged);
  onRowsRef.current = onRowsChanged;
  const clientRef = useRef<PresenceClient | null>(null);
  const [raw, setRaw] = useState<ParsedSessionPeer[]>([]);

  useEffect(() => {
    if (!appId || !page) return;
    const publish = () => {
      const self = whoRef.current;
      if (self)
        clientRef.current?.publish({
          v: SESSION_PRESENCE_VERSION,
          who: self,
          typing: false,
          t: Date.now(),
        });
    };
    const client = new PresenceClient({
      namespace: appPresenceNamespace(appId, page),
      getTicket: appTicket,
      socketUrl: (ticket) => api.realtimeSocketUrl(ticket),
      channels: [{ namespace: appChannelNamespace(appId), name: "rows" }],
      onChannel: (_channel, data) => {
        const model = (data as { model?: unknown } | null)?.model;
        if (typeof model === "string" && model !== "") onRowsRef.current(model);
      },
      onPeers: (peers) =>
        setRaw(
          peers.flatMap((entry) => {
            const peer = parseSessionPeer(entry);
            return peer ? [peer] : [];
          }),
        ),
    });
    clientRef.current = client;
    client.start();
    publish();
    const heartbeat = setInterval(publish, SESSION_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      client.stop();
      clientRef.current = null;
      setRaw([]);
    };
  }, [appId, page]);

  // A name that loads later goes out at once.
  useEffect(() => {
    if (who)
      clientRef.current?.publish({
        v: SESSION_PRESENCE_VERSION,
        who,
        typing: false,
        t: Date.now(),
      });
  }, [who]);

  const peers = useMemo(
    () => sessionViewers(raw, who?.id).map(({ id, name, avatar }) => ({ id, name, avatar })),
    [raw, who?.id],
  );
  return { peers };
}
