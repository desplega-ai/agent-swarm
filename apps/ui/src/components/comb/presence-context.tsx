import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/api/client";
import { useDriveMembers } from "@/api/hooks/use-agent-fs";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useConfig } from "@/hooks/use-config";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import { browserStorage } from "@/lib/comb/drafts";
import {
  fitPresence,
  HEARTBEAT_MS,
  mergePeers,
  nextExpiry,
  type ParsedPeer,
  type PeerState,
  type PresenceData,
  type PresenceFile,
  type PresencePeer,
  type PresencePointer,
  type PresenceSelection,
  type PresenceWho,
  parsePeer,
  presenceNamespace,
  readShowCursors,
  SHOW_CURSORS_KEY,
  samePointer,
  sameSelection,
  visiblePeers,
  writeShowCursors,
} from "@/lib/comb/presence";
import { PresenceClient } from "@/lib/comb/presence-client";
import { useCombServiceUserId } from "./use-comb-service-user";

/** What this tab shows: the file, and (with cursors on) the selection and the pointer. */
export interface LocalPresence {
  file: PresenceFile | null;
  sel: PresenceSelection | null;
  ptr: PresencePointer | null;
}

/** A person in the drive, without the fast-moving pointer (avatars, tree dots). */
export interface RosterPeer {
  id: string;
  name: string;
  avatar?: string;
  color: number;
  file: PresenceFile | null;
  selecting: boolean;
}

interface PresenceControl {
  showCursors: boolean;
  setShowCursors: (show: boolean) => void;
  /** Merge a change of this tab's presence. Publishing is throttled. */
  setLocal: (change: Partial<LocalPresence>) => void;
}

const ControlContext = createContext<PresenceControl | null>(null);
const RosterContext = createContext<readonly RosterPeer[]>([]);
const PeersContext = createContext<readonly PresencePeer[]>([]);

/** "Show cursors" and this tab's presence, or null outside a Comb drive. */
export function usePresenceControl(): PresenceControl | null {
  return useContext(ControlContext);
}

/** Everyone else in the drive. Changes only when someone arrives, leaves, or switches file. */
export function usePresenceRoster(): readonly RosterPeer[] {
  return useContext(RosterContext);
}

/** Everyone else in the drive with their selections and pointers. Changes on every move. */
export function usePresencePeers(): readonly PresencePeer[] {
  return useContext(PeersContext);
}

/** At most one presence message per this interval (pointer moves come faster). */
const PUBLISH_INTERVAL_MS = 80;
const NO_PEERS: readonly PresencePeer[] = [];

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * One presence connection per drive and tab (key it by the drive). It
 * publishes who this tab is and what it shows, and keeps everyone else's
 * latest state. A hidden tab clears its file, selection, and pointer, and
 * `pagehide` closes the socket, so the server drops this tab at once.
 */
export function CombPresenceProvider({
  orgId,
  driveId,
  children,
}: {
  orgId: string;
  driveId: string;
  children: ReactNode;
}) {
  const { me } = useAgentFs();
  const { apiUrl } = useConfig().config;
  const members = useDriveMembers({ orgId, driveId }).data?.members;
  const serviceUserId = useCombServiceUserId();
  const namespace = presenceNamespace(orgId, driveId);

  const [showCursors, setShowCursorsState] = useState(() =>
    readShowCursors(browserStorage(), apiUrl),
  );
  const [states, setStates] = useState<ReadonlyMap<string, PeerState>>(new Map());
  // Bumped when a pointer, a selection, or a peer expires.
  const [expiryTick, setExpiryTick] = useState(0);

  // Who this tab is. A drive member's own name beats the account's email.
  const who = useMemo<PresenceWho | null>(() => {
    if (!me) return null;
    const member = members?.find((m) => m.userId === me.userId);
    return {
      id: me.userId,
      name: me.displayName || member?.displayName || me.email || me.userId.slice(0, 8),
    };
  }, [me, members]);

  const clientRef = useRef<PresenceClient | null>(null);
  const local = useRef<LocalPresence>({ file: null, sel: null, ptr: null });
  const state = useRef({ who, showCursors, lastSent: 0, lastData: "" });
  state.current.who = who;
  state.current.showCursors = showCursors;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Publish now. `force` sends even when nothing changed (the heartbeat).
  const publishNow = useCallback((force = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { who: self, showCursors: cursors } = state.current;
    const client = clientRef.current;
    if (!self || !client) return;
    const hidden = isHidden();
    const { file, sel, ptr } = local.current;
    const data: PresenceData = {
      v: 1,
      who: self,
      file: hidden ? null : file,
      sel: hidden || !cursors ? null : sel,
      ptr: hidden || !cursors ? null : ptr,
      t: Date.now(),
    };
    const key = JSON.stringify({ ...data, t: 0 });
    if (!force && key === state.current.lastData) return;
    state.current.lastData = key;
    state.current.lastSent = Date.now();
    client.publish(fitPresence(data));
  }, []);

  // Pointer moves arrive often: send the first at once, then the latest one
  // per interval.
  const schedulePublish = useCallback(() => {
    if (timer.current) return;
    const wait = state.current.lastSent + PUBLISH_INTERVAL_MS - Date.now();
    if (wait <= 0) publishNow();
    else timer.current = setTimeout(() => publishNow(), wait);
  }, [publishNow]);

  const setLocal = useCallback(
    (change: Partial<LocalPresence>) => {
      const current = local.current;
      const next = { ...current, ...change };
      if (
        next.file?.path === current.file?.path &&
        next.file?.version === current.file?.version &&
        sameSelection(next.sel, current.sel) &&
        samePointer(next.ptr, current.ptr)
      ) {
        return;
      }
      local.current = next;
      // A new file goes out at once. Selections and pointers are throttled.
      if (next.file?.path !== current.file?.path) publishNow();
      else schedulePublish();
    },
    [publishNow, schedulePublish],
  );

  // The socket: one per drive, closed on unmount and on `pagehide`.
  useEffect(() => {
    if (!namespace) return;
    const client = new PresenceClient({
      namespace,
      getTicket: () => api.fetchRealtimeTicket(),
      socketUrl: (ticket) => api.realtimeSocketUrl(ticket),
      onPeers: (raw) => {
        // This tab's own echo (and my other tabs) never shows.
        const selfId = state.current.who?.id;
        const parsed = raw.flatMap((entry) => {
          const peer = parsePeer(entry);
          return peer && peer.data.who.id !== selfId ? [peer] : [];
        });
        setStates((previous) => mergePeersIfChanged(previous, parsed));
      },
    });
    clientRef.current = client;
    client.start();
    // The first join publishes the latest data. Queue it now.
    state.current.lastData = "";
    publishNow(true);

    const onPageHide = () => client.stop();
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      client.start();
      state.current.lastData = "";
      publishNow(true);
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      client.stop();
      clientRef.current = null;
      setStates(new Map());
    };
  }, [namespace, publishNow]);

  // A hidden tab is not on any file. Coming back shows it again.
  useEffect(() => {
    const onVisibility = () => publishNow();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [publishNow]);

  // The heartbeat keeps this tab's avatar and selection alive on other screens.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!isHidden()) publishNow(true);
    }, HEARTBEAT_MS);
    return () => clearInterval(interval);
  }, [publishNow]);

  // A new name (members loaded) or a cursors switch goes out at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: publish when these change
  useEffect(() => {
    publishNow();
  }, [who, showCursors, publishNow]);

  // Wake up when the next pointer, selection, or peer expires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: after one expiry, schedule the next
  useEffect(() => {
    const at = nextExpiry(states.values(), Date.now());
    if (at === null) return;
    const wait = Math.max(0, at - Date.now());
    const expiry = setTimeout(() => setExpiryTick((n) => n + 1), wait);
    return () => clearTimeout(expiry);
  }, [states, expiryTick]);

  // "Show cursors" is one choice for every tab of this swarm.
  useEffect(() => {
    const key = deriveStorageKey(apiUrl, SHOW_CURSORS_KEY);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) setShowCursorsState(readShowCursors(browserStorage(), apiUrl));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [apiUrl]);

  const setShowCursors = useCallback(
    (show: boolean) => {
      setShowCursorsState(show);
      writeShowCursors(browserStorage(), apiUrl, show);
    },
    [apiUrl],
  );

  const exclude = useMemo(() => {
    const ids = new Set<string>();
    if (me) ids.add(me.userId);
    if (serviceUserId) ids.add(serviceUserId);
    return ids;
  }, [me, serviceUserId]);

  const label = useCallback(
    (id: string, name: string) => {
      const member = members?.find((m) => m.userId === id);
      return member?.displayName || member?.email || name;
    },
    [members],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `expiryTick` re-reads the clock
  const peers = useMemo(
    () => (states.size ? visiblePeers(states.values(), Date.now(), exclude, label) : NO_PEERS),
    [states, expiryTick, exclude, label],
  );

  // The roster keeps its identity until someone arrives, leaves, switches
  // file, or starts or stops selecting, so the tree and the header do not
  // re-render on every pointer move.
  const rosterKey = peers
    .map((p) =>
      [
        p.id,
        p.name,
        p.avatar ?? "",
        p.color,
        p.file?.path ?? "",
        p.file?.version ?? 0,
        !!p.sel,
      ].join("\u0001"),
    )
    .join("\u0002");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rosterKey` holds every field read here
  const roster = useMemo<readonly RosterPeer[]>(
    () =>
      peers.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.avatar ? { avatar: p.avatar } : {}),
        color: p.color,
        file: p.file,
        selecting: p.sel !== null,
      })),
    [rosterKey],
  );

  const control = useMemo<PresenceControl>(
    () => ({ showCursors, setShowCursors, setLocal }),
    [showCursors, setShowCursors, setLocal],
  );

  return (
    <ControlContext.Provider value={control}>
      <RosterContext.Provider value={roster}>
        <PeersContext.Provider value={peers}>{children}</PeersContext.Provider>
      </RosterContext.Provider>
    </ControlContext.Provider>
  );
}

function mergePeersIfChanged(
  previous: ReadonlyMap<string, PeerState>,
  parsed: readonly ParsedPeer[],
): ReadonlyMap<string, PeerState> {
  const next = mergePeers(previous, parsed, Date.now());
  // A frame that changes nobody (another tab's echo) keeps the old map.
  if (next.size === previous.size && [...next].every(([k, v]) => previous.get(k) === v)) {
    return previous;
  }
  return next;
}
