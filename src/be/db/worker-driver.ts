import type { DbParam, DriverOptions, DriverResult, SqliteDriver } from "../db-client";
import { DbTransactionDeadlineError } from "../db-client";
import type { DbWorkerMessage, DbWorkerRequest } from "./db-worker";

/** A submitted write can have an unknown outcome. Never replay after transport loss. */
export class DbWorkerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbWorkerTransportError";
  }
}

function workerSpecifier(): string {
  if (import.meta.url.includes("/$bunfs/")) return "./be/db/db-worker.ts";
  return new URL("./db-worker.ts", import.meta.url).href;
}

export function createWorkerSqliteDriver(
  config: Omit<Extract<DbWorkerRequest, { type: "open" }>, "type">,
  worker = new Worker(workerSpecifier()),
): SqliteDriver & { ready: Promise<{ sqliteVec: boolean }>; failed: Promise<never> } {
  let failure: DbWorkerTransportError | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let closedAck = false;
  let initialized = false;
  let nextId = 0;
  const admitted = new Set<Promise<unknown>>();
  const pending = new Map<
    number,
    { resolve: (result: DriverResult<unknown>) => void; reject: (error: Error) => void }
  >();
  let resolveReady!: (value: { sqliteVec: boolean }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ sqliteVec: boolean }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Startup can fail before the first caller awaits readiness.
  void ready.catch(() => {});
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void exited.catch(() => {});
  let rejectFailed!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailed = reject;
  });
  void failed.catch(() => {});
  const fail = (message: string) => {
    failure ??= new DbWorkerTransportError(message);
    clearTimeout(startupTimer);
    rejectReady(failure);
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
    rejectExit(failure);
    rejectFailed(failure);
    worker.terminate();
  };
  const startupTimer = setTimeout(() => fail("db-worker: readiness timed out"), 10_000);
  worker.onmessage = ({ data }: MessageEvent<DbWorkerMessage>) => {
    if (failure) return;
    if (data === null || typeof data !== "object") return fail("db-worker: invalid response");
    if ("type" in data) {
      if (data.type === "ready") {
        if (initialized || typeof data.sqliteVec !== "boolean")
          return fail("db-worker: invalid readiness response");
        initialized = true;
        clearTimeout(startupTimer);
        resolveReady({ sqliteVec: data.sqliteVec });
        if (!pending.size && !closing) worker.unref();
      } else if (data.type === "fatal") fail(`db-worker: startup failed: ${data.message}`);
      else if (data.type === "closed" && closing && !pending.size && !closedAck) closedAck = true;
      else fail("db-worker: unexpected shutdown acknowledgement");
      return;
    }
    if (
      !initialized ||
      !Number.isSafeInteger(data.id) ||
      !Number.isFinite(data.executionMs) ||
      data.executionMs < 0 ||
      (data.error &&
        (typeof data.error.message !== "string" ||
          typeof data.error.name !== "string" ||
          (data.error.code !== undefined && typeof data.error.code !== "string")))
    )
      return fail("db-worker: invalid statement response");
    const call = pending.get(data.id);
    if (!call) return fail("db-worker: invalid response ID");
    pending.delete(data.id);
    if (data.error) {
      const error =
        data.error.name === "DbTransactionDeadlineError"
          ? new DbTransactionDeadlineError()
          : new Error(data.error.message);
      call.reject(Object.assign(error, data.error, { executionMs: data.executionMs }));
    } else call.resolve({ value: data.value, executionMs: data.executionMs });
    if (!pending.size && !closing) worker.unref();
  };
  worker.onerror = (event) => fail(`db-worker: transport failed: ${event.message}`);
  worker.addEventListener("close", (event) => {
    if (closing && closedAck && event.code === 0) resolveExit();
    else
      fail(
        `db-worker: connection lost (exit ${event.code}); submitted writes can have an unknown outcome`,
      );
  });
  try {
    worker.postMessage({ type: "open", ...config } satisfies DbWorkerRequest);
  } catch {
    fail("db-worker: opening request submission failed");
  }

  // Reserve admission before waiting for startup. The client owns transaction order.
  const request = <T>(
    op: "all" | "get" | "run" | "runTimed" | "exec",
    sql: string,
    params: DbParam[],
    options?: DriverOptions,
  ): Promise<DriverResult<T>> => {
    if (failure) return Promise.reject(failure);
    if (closing) return Promise.reject(new DbWorkerTransportError("db-worker: driver is closed"));
    worker.ref();
    const id = ++nextId;
    const result = new Promise<DriverResult<unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    // Copy without transfer lists. Callers retain ownership of their buffers.
    let message: DbWorkerRequest;
    try {
      message = structuredClone({ id, op, sql, params, ...options } satisfies DbWorkerRequest);
    } catch {
      const call = pending.get(id)!;
      pending.delete(id);
      call.reject(new Error("db-worker: parameters could not be cloned"));
      if (!pending.size && initialized && !closing) worker.unref();
      return result as Promise<DriverResult<T>>;
    }
    void ready.then(
      () => {
        if (failure) return;
        worker.ref();
        try {
          worker.postMessage(message);
        } catch {
          fail("db-worker: request submission failed");
        }
      },
      () => {},
    );
    admitted.add(result);
    void result.then(
      () => admitted.delete(result),
      () => admitted.delete(result),
    );
    return result as Promise<DriverResult<T>>;
  };
  return {
    blocksEventLoop: false,
    ready,
    failed,
    all: <T>(sql: string, params: DbParam[], options?: DriverOptions) =>
      request<T[]>("all", sql, params, options),
    get: <T>(sql: string, params: DbParam[], options?: DriverOptions) =>
      request<T | null>("get", sql, params, options),
    run: (sql, params, options) => request("run", sql, params, options),
    runTimed: (sql, params, options) => request("runTimed", sql, params, options),
    exec: (sql, options) => request("exec", sql, [], options),
    close() {
      closing = true;
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const timer = setTimeout(
          () => fail("db-worker: shutdown timed out; forced termination"),
          10_000,
        );
        try {
          await ready;
          // Each reply removes its pending entry before this continuation resumes.
          await Promise.allSettled([...admitted]);
          if (failure) throw failure;
          worker.ref();
          worker.postMessage({ type: "close" } satisfies DbWorkerRequest);
          await exited;
        } finally {
          clearTimeout(timer);
          worker.terminate();
        }
      })();
      return closePromise;
    },
  };
}
