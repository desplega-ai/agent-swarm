import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { removeAwarenessStates } from "y-protocols/awareness";
import { z } from "zod";
import { getPage } from "../be/db";
import { findUserById } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { getApiKey } from "../utils/api-key";
import { extractAndVerifyCookie } from "../utils/page-session";
import { scrubSecrets } from "../utils/secret-scrubber";
import { authorizeRoomNamespace, resolveRoomNamespace } from "./auth";
import { realtimeBus } from "./bus";
import { RoomOperationSchema } from "./document";
import {
  applyRoomUpdate,
  changeRoom,
  getRoom,
  type LiveRoom,
  resetRoom,
  roomTopic,
  roomView,
} from "./rooms";

const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const messageSchema = z.object({
  id: z.number().int().nonnegative(),
  op: z.enum([
    "join",
    "leave",
    "update",
    "change",
    "reset",
    "presence",
    "subscribe",
    "unsubscribe",
    "publish",
  ]),
  name: nameSchema.default("default"),
  namespace: z.string().max(512).optional(),
  schemaVersion: z.number().int().positive().default(1),
  generation: z.string().max(100).optional(),
  snapshot: z
    .string()
    .max(2 * 1024 * 1024)
    .optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  data: z.unknown().optional(),
  operations: z.array(RoomOperationSchema).max(1000).optional(),
});

type Identity = {
  agentId?: string;
  sourceTaskId?: string;
  pageId?: string;
  userId?: string;
  isOperator?: boolean;
};
type Viewer = { userId: string; name: string; kind: "user" | "guest" | "agent" };

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function authenticate(req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pageId = url.searchParams.get("pageId");
  if (pageId) {
    // Browser credentials must never authorize cross-origin socket requests.
    const origin = header(req, "origin");
    if (!origin || new URL(origin).host !== header(req, "host"))
      throw new Error("Invalid page origin");
    const page = await getPage(pageId);
    if (!page) throw new Error("Page not found");
    const cookie = await extractAndVerifyCookie(req);
    const session = cookie?.pageId === pageId ? cookie : null;
    if (!session && page.authMode !== "public") throw new Error("Page session required");
    if (session?.uid && (await findUserById(session.uid))?.status !== "active")
      throw new Error("Viewer is inactive");
    const guestId = `guest-${crypto.randomUUID()}`;
    return {
      identity: { pageId, userId: session?.uid } satisfies Identity,
      me: {
        userId: session?.uid ?? guestId,
        name: session?.name ?? `Guest ${guestId.slice(-6)}`,
        kind: session?.uid ? "user" : "guest",
      } as Viewer,
      expiresAt: session ? session.exp * 1000 : undefined,
    };
  }
  const auth = await resolveHttpRequestAuth(req, getApiKey());
  if (!auth) throw new Error("Authentication required");
  const agentId = auth.kind === "operator" ? header(req, "x-agent-id") : undefined;
  const guestId = `guest-${crypto.randomUUID()}`;
  return {
    identity: {
      agentId,
      sourceTaskId: header(req, "x-source-task-id"),
      userId: auth.kind === "user" ? auth.userId : undefined,
      isOperator: auth.kind === "operator",
    } satisfies Identity,
    me: {
      userId: auth.kind === "user" ? auth.userId : (agentId ?? guestId),
      name: auth.kind === "user" ? auth.user.name : (agentId ?? `Guest ${guestId.slice(-6)}`),
      kind: auth.kind === "user" ? "user" : agentId ? "agent" : "guest",
    } as Viewer,
    expiresAt: undefined,
  };
}

function channelTopic(namespace: string, name: string): string {
  return `channel:${JSON.stringify([namespace, name])}`;
}

export function attachRealtimeTransport(server: Server): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
  let pendingUpgrades = 0;
  let closing = false;
  // The dedicated path bypasses HTTP proxying. Authentication precedes upgrade.
  const onUpgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    if (
      closing ||
      req.url?.split("?")[0] !== "/@swarm/realtime" ||
      wss.clients.size + pendingUpgrades >= 1000
    ) {
      socket.destroy();
      return;
    }
    const rejectUpgrade = (_error: unknown) => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    };
    pendingUpgrades++;
    void authenticate(req)
      .then((auth) => {
        if (closing || socket.destroyed) {
          socket.destroy();
          return;
        }
        return wss.handleUpgrade(req, socket, head, (ws) => connect(ws, auth));
      }, rejectUpgrade)
      .catch(rejectUpgrade)
      .finally(() => {
        pendingUpgrades--;
      });
  };
  server.on("upgrade", onUpgrade);
  return () => {
    closing = true;
    server.off("upgrade", onUpgrade);
    for (const client of wss.clients) {
      client.close(1001, "Server shutdown");
      setTimeout(() => client.terminate(), 500).unref();
    }
    wss.close();
  };
}

function connect(ws: WebSocket, auth: Awaited<ReturnType<typeof authenticate>>): void {
  const rooms = new Map<string, { room: LiveRoom; version: number; stop: () => void }>();
  const channels = new Map<string, () => void>();
  const pending = new Map<number, number>();
  const clientId = crypto.getRandomValues(new Uint32Array(1))[0]!;
  let seq = 0;
  let pendingBytes = 0;
  let queue = Promise.resolve();
  let queuedMessages = 0;
  let alive = true;
  let closed = false;

  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const frame = JSON.stringify({ ...payload, seq: ++seq });
    const bytes = Buffer.byteLength(frame);
    if (pending.size >= 128 || pendingBytes + bytes > 8 * 1024 * 1024) {
      ws.close(1013, "Client must resync");
      return;
    }
    pending.set(seq, bytes);
    pendingBytes += bytes;
    ws.send(frame);
  };
  const publishPresence = (room: LiveRoom) => {
    realtimeBus.publish(`presence:${roomTopic(room.namespace, room.name)}`, [
      ...room.awareness.getStates().values(),
    ]);
  };
  const leave = (key: string) => {
    const joined = rooms.get(key);
    if (!joined) return;
    joined.stop();
    removeAwarenessStates(joined.room.awareness, [clientId], "disconnect");
    publishPresence(joined.room);
    joined.room.lastActivity = Date.now();
    rooms.delete(key);
  };
  const checkSession = async () => {
    if (auth.expiresAt && Date.now() >= auth.expiresAt) throw new Error("Page session expired");
    if (auth.identity.pageId && !(await getPage(auth.identity.pageId)))
      throw new Error("Page no longer exists");
    if (auth.identity.userId && (await findUserById(auth.identity.userId))?.status !== "active")
      throw new Error("Viewer is inactive");
  };

  const handle = async (raw: string) => {
    if (closed) return;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.ack === "number") {
      const bytes = pending.get(value.ack);
      if (bytes !== undefined) {
        pendingBytes -= bytes;
        pending.delete(value.ack);
      }
      return;
    }
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success) {
      send({
        ...(Number.isSafeInteger(value.id) && Number(value.id) >= 0 ? { id: value.id } : {}),
        type: "error",
        error: "Invalid realtime message",
      });
      return;
    }
    const msg = parsed.data;
    try {
      await checkSession();
      const resolved = await resolveRoomNamespace(msg.namespace, auth.identity);
      if ("error" in resolved) throw new Error(resolved.error);
      const namespace = resolved.namespace;
      const write = ["update", "change", "reset", "presence", "publish"].includes(msg.op);
      const denied = await authorizeRoomNamespace(namespace, auth.identity, write);
      if (denied) throw new Error(typeof denied === "string" ? denied : "Forbidden");
      if (closed) return;
      const key = roomTopic(namespace, msg.name);
      if (msg.op === "subscribe") {
        const topic = channelTopic(namespace, msg.name);
        if (!channels.has(topic)) {
          if (channels.size >= 100) throw new Error("Channel limit exceeded");
          channels.set(
            topic,
            realtimeBus.subscribe(topic, (data) =>
              send({ type: "channel", name: msg.name, namespace, data }),
            ),
          );
        }
      } else if (msg.op === "unsubscribe") {
        const topic = channelTopic(namespace, msg.name);
        channels.get(topic)?.();
        channels.delete(topic);
      } else if (msg.op === "publish") {
        if (Buffer.byteLength(JSON.stringify(msg.data) ?? "null") > 64 * 1024)
          throw new Error("Channel payload exceeds 64 KiB");
        realtimeBus.publish(channelTopic(namespace, msg.name), msg.data);
      } else if (msg.op === "leave") {
        leave(key);
      } else if (msg.op === "join") {
        if (!rooms.has(key)) {
          if (rooms.size >= 100) throw new Error("Room subscription limit exceeded");
          let room: LiveRoom;
          try {
            room = await getRoom(namespace, msg.name, msg.schemaVersion, { create: false });
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "room does not exist") throw error;
            const creationDenied = await authorizeRoomNamespace(namespace, auth.identity, true);
            if (creationDenied) throw new Error(creationDenied);
            if (closed) return;
            room = await getRoom(namespace, msg.name, msg.schemaVersion);
          }
          if (closed) return;
          const stopRoom = realtimeBus.subscribe(key, (event) => {
            const view = event as ReturnType<typeof roomView> & { type: string };
            const type = view.type;
            if (type === "deleted") {
              send({ type: "deleted", name: msg.name, namespace });
              leave(key);
              return;
            }
            send({ ...view, type: "room", stale: view.schemaVersion !== msg.schemaVersion });
            if (type === "reset") {
              const data = rooms.get(key)?.room.awareness.getStates().get(clientId)?.data ?? {};
              void getRoom(namespace, msg.name, msg.schemaVersion)
                .then((current) => {
                  const joined = rooms.get(key);
                  if (!joined || closed) return;
                  joined.room = current;
                  current.awareness.states.set(clientId, { ...auth.me, data });
                  current.awareness.meta.set(clientId, { clock: 1, lastUpdated: Date.now() });
                  publishPresence(current);
                })
                .catch(() => ws.close(1011, "Room reset failed"));
            }
          });
          const stopPresence = realtimeBus.subscribe(`presence:${key}`, (peers) =>
            send({ type: "presence", name: msg.name, namespace, peers }),
          );
          rooms.set(key, {
            room,
            version: msg.schemaVersion,
            stop: () => {
              stopRoom();
              stopPresence();
            },
          });
          room.awareness.states.set(clientId, { ...auth.me, data: {} });
          room.awareness.meta.set(clientId, { clock: 1, lastUpdated: Date.now() });
          publishPresence(room);
        }
        const room = rooms.get(key)!.room;
        send({
          id: msg.id,
          type: "result",
          me: auth.me,
          room: roomView(room, msg.schemaVersion),
          peers: [...room.awareness.getStates().values()],
        });
        return;
      } else {
        const joined = rooms.get(key);
        if (!joined) throw new Error("Join the room first");
        const room = await getRoom(namespace, msg.name, joined.version);
        joined.room = room;
        if (msg.op === "update") {
          if (
            !msg.snapshot ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(msg.snapshot)
          )
            throw new Error("Invalid CRDT update");
          await applyRoomUpdate(
            room,
            Buffer.from(msg.snapshot, "base64"),
            msg.generation ?? "",
            joined.version,
          );
        } else if (msg.op === "change") {
          if (msg.generation !== room.generation)
            throw new Error("Room generation changed. Join again.");
          await changeRoom(namespace, msg.name, msg.operations ?? [], joined.version);
        } else if (msg.op === "reset") {
          await resetRoom(namespace, msg.name, msg.state ?? {}, msg.schemaVersion);
          joined.room = await getRoom(namespace, msg.name, msg.schemaVersion);
        } else if (msg.op === "presence") {
          if (Buffer.byteLength(JSON.stringify(msg.data) ?? "null") > 8192)
            throw new Error("Presence exceeds 8 KiB");
          room.awareness.states.set(clientId, { ...auth.me, data: msg.data ?? {} });
          room.awareness.meta.set(clientId, {
            clock: (room.awareness.meta.get(clientId)?.clock ?? 0) + 1,
            lastUpdated: Date.now(),
          });
          publishPresence(room);
          room.lastActivity = Date.now();
          send({ id: msg.id, type: "result" });
          return;
        }
        room.lastActivity = Date.now();
        send({ id: msg.id, type: "result", room: roomView(joined.room, joined.version) });
        return;
      }
      send({ id: msg.id, type: "result" });
    } catch (error) {
      send({
        id: msg.id,
        type: "error",
        error: scrubSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
  };

  ws.on("message", (data) => {
    if (++queuedMessages > 128) {
      ws.close(1013, "Too many pending messages");
      return;
    }
    queue = queue
      .then(() => handle(data.toString()))
      .catch(() => send({ type: "error", error: "Invalid realtime message" }))
      .finally(() => {
        queuedMessages--;
      });
  });
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("error", () => ws.close(1011, "Connection failed"));
  const timer = setInterval(() => {
    if (!alive || (auth.expiresAt && Date.now() >= auth.expiresAt)) {
      ws.close(1008, "Session expired or peer unavailable");
      return;
    }
    alive = false;
    ws.ping();
    void checkSession().catch(() => ws.close(1008, "Session no longer valid"));
    for (const { room } of rooms.values()) {
      const meta = room.awareness.meta.get(clientId);
      if (meta) meta.lastUpdated = Date.now();
    }
  }, 15_000);
  timer.unref();
  ws.on("close", () => {
    closed = true;
    clearInterval(timer);
    for (const key of rooms.keys()) leave(key);
    for (const stop of channels.values()) stop();
    channels.clear();
  });
  send({ type: "hello", me: auth.me });
}
