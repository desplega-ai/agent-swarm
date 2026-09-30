import { describe, expect, test } from "bun:test";
import { PresenceClient, type PresenceSocket, type PresenceStatus } from "./presence-client";

const NAMESPACE = "presence:comb:org:drive";

class FakeSocket implements PresenceSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code ?? 1000;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(value: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  requests(op: string) {
    return this.sent.filter((m) => m.op === op);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(getTicket: () => Promise<string> = async () => `t${Math.random()}`) {
  const sockets: FakeSocket[] = [];
  const peers: (readonly unknown[])[] = [];
  const statuses: PresenceStatus[] = [];
  const client = new PresenceClient({
    namespace: NAMESPACE,
    getTicket,
    socketUrl: (ticket) => `ws://api/api/realtime?ticket=${ticket}`,
    onPeers: (list) => peers.push(list),
    onStatus: (status) => statuses.push(status),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    retryDelay: () => 0,
  });
  return { client, sockets, peers, statuses };
}

/** Open the socket and answer the join. */
async function joined(socket: FakeSocket, peers: unknown[] = []) {
  if (socket.readyState !== 1) socket.open();
  const [join] = socket.requests("join");
  socket.frame({ id: join.id, type: "result", seq: 1, peers });
  return join;
}

describe("PresenceClient", () => {
  test("joins the drive room, acks every frame, and reports peers", async () => {
    const { client, sockets, peers, statuses } = setup(async () => "ticket-1");
    client.start();
    await tick();
    const socket = sockets[0];
    expect(socket.url).toBe("ws://api/api/realtime?ticket=ticket-1");
    socket.open();
    socket.frame({ type: "hello", seq: 1, me: { userId: "guest-1" } });
    const [join] = socket.requests("join");
    expect(join).toMatchObject({
      op: "join",
      name: "default",
      namespace: NAMESPACE,
      schemaVersion: 1,
    });
    socket.frame({ id: join.id, type: "result", seq: 2, peers: [{ userId: "a" }] });
    socket.frame({ type: "presence", namespace: NAMESPACE, seq: 3, peers: [{ userId: "b" }] });
    // Another namespace is not this room.
    socket.frame({ type: "presence", namespace: "presence:comb:x:y", seq: 4, peers: [] });
    expect(socket.sent.filter((m) => "ack" in m).map((m) => m.ack)).toEqual([1, 2, 3, 4]);
    expect(peers).toEqual([[{ userId: "a" }], [{ userId: "b" }]]);
    expect(statuses).toEqual(["connecting", "open"]);
    client.stop();
  });

  test("publishes the latest presence once joined, and each time after", async () => {
    const { client, sockets } = setup();
    client.publish({ n: 1 });
    client.start();
    client.publish({ n: 2 });
    await tick();
    const socket = sockets[0];
    socket.open();
    expect(socket.requests("presence")).toEqual([]);
    await joined(socket);
    client.publish({ n: 3 });
    expect(socket.requests("presence").map((m) => m.data)).toEqual([{ n: 2 }, { n: 3 }]);
    expect(socket.requests("presence")[0]).toMatchObject({ name: "default", namespace: NAMESPACE });
    client.stop();
  });

  test("reconnects with a fresh ticket, joins again, and publishes again", async () => {
    const tickets: string[] = [];
    const { client, sockets, peers, statuses } = setup(async () => {
      tickets.push(`t${tickets.length + 1}`);
      return tickets[tickets.length - 1];
    });
    client.start();
    await tick();
    await joined(sockets[0], [{ userId: "a" }]);
    client.publish({ file: "/a.md" });
    sockets[0].drop();
    // Peers are unknown until the next join.
    expect(peers.at(-1)).toEqual([]);
    expect(statuses).toContain("reconnecting");
    await tick();
    await tick();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toEndWith("ticket=t2");
    await joined(sockets[1]);
    expect(sockets[1].requests("presence").map((m) => m.data)).toEqual([{ file: "/a.md" }]);
    expect(statuses.at(-1)).toBe("open");
    client.stop();
  });

  test("retries when the ticket request fails, stops when it is refused", async () => {
    let calls = 0;
    const flaky = setup(async () => {
      calls++;
      if (calls === 1) throw new Error("network");
      return "t";
    });
    flaky.client.start();
    await tick();
    await tick();
    await tick();
    expect(flaky.sockets).toHaveLength(1);
    flaky.client.stop();

    const refused = setup(async () => {
      throw Object.assign(new Error("403"), { status: 403 });
    });
    refused.client.start();
    await tick();
    await tick();
    expect(refused.sockets).toHaveLength(0);
    expect(refused.statuses.at(-1)).toBe("denied");
    // A denied client stays down.
    refused.client.start();
    await tick();
    expect(refused.sockets).toHaveLength(0);
  });

  test("a refused join closes the socket without retrying", async () => {
    const { client, sockets, statuses } = setup();
    client.start();
    await tick();
    sockets[0].open();
    const [join] = sockets[0].requests("join");
    sockets[0].frame({
      id: join.id,
      type: "error",
      seq: 1,
      error: "Comb presence requires dashboard authentication",
    });
    expect(sockets[0].closed).toBe(1000);
    expect(statuses.at(-1)).toBe("denied");
    await tick();
    expect(sockets).toHaveLength(1);
  });

  test("stop closes the socket, clears peers, and a ticket that arrives later is dropped", async () => {
    let release: (ticket: string) => void = () => {};
    const { client, sockets, peers } = setup(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    client.start();
    client.stop();
    release("late");
    await tick();
    expect(sockets).toHaveLength(0);
    expect(peers.at(-1)).toEqual([]);

    const second = setup();
    second.client.start();
    await tick();
    await joined(second.sockets[0]);
    second.client.stop();
    expect(second.sockets[0].closed).toBe(1000);
    // The closed socket's late close event does not reconnect.
    second.sockets[0].drop();
    await tick();
    expect(second.sockets).toHaveLength(1);
  });
});
