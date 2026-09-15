import { isInTransaction } from "../be/db-client";
import { insertExtensionRun, recordExtensionFailure, setExtensionState } from "../be/extensions/db";
import { grantLeadEquivalence, revokeLeadEquivalence } from "../rbac/elevated-agents";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { SwarmEventMap } from "./contract";
import { buildCtx } from "./ctx";
import type { ExtensionHandler, LoadedExtension } from "./loader";

type PreEventName = Extract<keyof SwarmEventMap, `pre.${string}`>;
type PostEventName = Extract<keyof SwarmEventMap, `post.${string}`>;
type DispatchOptions = { skipExtensionId?: string };
type PreDispatchOptions<E extends PreEventName> = DispatchOptions & {
  /** Boundary-specific reshaping of a modify result (runs before validateModify). */
  transformModify?: (args: {
    data: Record<string, unknown>;
    currentPayload: Record<string, unknown>;
    extension: { id: string; name: string; version: number };
  }) => Record<string, unknown>;
  /** Boundary-specific schema check of a modify result; a failure is attributed to the extension. */
  validateModify?: (
    data: SwarmEventMap[E]["modify"],
  ) =>
    | { success: true; data: SwarmEventMap[E]["modify"] }
    | { success: false; error: unknown }
    | Promise<
        { success: true; data: SwarmEventMap[E]["modify"] } | { success: false; error: unknown }
      >;
};

export type PreDispatchResult<E extends PreEventName> =
  | { action: "continue" }
  | { action: "modify"; data: SwarmEventMap[E]["modify"] }
  | {
      action: "block";
      reason: string;
      extension: { id: string; name: string };
    };

const registry = new Map<string, LoadedExtension>();
const extensionAgentIds = new Set<string>();
const extensionByAgent = new Map<string, string>();

export class ExtensionAbortedError extends Error {
  constructor() {
    super("Extension handler is aborted or unregistered");
    this.name = "ExtensionAbortedError";
  }
}

export function isRegistered(id: string): boolean {
  return registry.has(id);
}

export function isExtensionAgentId(agentId: string | null | undefined): boolean {
  return !!agentId && extensionAgentIds.has(agentId);
}

/**
 * Per-process secret that authenticates extension-originated loopback calls. Only the
 * in-process `ctx.swarm` SDK holds it; the bridge grants `callOrigin: "extension"` solely
 * when the request presents it, so an agent header alone can never claim that origin.
 */
const extensionBridgeToken = crypto.randomUUID();

export function getExtensionBridgeToken(): string {
  return extensionBridgeToken;
}

/** Resolve the bridge call origin from the agent identity plus the per-process token. */
export function resolveBridgeCallOrigin(
  agentId: string | undefined,
  token: string | undefined,
): "extension" | "script-sdk" {
  return isExtensionAgentId(agentId) && token === extensionBridgeToken ? "extension" : "script-sdk";
}

export function extensionIdForAgent(agentId: string | null | undefined): string | undefined {
  return agentId && isExtensionAgentId(agentId) ? extensionByAgent.get(agentId) : undefined;
}

class ExtensionTimeoutError extends Error {
  constructor() {
    super("Extension handler timed out");
    this.name = "ExtensionTimeoutError";
  }
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function handlersFor(event: keyof SwarmEventMap, opts?: DispatchOptions) {
  return [...registry.values()]
    .filter((loaded) => loaded.record.id !== opts?.skipExtensionId)
    .flatMap((loaded) =>
      loaded.handlers
        .filter((handler) => handler.event === event)
        .map((handler) => ({ loaded, handler })),
    )
    .sort(
      (a, b) =>
        a.handler.priority - b.handler.priority ||
        a.loaded.record.name.localeCompare(b.loaded.record.name),
    );
}

type RunContext = { agentId: string | null; subject: string | null };

function snippet(text: unknown, max = 80): string {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Who and what a run row refers to, so the run log can say which agent was
 * blocked and on what. Never stores the full payload: subjects are short and
 * secret-scrubbed.
 */
export function runContext(event: keyof SwarmEventMap, payload: unknown): RunContext {
  const p = (payload ?? {}) as Record<string, any>;
  const requestAgent = typeof p.requestInfo?.agentId === "string" ? p.requestInfo.agentId : null;
  let agentId: string | null = null;
  let subject: string | null = null;
  switch (event) {
    case "pre.tool.call":
    case "post.tool.call":
      agentId = requestAgent;
      subject = `tool ${p.tool}`;
      break;
    case "pre.task.create":
      agentId = requestAgent ?? (typeof p.options?.agentId === "string" ? p.options.agentId : null);
      subject = `${p.origin}: ${snippet(p.description)}`;
      break;
    case "pre.task.followUp":
      agentId = typeof p.workerAgentId === "string" ? p.workerAgentId : null;
      subject = `task ${p.completedTask?.id} ${p.status}`;
      break;
    case "pre.slack.route":
    case "post.slack.message":
      subject = `channel ${p.channelId}: ${snippet(p.text, 60)}`;
      break;
    case "pre.heartbeat.remediate":
      agentId = typeof p.task?.agentId === "string" ? p.task.agentId : null;
      subject = `task ${p.task?.id} ${p.classification} -> ${p.proposedAction}`;
      break;
    default:
      agentId = typeof p.task?.agentId === "string" ? p.task.agentId : null;
      subject = p.task?.id ? `task ${p.task.id}: ${snippet(p.task.task)}` : null;
  }
  return { agentId, subject: subject ? scrubSecrets(subject) : null };
}

async function writeRun(
  loaded: LoadedExtension,
  event: keyof SwarmEventMap,
  action: "continue" | "modify" | "block" | "error" | "timeout",
  durationMs: number,
  message?: string,
  context?: RunContext,
): Promise<void> {
  try {
    await insertExtensionRun({
      extensionId: loaded.record.id,
      version: loaded.record.activeVersion,
      event,
      action,
      durationMs,
      message: message ?? null,
      agentId: context?.agentId ?? null,
      subject: context?.subject ?? null,
    });
  } catch (error) {
    console.error(
      "[extensions] Failed to store handler run:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

async function markSuccess(loaded: LoadedExtension): Promise<void> {
  if (loaded.record.consecutiveFailures === 0 && loaded.record.lastError === null) return;
  try {
    const next = await setExtensionState(loaded.record.id, {
      consecutiveFailures: 0,
      lastError: null,
    });
    if (next) loaded.record = next;
  } catch (error) {
    console.error(
      "[extensions] Failed to reset failure count:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

async function markFailure(
  loaded: LoadedExtension,
  event: keyof SwarmEventMap,
  error: unknown,
  durationMs: number,
  payload?: unknown,
): Promise<void> {
  const timedOut = error instanceof ExtensionTimeoutError;
  const message = scrubSecrets(error instanceof Error ? error.message : String(error));
  await writeRun(
    loaded,
    event,
    timedOut ? "timeout" : "error",
    durationMs,
    message,
    runContext(event, payload),
  );
  try {
    const next = await recordExtensionFailure(
      loaded.record.id,
      message,
      positiveEnv("EXTENSION_MAX_CONSECUTIVE_FAILURES", 5),
    );
    if (!next) return;
    loaded.record = next;
    if (next.status === "auto-disabled") {
      unregister(next.id);
      await loaded.dispose();
    }
  } catch (persistError) {
    console.error(
      "[extensions] Failed to update failure count:",
      scrubSecrets(persistError instanceof Error ? persistError.message : String(persistError)),
    );
  }
}

async function runHandler(
  loaded: LoadedExtension,
  handler: ExtensionHandler,
  event: keyof SwarmEventMap,
  payload: unknown,
): Promise<{ ok: true; result: unknown; durationMs: number } | { ok: false }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => {
          controller.abort();
          reject(new ExtensionTimeoutError());
        },
        positiveEnv("EXTENSION_HANDLER_TIMEOUT_MS", 5_000),
      );
      timeout.unref?.();
    });
    const result = await Promise.race([
      Promise.resolve().then(() =>
        handler.handler(payload as never, buildCtx(loaded, event, controller.signal)),
      ),
      timeoutPromise,
    ]);
    const durationMs = Date.now() - startedAt;
    return { ok: true, result, durationMs };
  } catch (error) {
    await markFailure(loaded, event, error, Date.now() - startedAt, payload);
    return { ok: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function definedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Extension modify result data must be an object");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined),
  );
}

function mergePayload(
  event: PreEventName,
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (event === "pre.task.create") {
    const { description, ...optionChanges } = data;
    return {
      ...payload,
      ...(description === undefined ? {} : { description }),
      options: {
        ...((payload.options as Record<string, unknown> | undefined) ?? {}),
        ...optionChanges,
      },
    };
  }
  if (event === "pre.task.followUp" && data.description !== undefined) {
    const { description, ...changes } = data;
    return { ...payload, ...changes, summary: description };
  }
  return { ...payload, ...data };
}

export function registerLoaded(loaded: LoadedExtension): void {
  unregister(loaded.record.id);
  registry.set(loaded.record.id, loaded);
  if (loaded.record.agentId) {
    extensionAgentIds.add(loaded.record.agentId);
    extensionByAgent.set(loaded.record.agentId, loaded.record.id);
    grantLeadEquivalence(loaded.record.agentId);
  }
}

export function unregister(extensionId: string): LoadedExtension | undefined {
  const loaded = registry.get(extensionId);
  registry.delete(extensionId);
  if (loaded?.record.agentId) {
    extensionAgentIds.delete(loaded.record.agentId);
    extensionByAgent.delete(loaded.record.agentId);
    revokeLeadEquivalence(loaded.record.agentId);
  }
  return loaded;
}

export function listRegistered(): LoadedExtension[] {
  return [...registry.values()];
}

export async function dispatchPre<E extends PreEventName>(
  event: E,
  payload: SwarmEventMap[E]["event"],
  opts?: PreDispatchOptions<E>,
): Promise<PreDispatchResult<E>> {
  if (isInTransaction()) {
    console.error("[extensions] pre dispatch inside transaction:", scrubSecrets(String(event)));
    return { action: "continue" };
  }

  let currentPayload = payload as unknown as Record<string, unknown>;
  let mergedData: Record<string, unknown> = {};
  let modified = false;
  for (const { loaded, handler } of handlersFor(event, opts)) {
    if (!isRegistered(loaded.record.id)) continue;
    const run = await runHandler(loaded, handler, event, currentPayload);
    if (!run.ok) continue;
    const result = run.result;
    if (
      result === undefined ||
      (typeof result === "object" &&
        result !== null &&
        (result as { action?: unknown }).action === "continue")
    ) {
      await markSuccess(loaded);
      await writeRun(
        loaded,
        event,
        "continue",
        run.durationMs,
        undefined,
        runContext(event, currentPayload),
      );
      continue;
    }
    if (typeof result !== "object" || result === null) {
      await markFailure(
        loaded,
        event,
        new Error("Extension pre handler returned an invalid result"),
        run.durationMs,
      );
      continue;
    }
    const preResult = result as { action?: unknown; data?: unknown; reason?: unknown };
    if (preResult.action === "block" && typeof preResult.reason === "string") {
      const reason = scrubSecrets(preResult.reason);
      await markSuccess(loaded);
      await writeRun(
        loaded,
        event,
        "block",
        run.durationMs,
        reason,
        runContext(event, currentPayload),
      );
      return {
        action: "block",
        reason,
        extension: { id: loaded.record.id, name: loaded.record.name },
      };
    }
    if (preResult.action === "modify") {
      try {
        let data = definedObject(preResult.data);
        if (opts?.transformModify) {
          data = opts.transformModify({
            data,
            currentPayload,
            extension: {
              id: loaded.record.id,
              name: loaded.record.name,
              version: loaded.record.activeVersion,
            },
          });
        }
        if (opts?.validateModify) {
          const validation = await opts.validateModify(data as SwarmEventMap[E]["modify"]);
          if (!validation.success) throw validation.error;
          data = definedObject(validation.data);
        }
        mergedData = { ...mergedData, ...data };
        currentPayload = mergePayload(event, currentPayload, data);
        modified = true;
        await markSuccess(loaded);
        await writeRun(
          loaded,
          event,
          "modify",
          run.durationMs,
          undefined,
          runContext(event, currentPayload),
        );
      } catch (error) {
        await markFailure(loaded, event, error, run.durationMs, currentPayload);
      }
      continue;
    }
    await markFailure(
      loaded,
      event,
      new Error("Extension pre handler returned an invalid result"),
      run.durationMs,
      currentPayload,
    );
  }

  return modified
    ? { action: "modify", data: mergedData as SwarmEventMap[E]["modify"] }
    : { action: "continue" };
}

// Bus events emit afterCommit, so post handlers observe committed state only.
// Post dispatch therefore needs no isInTransaction guard.
export async function dispatchPost<E extends PostEventName>(
  event: E,
  payload: SwarmEventMap[E]["event"],
  opts?: DispatchOptions,
): Promise<void> {
  for (const { loaded, handler } of handlersFor(event, opts)) {
    if (!isRegistered(loaded.record.id)) continue;
    const run = await runHandler(loaded, handler, event, payload);
    if (run.ok) {
      await markSuccess(loaded);
      await writeRun(
        loaded,
        event,
        "continue",
        run.durationMs,
        undefined,
        runContext(event, payload),
      );
    }
  }
}
