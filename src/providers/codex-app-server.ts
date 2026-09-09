import pkg from "../../package.json";
import { scrubSecrets } from "../utils/secret-scrubber";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 250;
const EXIT_STREAM_DRAIN_MS = 100;
const MAX_STDOUT_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_STDERR_LINE_LENGTH = 64 * 1024;
const MAX_STDERR_TAIL_LENGTH = 16 * 1024;

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
};

export type CodexConfigValue =
  | string
  | number
  | boolean
  | readonly CodexConfigValue[]
  | { readonly [key: string]: CodexConfigValue | undefined };

export interface CodexAppServerOptions {
  codexPath?: string;
  env: Readonly<Record<string, string | undefined>>;
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export class CodexAppServerRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(method: string, error: RpcError) {
    super(`Codex app-server ${method} failed (${error.code}): ${error.message}`);
    this.name = "CodexAppServerRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

/** Thin JSONL client for one `codex app-server --listen stdio://` process. */
export class CodexAppServer {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notificationListeners = new Set<
    (notification: CodexAppServerNotification) => void
  >();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly requestTimeoutMs: number;
  private readonly onStderr?: (line: string) => void;
  private readonly ready: Promise<void>;
  private readonly stderrDone: Promise<void>;
  private nextId = 0;
  private stderrTail = "";
  private initializedVersion: string | undefined;
  private terminalError: Error | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: CodexAppServerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Codex app-server requestTimeoutMs must be a positive number");
    }
    this.onStderr = options.onStderr;

    const codexPath = options.codexPath ?? resolveCodexPath(options.env.PATH);
    const command = [codexPath, "app-server", "--listen", "stdio://"];

    const env = Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    this.proc = Bun.spawn(command, {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    void this.consumeStdout().catch((error) => this.fail(asError(error)));
    this.stderrDone = this.consumeStderr().catch((error) => {
      this.fail(asError(error));
    });
    void this.proc.exited.then(async (exitCode) => {
      await Promise.race([this.stderrDone, Bun.sleep(EXIT_STREAM_DRAIN_MS)]);
      if (this.closePromise) return;
      const suffix = this.stderrTail ? `: ${this.stderrTail}` : "";
      this.fail(new Error(`Codex app-server exited with code ${exitCode}${suffix}`));
    });

    // Delay the handshake by one microtask so callers can subscribe immediately
    // after construction without losing startup notifications.
    this.ready = Promise.resolve().then(() => this.initialize());
    void this.ready.catch(() => {});
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ready;
    return this.requestRaw<T>(method, params);
  }

  get version(): string | undefined {
    return this.initializedVersion;
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.terminalError) {
      listener(this.terminalError);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.rejectPending(new Error("Codex app-server closed"));
    this.closePromise = this.terminate();
    return this.closePromise;
  }

  private async initialize(): Promise<void> {
    const response = await this.requestRaw<{ userAgent?: unknown }>("initialize", {
      clientInfo: {
        name: "agent-swarm",
        title: "Agent Swarm",
        version: pkg.version,
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    if (typeof response.userAgent === "string") {
      this.initializedVersion = parseVersion(response.userAgent);
    }
    this.write({ method: "initialized" });
  }

  private requestRaw<T>(method: string, params?: unknown): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closePromise) return Promise.reject(new Error("Codex app-server closed"));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.write(params === undefined ? { method, id } : { method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  private write(message: unknown): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closePromise) throw new Error("Codex app-server closed");
    const stdin = this.proc.stdin as { write(value: string): number; flush(): unknown };
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  private async consumeStdout(): Promise<void> {
    await readLines(
      this.proc.stdout as ReadableStream<Uint8Array>,
      MAX_STDOUT_LINE_LENGTH,
      (line) => this.handleLine(line),
    );
  }

  private async consumeStderr(): Promise<void> {
    await readLines(
      this.proc.stderr as ReadableStream<Uint8Array>,
      MAX_STDERR_LINE_LENGTH,
      (line) => {
        const scrubbed = scrubSecrets(line);
        this.stderrTail = `${this.stderrTail}${this.stderrTail ? "\n" : ""}${scrubbed}`.slice(
          -MAX_STDERR_TAIL_LENGTH,
        );
        if (!this.onStderr) return;
        try {
          this.onStderr(scrubbed);
        } catch (error) {
          console.error(
            `[codex-app-server] stderr listener failed: ${scrubSecrets(asError(error).message)}`,
          );
        }
      },
    );
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      throw new Error("Codex app-server emitted malformed JSON", {
        cause: error,
      });
    }
    if (!isRecord(message)) {
      throw new Error("Codex app-server emitted a non-object JSON message");
    }

    if (isRequestId(message.id)) {
      if (typeof message.method === "string") {
        this.rejectServerRequest(message.id, message.method);
        return;
      }
      this.handleResponse(message.id, message);
      return;
    }

    if (typeof message.method === "string") {
      const notification: CodexAppServerNotification = {
        method: message.method,
        ...(Object.hasOwn(message, "params") ? { params: message.params } : {}),
        ...(typeof message.emittedAtMs === "number" ? { emittedAtMs: message.emittedAtMs } : {}),
      };
      for (const listener of this.notificationListeners) {
        try {
          listener(notification);
        } catch (error) {
          console.error(
            `[codex-app-server] notification listener failed: ${scrubSecrets(asError(error).message)}`,
          );
        }
      }
      return;
    }

    throw new Error("Codex app-server emitted an invalid protocol message");
  }

  private handleResponse(id: string | number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (isRpcError(message.error)) {
      pending.reject(new CodexAppServerRpcError(pending.method, message.error));
      return;
    }
    if (Object.hasOwn(message, "result")) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(
      new Error(`Codex app-server returned an invalid response for ${pending.method}`),
    );
  }

  private rejectServerRequest(id: string | number, method: string): void {
    this.write({
      id,
      error: {
        code: -32601,
        message: `Client does not support server request: ${method}`,
      },
    });
  }

  private fail(error: Error): void {
    if (this.terminalError || this.closePromise) return;
    this.terminalError = error;
    this.rejectPending(error);
    this.closePromise = this.terminate();
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        console.error(
          `[codex-app-server] close listener failed: ${scrubSecrets(asError(listenerError).message)}`,
        );
      }
    }
    this.closeListeners.clear();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async terminate(): Promise<void> {
    try {
      (this.proc.stdin as { end(): void }).end();
    } catch {
      // The process already closed stdin.
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      return;
    }

    const exited = this.proc.exited.then(() => undefined);
    await Promise.race([exited, Bun.sleep(CLOSE_GRACE_MS)]);
    if (this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        return;
      }
      await Promise.race([exited, Bun.sleep(CLOSE_GRACE_MS)]);
    }
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  maxLineLength: number,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (line.length > maxLineLength) {
          throw new Error(`Codex app-server output line exceeded ${maxLineLength} characters`);
        }
        if (line) onLine(line);
        newline = buffered.indexOf("\n");
      }
      if (buffered.length > maxLineLength) {
        throw new Error(`Codex app-server output line exceeded ${maxLineLength} characters`);
      }
      if (done) break;
    }
    if (buffered) {
      const line = buffered.replace(/\r$/, "");
      if (line.length > maxLineLength) {
        throw new Error(`Codex app-server output line exceeded ${maxLineLength} characters`);
      }
      onLine(line);
    }
  } finally {
    reader.releaseLock();
  }
}

function resolveCodexPath(path: string | undefined): string {
  const fromPath = Bun.which("codex", { PATH: path ?? process.env.PATH });
  if (fromPath) return fromPath;
  try {
    return Bun.resolveSync("@openai/codex/bin/codex.js", import.meta.dir);
  } catch {
    return "codex";
  }
}

function parseVersion(userAgent: string): string | undefined {
  return userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isRpcError(value: unknown): value is RpcError {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    Number.isFinite(value.code) &&
    typeof value.message === "string"
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
