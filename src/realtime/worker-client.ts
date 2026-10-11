import { type WorkerNudge, WorkerNudgeSchema } from "../types";
import { getApiKey } from "../utils/api-key";
import { scrubSecrets } from "../utils/secret-scrubber";

export function workerReconnectDelay(attempt: number, random = Math.random()): number {
  return Math.min(30_000, Math.max(1000, 1000 * 2 ** Math.min(attempt, 5) * (0.8 + random * 0.4)));
}

export class WorkerRealtimeClient {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private connectTimeout?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private connected = false;
  private connectedAt = 0;
  private disconnectedAt = Date.now();
  private attempt = 0;
  private readonly listeners = new Set<(nudge: WorkerNudge) => void>();
  private readonly pending = new Map<string, WorkerNudge>();
  private readonly waiters = new Set<{
    kinds: readonly WorkerNudge["kind"][];
    finish: (nudge: WorkerNudge | null) => void;
  }>();

  constructor(
    private readonly config: {
      apiUrl: string;
      agentId: string;
      runtimeInstanceId: string;
      apiKey?: string;
    },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.disconnectedAt = Date.now();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.retry);
    clearTimeout(this.connectTimeout);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.pending.clear();
    for (const waiter of this.waiters) waiter.finish(null);
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnectedSince(): number {
    return this.disconnectedAt;
  }

  onNudge(fn: (nudge: WorkerNudge) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitForNudge(
    kinds: readonly WorkerNudge["kind"][],
    timeoutMs: number,
  ): Promise<WorkerNudge | null> {
    for (const [key, nudge] of this.pending) {
      if (!kinds.includes(nudge.kind)) continue;
      this.pending.delete(key);
      return Promise.resolve(nudge);
    }
    if (this.stopped) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {
        kinds,
        finish: (nudge: WorkerNudge | null) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(nudge);
        },
      };
      const timer = setTimeout(() => waiter.finish(null), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  private emit(nudge: WorkerNudge): void {
    let delivered = this.listeners.size > 0;
    for (const listener of this.listeners) listener(nudge);
    for (const waiter of this.waiters) {
      if (!waiter.kinds.includes(nudge.kind)) continue;
      delivered = true;
      waiter.finish(nudge);
    }
    if (!delivered) {
      this.pending.set(`${nudge.kind}:${nudge.taskId ?? ""}`, nudge);
      if (this.pending.size > 128) this.pending.delete(this.pending.keys().next().value!);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL("/api/realtime", this.config.apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey ?? getApiKey()}`,
          "X-Agent-ID": this.config.agentId,
          "X-Runtime-Instance-ID": this.config.runtimeInstanceId,
        },
      });
      this.socket = socket;
      this.connectTimeout = setTimeout(() => socket.close(), 15_000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            id: 1,
            op: "subscribe",
            namespace: `worker:${this.config.agentId}`,
            name: "nudge",
          }),
        );
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.stopped) return;
        try {
          const frame = JSON.parse(String(event.data));
          if (typeof frame.seq === "number") socket.send(JSON.stringify({ ack: frame.seq }));
          if (frame.id === 1 && frame.type === "result") {
            clearTimeout(this.connectTimeout);
            this.connected = true;
            this.connectedAt = Date.now();
            for (const kind of ["work", "config"] as const)
              this.emit({ v: 1, kind, at: new Date().toISOString() });
          } else if (frame.id === 1 && frame.type === "error") {
            console.warn(scrubSecrets("[worker-realtime] Subscription failed. Reconnecting."));
            socket.close();
          } else if (
            frame.type === "channel" &&
            frame.namespace === `worker:${this.config.agentId}` &&
            frame.name === "nudge"
          ) {
            const parsed = WorkerNudgeSchema.safeParse(frame.data);
            if (parsed.success) this.emit(parsed.data);
          }
        } catch {
          // Invalid frames contain no usable nudge.
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (this.socket !== socket) return;
        clearTimeout(this.connectTimeout);
        if (this.connected) {
          this.disconnectedAt = Date.now();
          if (this.disconnectedAt - this.connectedAt >= 30_000) this.attempt = 0;
        }
        this.connected = false;
        this.socket = undefined;
        this.scheduleReconnect();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = workerReconnectDelay(this.attempt++);
    this.retry = setTimeout(() => this.connect(), delay);
  }
}
