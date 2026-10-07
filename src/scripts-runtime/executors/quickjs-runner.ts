import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { buildCtx, type RuntimeCtx } from "../ctx";
import { Redacted, type Redacted as RedactedValue } from "../redacted";
import { SCRIPT_SDK_RESPONSE_LIMIT_BYTES } from "../response-limit";
import { ctxSignatureHintFor } from "../script-error-hints";
import { runtimeFetch } from "../stdlib/fetch";
import { table } from "../stdlib/table";
import { SwarmConfig } from "../swarm-config";
import { bundleForQuickJS, USER_SCRIPT_FILE } from "./quickjs-bundle";
import { SANDBOX_EPILOGUE, SANDBOX_PRELUDE } from "./quickjs-prelude";
import type { SourceMapReader } from "./sourcemap";
import type {
  ExecutorOutput,
  ScriptExecutorError,
  ScriptResourcePolicy,
  ScriptRuntimeError,
  ScriptStackFrame,
  SwarmConfigPayload,
} from "./types";

export type QuickJSJob = {
  source: string;
  args: unknown;
  configPayload: SwarmConfigPayload;
  resources: ScriptResourcePolicy;
};

const BUNDLE_FILE = USER_SCRIPT_FILE.replace(/\.ts$/, ".js");
const MAX_STACK_BYTES = 1024 * 1024;
const TIMEOUT_EXIT_CODE = 124;

type ErrorPayload = { name: string; message: string; stack: string };
type Outcome = { ok: true; result: unknown } | { ok: false; error: ErrorPayload };

class CappedLog {
  private readonly parts: string[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    if (this.truncated) return;
    const size = Buffer.byteLength(text);
    if (this.bytes + size <= this.limit) {
      this.parts.push(text);
      this.bytes += size;
      return;
    }
    const room = this.limit - this.bytes;
    if (room > 0) this.parts.push(Buffer.from(text).subarray(0, room).toString());
    this.bytes = this.limit;
    this.truncated = true;
  }

  get text(): string {
    return this.parts.join("");
  }
}

function errorPayload(error: unknown): ErrorPayload {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message, stack: error.stack ?? "" };
  }
  if (error && typeof error === "object" && "message" in error) {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "Error",
      message: String(record.message),
      stack: typeof record.stack === "string" ? record.stack : "",
    };
  }
  return { name: "Error", message: String(error), stack: "" };
}

function classify(error: ErrorPayload): ScriptExecutorError {
  if (error.name === "InternalError" && error.message === "interrupted") return "timeout";
  if (error.message === "out of memory") return "oom";
  return "eval_error";
}

async function readTextCapped(response: Response, operation: string): Promise<string> {
  const limit = SCRIPT_SDK_RESPONSE_LIMIT_BYTES;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(
        `${operation} response exceeded the ${limit}-byte limit of the quickjs executor`,
      );
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

type SandboxRequest = {
  url: string;
  method?: string;
  headers?: [string, string][];
  body?: string;
  retries?: number;
  timeoutMs?: number;
};

function requestInit(request: SandboxRequest): RequestInit {
  return { method: request.method, headers: request.headers, body: request.body };
}

async function serializeResponse(response: Response, operation: string) {
  // Keep `headers` before `body`: see the data: URL note in dispatchCall.
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    url: response.url,
    headers: Array.from(response.headers.entries()),
    body: await readTextCapped(response, operation),
  };
}

function callable(target: unknown, name: string): (...args: unknown[]) => Promise<unknown> {
  if (typeof target !== "function") throw new TypeError(`${name} is not a function`);
  return target as (...args: unknown[]) => Promise<unknown>;
}

/** Runs an async host call that the sandbox requested. Only these paths exist. */
async function dispatchCall(hostCtx: RuntimeCtx, path: string, args: unknown[]): Promise<unknown> {
  if (path === "fetch" || path === "stdlib.fetch" || path === "stdlib.fetchJson") {
    const request = args[0] as SandboxRequest;
    const response =
      path === "fetch"
        ? await fetch(request.url, requestInit(request))
        : await runtimeFetch(request.url, {
            ...requestInit(request),
            retries: request.retries,
            timeoutMs: request.timeoutMs,
          });
    if (path !== "stdlib.fetchJson") return serializeResponse(response, path);
    // Read the header first. Bun 1.4 returns null headers for a data: URL
    // response whose body was streamed before the headers were first read.
    const contentType = response.headers.get("content-type") ?? "";
    const text = await readTextCapped(response, path);
    return contentType.includes("application/json") ? JSON.parse(text) : text;
  }

  // The path comes from sandbox code, so only own members are reachable:
  // never `constructor`, `__proto__`, or other inherited properties.
  const own = (target: unknown, name: string): unknown =>
    target && typeof target === "object" && Object.hasOwn(target, name)
      ? (target as Record<string, unknown>)[name]
      : undefined;
  const [kind, first, ...rest] = path.split(".");
  if (kind === "swarm" && first === "room" && rest.length === 1) {
    const name = rest[0] as string;
    return callable(own(hostCtx.swarm.room, name), `ctx.swarm.room.${name}`)(...args);
  }
  if (kind === "swarm" && first && rest.length === 0) {
    // ctx.swarm is a Proxy that maps any tool name to a call (allowlisted inside).
    const method = first in Object.prototype ? undefined : hostCtx.swarm[first];
    return callable(method, `ctx.swarm.${first}`)(...args);
  }
  if ((kind === "api" || kind === "mcp") && first && rest.length > 0) {
    const name = rest.join(".");
    const client = own(hostCtx[kind], first);
    return callable(own(client, name), `ctx.${kind}.${first}.${name}`)(...args);
  }
  throw new Error(`unknown quickjs host call: ${path}`);
}

function redactedFor(config: SwarmConfig, hostId: unknown): RedactedValue<unknown> {
  if (typeof hostId !== "string") throw new Error("invalid Redacted handle");
  const system: Record<string, RedactedValue<string> | undefined> = {
    "system:apiKey": config.apiKey,
    "system:agentId": config.agentId,
    "system:mcpBaseUrl": config.mcpBaseUrl,
    "system:runtimeInstanceId": config.runtimeInstanceId,
  };
  const value = hostId.startsWith("user:") ? config.get(hostId.slice(5)) : system[hostId];
  if (!value) throw new Error("Redacted value was not in registry");
  return value;
}

/** Runs a sync host call that the sandbox requested. */
function dispatchSync(config: SwarmConfig, op: string, value: unknown): unknown {
  switch (op) {
    case "redacted.value":
      return Redacted.value(redactedFor(config, value));
    case "redacted.meta":
      return Redacted.meta(redactedFor(config, value));
    case "config.has":
      return typeof value === "string" && config.get(value) !== undefined;
    case "table":
      return table(value as Array<Record<string, unknown>>);
    default:
      throw new Error(`unknown quickjs sync host call: ${op}`);
  }
}

const FRAME_RE = /\s+at\s+(?:(\S+)\s+\()?([^\s()]+):(\d+):(\d+)\)?/g;

function structuredError(
  error: ErrorPayload,
  map: SourceMapReader | undefined,
): ScriptRuntimeError & { ctxSignatureHint?: string } {
  const userFrames: ScriptStackFrame[] = [];
  const lines: string[] = [];
  for (const match of error.stack.matchAll(FRAME_RE)) {
    const [raw, fn, file, line, column] = match;
    if (!file || !line || !column) continue;
    const original =
      file === BUNDLE_FILE ? map?.originalPositionFor(Number(line), Number(column)) : undefined;
    if (original?.source.endsWith(USER_SCRIPT_FILE)) {
      const location = `${USER_SCRIPT_FILE}:${original.line}:${original.column}`;
      const text = fn ? `at ${fn} (${location})` : `at ${location}`;
      userFrames.push({
        file: USER_SCRIPT_FILE,
        line: original.line,
        column: original.column,
        raw: text,
      });
      lines.push(`    ${text}`);
    } else {
      lines.push(`    ${raw.trim()}`);
    }
  }
  const hint = ctxSignatureHintFor(error.message);
  return {
    name: error.name,
    message: error.message,
    stack: [`${error.name}: ${error.message}`, ...lines].join("\n"),
    userFrames,
    userScriptLine: userFrames[0]?.line,
    userScriptColumn: userFrames[0]?.column,
    ...(hint ? { ctxSignatureHint: hint } : {}),
  };
}

function errorStderr(runtimeError: ScriptRuntimeError): string {
  if (runtimeError.userFrames.length === 0) return `${runtimeError.stack}\n`;
  const frames = runtimeError.userFrames.map((frame) => `    ${frame.raw}`).join("\n");
  return `${runtimeError.name}: ${runtimeError.message}\n${frames}\n`;
}

/**
 * Evaluates one script in a fresh QuickJS runtime. The caller owns the
 * process-level setup (one job at a time, egress fetch patch).
 */
export async function runQuickJSJob(
  QuickJS: QuickJSWASMModule,
  job: QuickJSJob,
): Promise<ExecutorOutput> {
  const start = performance.now();
  const stdout = new CappedLog(job.resources.maxStdoutBytes);
  const stderr = new CappedLog(job.resources.maxStdoutBytes);
  const output = (
    fields: Omit<ExecutorOutput, "stdout" | "stderr" | "truncated" | "durationMs">,
  ) => ({
    ...fields,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    durationMs: Math.round(performance.now() - start),
  });

  const bundle = await bundleForQuickJS(job.source);
  if (!bundle.ok) {
    stderr.append(`${bundle.diagnostic}\n`);
    return output({
      result: undefined,
      exitCode: 1,
      error: "eval_error",
      runtimeError: {
        name: "BuildError",
        message: bundle.diagnostic,
        stack: bundle.diagnostic,
        userFrames: [],
      },
    });
  }

  const config = new SwarmConfig(job.configPayload);
  const hostCtx = buildCtx({
    swarmConfig: config,
    apiConnections: job.configPayload.apiConnections,
    mcpConnections: job.configPayload.mcpConnections,
  });
  const shape = {
    hasRuntimeInstanceId: config.runtimeInstanceId !== undefined,
    api: Object.fromEntries(Object.entries(hostCtx.api).map(([slug, c]) => [slug, Object.keys(c)])),
    mcp: Object.fromEntries(Object.entries(hostCtx.mcp).map(([slug, c]) => [slug, Object.keys(c)])),
  };
  // Accept both shapes, like eval-harness: callers may pass already-serialized JSON.
  const args = typeof job.args === "string" ? JSON.parse(job.args) : (job.args ?? null);

  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(job.resources.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const deadline = Date.now() + job.resources.wallClockMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx: QuickJSContext = runtime.newContext();

  let alive = true;
  let finish: (outcome: Outcome) => void = () => {};
  const done = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });
  const fail = (error: unknown) => finish({ ok: false, error: errorPayload(error) });

  const drain = () => {
    if (!alive) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      const dumped = ctx.dump(jobs.error);
      jobs.error.dispose();
      fail(dumped);
    }
  };

  const pending = new Set<QuickJSDeferredPromise>();
  const bridge = (run: () => Promise<unknown>): QuickJSHandle => {
    const deferred = ctx.newPromise();
    pending.add(deferred);
    void run()
      .then(
        (value) => ({ value: value === undefined ? null : value }),
        (error) => ({ error: errorPayload(error) }),
      )
      .then((envelope) => {
        if (!alive) return;
        let json: string;
        try {
          json = JSON.stringify(envelope);
        } catch (error) {
          json = JSON.stringify({ error: errorPayload(error) });
        }
        const handle = ctx.newString(json);
        deferred.resolve(handle);
        handle.dispose();
        pending.delete(deferred);
        deferred.dispose();
        drain();
      })
      // A failure while handing the result back to QuickJS ends the run.
      .catch(fail);
    return deferred.handle;
  };

  const define = (name: string, fn: (...handles: QuickJSHandle[]) => QuickJSHandle | undefined) => {
    const handle = ctx.newFunction(name, fn);
    ctx.setProp(ctx.global, name, handle);
    handle.dispose();
  };
  define("__host_call", (pathHandle, argsHandle) => {
    const path = ctx.getString(pathHandle);
    const callArgs = JSON.parse(ctx.getString(argsHandle)) as unknown[];
    return bridge(() => dispatchCall(hostCtx, path, callArgs));
  });
  define("__host_sync", (opHandle, valueHandle) => {
    let envelope: unknown;
    try {
      const value = dispatchSync(
        config,
        ctx.getString(opHandle),
        JSON.parse(ctx.getString(valueHandle)),
      );
      envelope = { value: value === undefined ? null : value };
    } catch (error) {
      envelope = { error: errorPayload(error) };
    }
    return ctx.newString(JSON.stringify(envelope));
  });
  define("__host_log", (streamHandle, textHandle) => {
    const text = ctx.getString(textHandle);
    (ctx.getString(streamHandle) === "stderr" ? stderr : stdout).append(text);
    return undefined;
  });
  define("__host_sleep", (msHandle) => {
    const ms = Math.max(0, ctx.getNumber(msHandle));
    return bridge(() => Bun.sleep(ms).then(() => null));
  });
  define("__host_done", (jsonHandle) => {
    finish(JSON.parse(ctx.getString(jsonHandle)) as Outcome);
    return undefined;
  });

  const evaluate = (code: string, filename: string): boolean => {
    const result = ctx.evalCode(code, filename);
    if (result.error) {
      const dumped = ctx.dump(result.error);
      result.error.dispose();
      fail(dumped);
      return false;
    }
    result.value.dispose();
    return true;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init = `globalThis.__swarm_shape = ${JSON.stringify(shape)};\nglobalThis.__swarm_args = ${JSON.stringify(args)};`;
    const ok =
      evaluate(init, "swarm-init.js") &&
      evaluate(SANDBOX_PRELUDE, "swarm-prelude.js") &&
      evaluate(bundle.code, BUNDLE_FILE) &&
      evaluate(SANDBOX_EPILOGUE, "swarm-epilogue.js");
    if (ok) drain();

    // The interrupt handler bounds synchronous code. This timer bounds the
    // whole run, including awaited host calls.
    const timeout = new Promise<Outcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            error: { name: "InternalError", message: "interrupted", stack: "" },
          }),
        Math.max(0, deadline - Date.now()),
      );
    });
    const outcome = await Promise.race([done, timeout]);

    if (outcome.ok) return output({ result: outcome.result, exitCode: 0 });
    const error = classify(outcome.error);
    if (error === "timeout") {
      stderr.append(`Script exceeded its ${job.resources.wallClockMs} ms wall-clock limit\n`);
      return output({ result: undefined, exitCode: TIMEOUT_EXIT_CODE, error });
    }
    const runtimeError = structuredError(outcome.error, bundle.map);
    stderr.append(errorStderr(runtimeError));
    return output({ result: undefined, exitCode: 1, error, runtimeError });
  } finally {
    alive = false;
    clearTimeout(timer);
    for (const deferred of pending) deferred.dispose();
    try {
      ctx.dispose();
      runtime.dispose();
    } catch (error) {
      console.warn("[scripts-runtime] quickjs teardown failed:", errorPayload(error).message);
    }
  }
}
