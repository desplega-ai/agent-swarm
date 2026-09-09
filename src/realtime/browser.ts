import * as Y from "yjs";
import { changeDocument, type JsonObject, materialize, type RoomOperation } from "./document";

type Handler = (value: unknown) => void;
type Viewer = { userId: string; name: string; kind: string };
type Peer = Viewer & { data: unknown };
type Frame = {
  type: string;
  id?: number;
  seq?: number;
  name?: string;
  room?: View;
  me?: Viewer;
  peers?: Peer[];
  data?: unknown;
  error?: string;
};
type View = {
  namespace: string;
  name: string;
  generation: string;
  schemaVersion: number;
  stale: boolean;
  snapshot: string;
  bytes: number;
};
type Options = { schemaVersion?: number };

function encode(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

class Events {
  private handlers = new Map<string, Set<Handler>>();
  on(name: string, handler: Handler): () => void {
    const set = this.handlers.get(name) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(name, set);
    return () => set.delete(handler);
  }
  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

class Connection extends Events {
  socket?: WebSocket;
  rooms = new Map<string, Room>();
  channels = new Map<string, Channel>();
  private pending = new Map<
    number,
    {
      resolve: (value: Frame) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;
  private opening?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  me?: Viewer;

  async open(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    const match = location.pathname.match(/^\/p\/([^/.]+)/);
    if (!match) throw new Error("Realtime rooms require a Swarm page");
    const url = new URL("/@swarm/realtime", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("pageId", decodeURIComponent(match[1]!));
    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        this.opening = undefined;
        resolve();
      };
      socket.onerror = () => reject(new Error("Realtime connection failed"));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as Frame;
        if (message.seq) socket.send(JSON.stringify({ ack: message.seq }));
        if (message.type === "hello") this.me = message.me;
        if (message.type === "room")
          this.rooms.get(message.name ?? "")?.receive(message as unknown as View);
        if (message.type === "presence")
          this.rooms.get(message.name ?? "")?.receivePresence(message.peers);
        if (message.type === "channel")
          this.channels.get(message.name ?? "")?.emit("message", message.data);
        if (message.type === "deleted") this.rooms.get(message.name ?? "")?.deleted();
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.type === "error") pending.reject(new Error(message.error));
            else pending.resolve(message);
          }
        }
      };
      socket.onclose = () => {
        this.opening = undefined;
        reject(new Error("Realtime connection closed"));
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Realtime connection closed"));
        }
        this.pending.clear();
        if (!this.stopped)
          this.retry = setTimeout(() => {
            void this.reconnect();
          }, 1000);
      };
    });
    return this.opening;
  }

  private async reconnect(): Promise<void> {
    try {
      await this.open();
      for (const room of this.rooms.values()) await room.join(true);
      for (const name of this.channels.keys()) await this.request({ op: "subscribe", name });
    } catch (error) {
      for (const room of this.rooms.values()) room.emit("error", error);
    }
  }

  async request(message: Record<string, unknown>): Promise<Frame> {
    await this.open();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Realtime request timed out"));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ ...message, id }));
    });
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}

class Room extends Events {
  ydoc = new Y.Doc({ gc: true });
  generation = "";
  stale = false;
  bytes = 0;
  me?: Viewer;
  private ready?: Promise<void>;
  private writes = Promise.resolve();
  private lastWrite = Promise.resolve();
  private peers: Peer[] = [];
  private presenceData: unknown = {};
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  readonly schemaVersion: number;
  readonly presence: { set: (data: unknown) => void; readonly peers: Peer[] };

  constructor(
    private readonly connection: Connection,
    readonly name: string,
    options: Options,
  ) {
    super();
    this.schemaVersion = options.schemaVersion ?? 1;
    const self = this;
    this.presence = {
      set(data) {
        self.presenceData = structuredClone(data);
        if (!self.presenceTimer)
          self.presenceTimer = setTimeout(() => {
            self.presenceTimer = undefined;
            void connection
              .request({ op: "presence", name, data: self.presenceData })
              .catch((error) => self.emit("error", error));
          }, 50);
      },
      get peers() {
        return self.peers;
      },
    };
    this.observe();
  }

  get state(): JsonObject {
    return materialize(this.ydoc);
  }

  private observe(): void {
    this.ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
      this.emit("change", this.state);
      if (origin === "remote" || !this.generation || this.closed) return;
      if (this.connection.socket?.readyState !== WebSocket.OPEN) return;
      const snapshot = encode(Y.encodeStateAsUpdate(this.ydoc));
      const generation = this.generation;
      const write = this.writes.then(async () => {
        try {
          const response = await this.connection.request({
            op: "update",
            name: this.name,
            generation,
            schemaVersion: this.schemaVersion,
            snapshot,
          });
          if (response.room) this.receive(response.room);
        } catch (error) {
          // A rejected write must not remain visible as accepted local state.
          if (this.connection.socket?.readyState === WebSocket.OPEN) {
            const response = await this.connection.request({
              op: "join",
              name: this.name,
              schemaVersion: this.schemaVersion,
            });
            this.receive(response.room, true);
          }
          this.emit("error", error);
          throw error;
        }
      });
      this.lastWrite = write;
      this.writes = write.catch(() => {});
    });
  }

  async join(resync = false): Promise<void> {
    if (this.ready && !resync) return this.ready;
    this.ready = (async () => {
      const generation = this.generation;
      const response = await this.connection.request({
        op: "join",
        name: this.name,
        schemaVersion: this.schemaVersion,
      });
      this.me = response.me;
      this.receive(response.room);
      this.receivePresence(response.peers);
      if (resync && generation === this.generation && !this.stale) {
        const result = await this.connection.request({
          op: "update",
          name: this.name,
          schemaVersion: this.schemaVersion,
          generation,
          snapshot: encode(Y.encodeStateAsUpdate(this.ydoc)),
        });
        this.receive(result.room);
      }
      if (resync) this.presence.set(this.presenceData);
    })();
    return this.ready;
  }

  receive(view: View | undefined, replace = false): void {
    if (this.closed || !view) return;
    const reset = replace || (this.generation !== "" && view.generation !== this.generation);
    this.generation = view.generation;
    this.stale = view.schemaVersion !== this.schemaVersion;
    this.bytes = view.bytes;
    if (reset) {
      this.ydoc.destroy();
      this.ydoc = new Y.Doc({ gc: true });
      this.observe();
    }
    Y.applyUpdate(this.ydoc, decode(view.snapshot), "remote");
    if (reset) this.emit("reset", this.state);
  }

  receivePresence(peers: Peer[] = []): void {
    this.peers = peers;
    this.emit("presence", peers);
  }
  deleted(): void {
    this.closed = true;
    this.emit("error", new Error("Room owner was deleted"));
    this.ydoc.destroy();
  }

  async change(fn: (state: JsonObject) => void): Promise<void> {
    if (this.closed) throw new Error("Room is closed");
    if (this.stale) throw new Error("Room schema is stale. Read the state and reset explicitly.");
    if (changeDocument(this.ydoc, fn).length > 0) await this.lastWrite;
  }

  async apply(operations: RoomOperation[]): Promise<void> {
    if (this.closed || this.stale) throw new Error("Room is closed or stale");
    await this.writes;
    const response = await this.connection.request({
      op: "change",
      name: this.name,
      generation: this.generation,
      schemaVersion: this.schemaVersion,
      operations,
    });
    this.receive(response.room);
  }

  async reset(state: Record<string, unknown> = {}): Promise<void> {
    if (this.closed) throw new Error("Room is closed");
    await this.writes;
    const response = await this.connection.request({
      op: "reset",
      name: this.name,
      schemaVersion: this.schemaVersion,
      state,
    });
    this.receive(response.room);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.presenceTimer);
    this.connection.rooms.delete(this.name);
    try {
      await this.connection.request({ op: "leave", name: this.name });
    } finally {
      this.ydoc.destroy();
    }
  }
}

class Channel extends Events {
  constructor(
    private readonly connection: Connection,
    readonly name: string,
  ) {
    super();
  }
  async publish(data: unknown): Promise<void> {
    await this.connection.request({ op: "publish", name: this.name, data });
  }
  async close(): Promise<void> {
    this.connection.channels.delete(this.name);
    await this.connection.request({ op: "unsubscribe", name: this.name });
  }
}

const connection = new Connection();
window.addEventListener("pagehide", () => connection.close());

export async function room(name = "default", options: Options = {}): Promise<Room> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid room name");
  let result = connection.rooms.get(name);
  if (result && result.schemaVersion !== (options.schemaVersion ?? 1))
    throw new Error("Room already opened with a different schema version");
  if (!result) {
    result = new Room(connection, name, options);
    connection.rooms.set(name, result);
  }
  try {
    await result.join();
  } catch (error) {
    connection.rooms.delete(name);
    throw error;
  }
  return result;
}

export async function channel(name: string): Promise<Channel> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid channel name");
  const existing = connection.channels.get(name);
  if (existing) return existing;
  const result = new Channel(connection, name);
  connection.channels.set(name, result);
  try {
    await connection.request({ op: "subscribe", name });
  } catch (error) {
    connection.channels.delete(name);
    throw error;
  }
  return result;
}
