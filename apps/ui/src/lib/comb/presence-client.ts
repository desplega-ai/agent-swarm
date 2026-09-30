// A small client for one Comb presence room on the swarm realtime socket
// (`/api/realtime?ticket=`). It joins the room, publishes this tab's presence,
// and reports every `peers` frame. No CRDT: it never sends `update`, and the
// server allows only join, leave, and presence in a Comb namespace.
//
// Protocol (runbooks/realtime-rooms.md): ack every frame that carries a
// `seq` (128 unacked frames close the socket), requests carry an integer `id`,
// answers are `result` or `error` with the same id. A ticket is single use, so
// every reconnect fetches a new one, then joins and publishes again.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { PRESENCE_ROOM } from "./presence";

/** The part of `WebSocket` the client uses (a fake one in tests). */
export interface PresenceSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * `connecting`: the first connect. `open`: joined. `reconnecting`: the socket
 * dropped and a retry is due. `denied`: the server refused (no retry).
 * `closed`: stopped by the page.
 */
export type PresenceStatus = "connecting" | "open" | "reconnecting" | "denied" | "closed";

export interface PresenceClientOptions {
  namespace: string;
  /** A fresh one-shot ticket. An error with `status` 401 or 403 stops the client. */
  getTicket: () => Promise<string>;
  /** The socket URL for a ticket. */
  socketUrl: (ticket: string) => string;
  /** Every `peers` array the server sends (raw, parse each entry with `parsePeer`). */
  onPeers: (peers: readonly unknown[]) => void;
  onStatus?: (status: PresenceStatus) => void;
  createSocket?: (url: string) => PresenceSocket;
  /** Delay before retry `attempt` (1-based). Default: 1 s doubling to 15 s, plus jitter. */
  retryDelay?: (attempt: number) => number;
}

const OPEN = 1;

function defaultRetryDelay(attempt: number): number {
  const base = Math.min(15_000, 1_000 * 2 ** (attempt - 1));
  return base + Math.random() * base * 0.3;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDenied(error: unknown): boolean {
  const status = isRecord(error) ? error.status : undefined;
  return status === 401 || status === 403;
}

export class PresenceClient {
  private readonly options: PresenceClientOptions;
  private socket: PresenceSocket | null = null;
  private running = false;
  private joined = false;
  private denied = false;
  private latest: unknown = undefined;
  private nextId = 1;
  private joinId = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by `stop`, so a ticket that arrives after it is dropped. */
  private generation = 0;

  constructor(options: PresenceClientOptions) {
    this.options = options;
  }

  /** Connect (again), unless the server refused this tab. */
  start(): void {
    if (this.running || this.denied) return;
    this.running = true;
    this.attempt = 0;
    void this.connect();
  }

  /** Close the socket. The server removes this tab's presence at once. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.joined = false;
    if (socket) this.closeSocket(socket, 1000, "Leaving");
    this.options.onPeers([]);
    this.setStatus("closed");
  }

  /** Publish this tab's presence now (and again after every reconnect). */
  publish(data: unknown): void {
    this.latest = data;
    if (this.joined) this.request({ op: "presence", data });
  }

  private setStatus(status: PresenceStatus) {
    this.options.onStatus?.(status);
  }

  private request(message: Record<string, unknown>): number {
    const id = this.nextId++;
    const socket = this.socket;
    if (socket && socket.readyState === OPEN) {
      socket.send(
        JSON.stringify({
          id,
          name: PRESENCE_ROOM,
          namespace: this.options.namespace,
          ...message,
        }),
      );
    }
    return id;
  }

  private async connect() {
    const generation = this.generation;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ticket: string;
    try {
      ticket = await this.options.getTicket();
    } catch (error) {
      if (generation !== this.generation) return;
      if (isDenied(error)) this.deny();
      else this.retry();
      return;
    }
    if (generation !== this.generation) return;

    let socket: PresenceSocket;
    try {
      const url = this.options.socketUrl(ticket);
      socket = this.options.createSocket
        ? this.options.createSocket(url)
        : (new WebSocket(url) as unknown as PresenceSocket);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.joinId = this.request({ op: "join", schemaVersion: 1 });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.onFrame(socket, event.data);
    };
    socket.onerror = () => {
      // A close event follows.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasJoined = this.joined;
      this.joined = false;
      // Peers are unknown until the next join answers.
      if (wasJoined) this.options.onPeers([]);
      if (!this.denied) this.retry();
    };
  }

  private onFrame(socket: PresenceSocket, raw: unknown) {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.seq === "number" && socket.readyState === OPEN) {
      socket.send(JSON.stringify({ ack: message.seq }));
    }
    switch (message.type) {
      case "result":
        if (message.id !== this.joinId || this.joined) return;
        this.joined = true;
        this.attempt = 0;
        this.setStatus("open");
        this.options.onPeers(Array.isArray(message.peers) ? message.peers : []);
        if (this.latest !== undefined) this.request({ op: "presence", data: this.latest });
        return;
      case "presence":
        if (message.namespace === this.options.namespace && Array.isArray(message.peers)) {
          this.options.onPeers(message.peers);
        }
        return;
      case "error":
        // A refused join does not get better with retries (permission, namespace).
        if (message.id === this.joinId && !this.joined) this.deny();
        return;
    }
  }

  private deny() {
    this.denied = true;
    this.running = false;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    if (socket) this.closeSocket(socket, 1000, "Denied");
    this.setStatus("denied");
  }

  private retry() {
    if (!this.running || this.retryTimer) return;
    this.attempt++;
    this.setStatus("reconnecting");
    const delay = (this.options.retryDelay ?? defaultRetryDelay)(this.attempt);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) void this.connect();
    }, delay);
  }

  private closeSocket(socket: PresenceSocket, code: number, reason: string) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
