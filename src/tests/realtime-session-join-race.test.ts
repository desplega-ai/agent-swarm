import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { closeDb, createTaskExtended, createUser, initDb } from "../be/db";
import { setSessionShares } from "../be/session-shares";
import { mintToken } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { closeRooms, flushRooms, getRoom, sweepRooms } from "../realtime/rooms";
import { issueRealtimeTicket } from "../realtime/tickets";
import { attachRealtimeTransport } from "../realtime/transport";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

type Frame = Record<string, any>;
type User = Awaited<ReturnType<typeof createUser>>;

let server: Server;
let detach: () => void;
let port: number;

beforeAll(async () => {
  initDb(":memory:");
  server = createServer(async (req, res) => {
    beginRequestAuthScope();
    const auth = await resolveHttpRequestAuth(req, undefined);
    if (!auth) {
      res.writeHead(401);
      res.end();
      return;
    }
    setRequestAuth(req, auth);
    const url = req.url ?? "/";
    if (await handleSessions(req, res, getPathSegments(url), parseQueryParams(url), undefined))
      return;
    res.writeHead(404);
    res.end();
  });
  detach = attachRealtimeTransport(server);
  port = await listenOnFreePort(server, "127.0.0.1");
});

afterAll(async () => {
  detach();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRooms();
  closeDb();
});

async function openSocket(user: User) {
  const { ticket } = issueRealtimeTicket({ kind: "user", userId: user.id, user: user as never });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?ticket=${ticket}`);
  const frames: Frame[] = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    frames.push(frame);
    if (frame.seq) ws.send(JSON.stringify({ ack: frame.seq }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = async (match: (frame: Frame) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const index = frames.findIndex(match);
      if (index >= 0) return frames.splice(index, 1)[0]!;
      await Bun.sleep(5);
    }
    throw new Error(`No matching frame. Buffered: ${JSON.stringify(frames)}`);
  };
  return { ws, frames, next, send: (message: Frame) => ws.send(JSON.stringify(message)) };
}

test("a revoke that lands while a session presence join loads its room rejects the join", async () => {
  const owner = await createUser({ name: "Race Owner" });
  const viewer = await createUser({ name: "Race Viewer" });
  const ownerToken = await mintToken(owner.id, "test", { kind: "system", id: "test" });
  const root = await createTaskExtended("Private incident", {
    requestedByUserId: owner.id,
    source: "ui",
  });
  await setSessionShares(
    { id: root.id, requestedByUserId: owner.id },
    { everyone: "read", users: [] },
    owner.id,
  );
  const namespace = `presence:session:${root.id}`;

  // Persist the room, then idle-evict it, so the next join reloads it
  // through the room creation queue.
  const room = await getRoom(namespace, "default");
  await flushRooms();
  room.lastActivity = 0;
  await sweepRooms(Date.now());

  const state = (globalThis as { __swarmRoomsState?: { creationChain: Promise<void> } })
    .__swarmRoomsState!;
  let release!: () => void;
  state.creationChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  const viewerSocket = await openSocket(viewer);
  const ownerSocket = await openSocket(owner);
  try {
    await viewerSocket.next((frame) => frame.type === "hello");
    await ownerSocket.next((frame) => frame.type === "hello");
    viewerSocket.send({ id: 1, op: "join", name: "default", namespace, schemaVersion: 1 });
    const pending = (globalThis as { __swarmRoomsState?: { pending: Map<string, unknown> } })
      .__swarmRoomsState!.pending;
    for (let i = 0; i < 400 && pending.size === 0; i++) await Bun.sleep(5);
    expect(pending.size).toBeGreaterThan(0);

    const revoked = await fetch(`http://127.0.0.1:${port}/api/sessions/${root.id}/shares`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerToken.plaintext}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ everyone: "none", users: [] }),
    });
    expect(revoked.status).toBe(200);
    release();

    const joined = await viewerSocket.next((frame) => frame.id === 1);
    expect(joined.type).toBe("error");
    expect(joined.error).toContain("access");

    ownerSocket.send({ id: 2, op: "join", name: "default", namespace, schemaVersion: 1 });
    expect((await ownerSocket.next((frame) => frame.id === 2)).type).toBe("result");
    viewerSocket.frames.splice(0);
    ownerSocket.send({ id: 3, op: "presence", namespace, data: { typing: true } });
    await ownerSocket.next((frame) => frame.type === "result" && frame.id === 3);
    await Bun.sleep(100);
    expect(viewerSocket.frames.filter((frame) => frame.type === "presence")).toEqual([]);
  } finally {
    release();
    viewerSocket.ws.close();
    ownerSocket.ws.close();
  }
});
