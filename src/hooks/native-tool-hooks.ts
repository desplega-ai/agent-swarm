/**
 * Worker shim for harness-native tool calls (bash, read, write, edit, ...).
 *
 * Every harness reports its own built-in tool calls to `POST /api/tool-hooks`, where
 * extensions whose manifest lists `toolSources: ["native"]` can observe, block or rewrite
 * them. One module serves all four harnesses (claude and codex run it per hook process, pi
 * and opencode run it in-process); each harness only maps its own event to a `NativeCall`
 * and applies the `NativeDecision`.
 *
 * Contract, in order of importance:
 * - Fail open. An API that is down, slow (2 s) or answers non-2xx lets the call run.
 * - Skip the round trip when no enabled extension takes native calls: a cached
 *   `GET /api/tool-hooks/status` answer (30 s) gates everything else.
 * - Scrub arguments worker-side before they leave the process. The server scrubs again, but
 *   only knows its own env; a worker holds per-task credentials the server never sees.
 * - Talk HTTP only. Never import the DB layer.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubObject } from "../utils/secret-scrubber";

const REQUEST_TIMEOUT_MS = 2_000;
const STATUS_TTL_MS = 30_000;
/** After a failed status read: stay quiet this long so a dead API costs one timeout, not one per call. */
const STATUS_FAILURE_TTL_MS = 10_000;

export interface NativeHookTarget {
  apiUrl: string;
  /** Authorization and X-Agent-ID, as the rest of the worker sends them. */
  headers: Record<string, string>;
  /** The running task, forwarded as `X-Source-Task-ID` so an extension run points at it. */
  taskId?: string;
}

export interface NativeCall {
  harness: "claude" | "codex" | "pi" | "opencode";
  /** Canonical name: `bash`, `read`, `write`, `edit`, otherwise the harness name, lowercased. */
  tool: string;
  /** The harness's own tool name, such as `Bash`. */
  nativeTool: string;
  args: Record<string, unknown>;
  rawArgs: unknown;
  toolCallId?: string;
}

export type NativeDecision =
  | { action: "continue" }
  | { action: "modify"; args: Record<string, unknown> }
  | { action: "block"; reason: string };

const CONTINUE: NativeDecision = { action: "continue" };

const CANONICAL_NAMES: Record<string, string> = {
  bash: "bash",
  shell: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
};

/** Canonical tool name: the four shared ones are the same on every harness. */
export function canonicalToolName(nativeTool: string): string {
  const lower = nativeTool.toLowerCase();
  return CANONICAL_NAMES[lower] ?? lower;
}

/**
 * Canonical args are the harness's own keys with Claude's `file_path` renamed `path`, the key
 * pi and opencode already use.
 * shortcut: no per-tool schema (edit shapes still differ per harness), upgrade when an
 * extension needs to treat an edit identically across harnesses.
 */
export function canonicalArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const { file_path, ...rest } = raw as Record<string, unknown>;
  return file_path === undefined ? rest : { ...rest, path: file_path };
}

/** Back to the harness's key names, so a rewritten `path` reaches a tool that reads `file_path`. */
export function rawArgsFromCanonical(args: Record<string, unknown>, raw: unknown): unknown {
  const usesFilePath = typeof raw === "object" && raw !== null && "file_path" in raw;
  if (!usesFilePath || args.path === undefined) return args;
  const { path, ...rest } = args;
  return { ...rest, file_path: path };
}

function cacheKey(target: NativeHookTarget): string {
  return createHash("sha256")
    .update(`${target.apiUrl}\n${target.headers["X-Agent-ID"] ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

interface StatusEntry {
  native: boolean;
  /** When this answer stops being trusted. */
  until: number;
}

const memoryStatus = new Map<string, StatusEntry>();

function readStatusFile(path: string): StatusEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StatusEntry>;
    if (typeof parsed.native === "boolean" && typeof parsed.until === "number") {
      return { native: parsed.native, until: parsed.until };
    }
  } catch {
    // No file, or a half-written one: read the API instead.
  }
  return undefined;
}

/**
 * Whether any enabled extension takes native tool calls. The claude and codex hooks are a new
 * process per call, so the answer lives in a small file under the temp dir as well as in memory.
 */
export async function nativeHooksActive(
  target: NativeHookTarget,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<boolean> {
  const key = cacheKey(target);
  const file = join(tmpdir(), `agent-swarm-native-hooks-${key}.json`);
  const cached = memoryStatus.get(key) ?? readStatusFile(file);
  if (cached && cached.until > now()) return cached.native;

  let entry: StatusEntry;
  try {
    const response = await fetchImpl(`${target.apiUrl}/api/tool-hooks/status`, {
      headers: target.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as { native?: unknown };
    entry = { native: body.native === true, until: now() + STATUS_TTL_MS };
  } catch {
    entry = { native: false, until: now() + STATUS_FAILURE_TTL_MS };
  }
  memoryStatus.set(key, entry);
  try {
    writeFileSync(file, JSON.stringify(entry));
  } catch {
    // An unwritable temp dir only costs the cache.
  }
  return entry.native;
}

/** Drop the cached answers. Tests and e2e runs that flip an extension need a fresh read. */
export function resetNativeHookCache(): void {
  memoryStatus.clear();
}

function postHeaders(target: NativeHookTarget): Record<string, string> {
  return {
    ...target.headers,
    "Content-Type": "application/json",
    ...(target.taskId ? { "X-Source-Task-ID": target.taskId } : {}),
  };
}

function wireBody(call: NativeCall) {
  return scrubObject({
    harness: call.harness,
    tool: call.tool,
    nativeTool: call.nativeTool,
    args: call.args,
    rawArgs: call.rawArgs,
    ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
  });
}

/**
 * Ask the extensions about a native call before it runs. Returns `continue` when no extension
 * takes native calls (no request is made), unless one blocked or rewrote it; any failure is
 * `continue`. A body over the route's 2 MB limit is refused with a 4xx and so is not intercepted.
 */
export async function runNativePre(
  target: NativeHookTarget,
  call: NativeCall,
  fetchImpl: typeof fetch = fetch,
): Promise<NativeDecision> {
  if (!(await nativeHooksActive(target, fetchImpl))) return CONTINUE;
  try {
    const response = await fetchImpl(`${target.apiUrl}/api/tool-hooks`, {
      method: "POST",
      headers: postHeaders(target),
      body: JSON.stringify({ phase: "pre", ...wireBody(call) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return CONTINUE;
    const decision = (await response.json()) as Record<string, unknown>;
    if (decision.action === "block" && typeof decision.reason === "string") {
      return { action: "block", reason: decision.reason };
    }
    if (decision.action === "modify") {
      const args = decision.args;
      if (typeof args === "object" && args !== null && !Array.isArray(args)) {
        return { action: "modify", args: args as Record<string, unknown> };
      }
    }
  } catch {
    // Fail open.
  }
  return CONTINUE;
}

const MAX_RESULT_CHARS = 64_000;

/** A tool result can be megabytes; an observer needs the head of it, not all of it. */
function clipResult(result: unknown): unknown {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text === undefined || text.length <= MAX_RESULT_CHARS) return result;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [clipped, ${text.length} chars]`;
}

/** Report a finished native call. Observe-only: the answer is 202 and nothing can change. */
export async function runNativePost(
  target: NativeHookTarget,
  call: NativeCall,
  outcome: { result: unknown; isError?: boolean; durationMs: number },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!(await nativeHooksActive(target, fetchImpl))) return;
  try {
    await fetchImpl(`${target.apiUrl}/api/tool-hooks`, {
      method: "POST",
      headers: postHeaders(target),
      body: JSON.stringify({
        phase: "post",
        ...wireBody(call),
        ...scrubObject({ result: clipResult(outcome.result) }),
        ...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
        durationMs: Math.max(0, outcome.durationMs),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Fail open.
  }
}
