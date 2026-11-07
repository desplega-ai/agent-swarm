import { createLogEntry, getDbClient } from "../be/db";
import { getScript } from "../be/scripts/db";
import { runSavedScriptAsAgent } from "../be/scripts/run-saved";
import type { AgentTask, ScriptRecord } from "../types";
import {
  isFollowUpGateScheduleId,
  parseFollowUpGateScheduleIds,
} from "../utils/follow-up-gate-schedule-ids";
import { scrubSecrets } from "../utils/secret-scrubber";

/**
 * Follow-up gate, shadow mode. When a gated scheduled run's Lead follow-up is
 * created, a configured verifier script checks the run after commit and the
 * server records whether the follow-up could have been skipped. Shadow mode
 * never skips or delays a follow-up.
 */

export const FOLLOW_UP_GATE_SHADOW_EVENT = "task_follow_up_gate_shadow" as const;

export type FollowUpGateConfig = {
  mode: "off" | "shadow";
  scheduleIds: ReadonlySet<string>;
  verifierScript: string;
};

export type GateIneligibleReason =
  | "mode_off"
  | "not_scheduled"
  | "schedule_not_gated"
  | "status_failed"
  | "follow_up_instructions";

/**
 * Read the gate config on every call so a `swarm_config` reload applies. Any
 * mode other than `shadow` reads as `off`, and malformed ids are ignored.
 */
export function readFollowUpGateConfig(env: NodeJS.ProcessEnv = process.env): FollowUpGateConfig {
  const mode = env.FOLLOW_UP_GATE_MODE?.trim().toLowerCase() === "shadow" ? "shadow" : "off";
  const scheduleIds = new Set(
    parseFollowUpGateScheduleIds(env.FOLLOW_UP_GATE_SCHEDULE_IDS)
      .filter(isFollowUpGateScheduleId)
      .map((id) => id.toLowerCase()),
  );
  return { mode, scheduleIds, verifierScript: env.FOLLOW_UP_GATE_VERIFIER_SCRIPT?.trim() ?? "" };
}

/** Pure decision on whether a follow-up's worker task may be verified. */
export function classifyFollowUpGate(input: {
  task: Pick<AgentTask, "scheduleId" | "followUpConfig">;
  status: "completed" | "failed";
  config: FollowUpGateConfig;
}): { eligible: true } | { eligible: false; reason: GateIneligibleReason } {
  const { task, status, config } = input;
  if (config.mode === "off") return { eligible: false, reason: "mode_off" };
  if (!task.scheduleId) return { eligible: false, reason: "not_scheduled" };
  if (!config.scheduleIds.has(task.scheduleId.toLowerCase())) {
    return { eligible: false, reason: "schedule_not_gated" };
  }
  if (status === "failed") return { eligible: false, reason: "status_failed" };
  if (task.followUpConfig?.onCompleted?.trim() || task.followUpConfig?.onFailed?.trim()) {
    return { eligible: false, reason: "follow_up_instructions" };
  }
  return { eligible: true };
}

type VerifierScript = Pick<ScriptRecord, "name" | "version" | "contentHash">;

export type FollowUpGateDeps = {
  /** Resolve the global verifier script, or null when it does not exist. */
  getVerifier: (name: string) => Promise<VerifierScript | null>;
  /** Run the verifier as `agentId` and return its result, or throw. */
  runVerifier: (
    script: VerifierScript,
    input: { taskId: string },
    agentId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

const FOLLOW_UP_GATE_TIMEOUT_MS = 60_000;
const FOLLOW_UP_GATE_MAX_IN_FLIGHT = 2;
const TEXT_LIMIT = 300;
const MAX_UNVERIFIED = 20;

const defaultDeps: FollowUpGateDeps = {
  getVerifier: (name) => getScript({ name, scope: "global" }),
  runVerifier: async (script, input, agentId, signal) => {
    const output = await runSavedScriptAsAgent({
      script: script as ScriptRecord,
      input,
      agentId,
      timeoutMs,
      signal,
    });
    if (output.exitCode !== 0 || output.error || output.runtimeError) {
      throw new Error(
        output.runtimeError?.message ??
          output.error ??
          `script exited with code ${output.exitCode}`,
      );
    }
    return output.result;
  },
};

let timeoutMs = FOLLOW_UP_GATE_TIMEOUT_MS;
let depsForTests: FollowUpGateDeps | null = null;
let inFlight = 0;
const pending = new Set<Promise<void>>();

/** Replace the verifier lookup and runner. `null` restores the defaults. */
export function setFollowUpGateDepsForTests(deps: FollowUpGateDeps | null): void {
  depsForTests = deps;
}

/** Override the verifier deadline. `null` restores the 60s default. */
export function setFollowUpGateTimeoutMsForTests(ms: number | null): void {
  timeoutMs = ms ?? FOLLOW_UP_GATE_TIMEOUT_MS;
}

/** Wait until every scheduled shadow hook has written its row. */
export async function drainFollowUpGateShadowForTest(): Promise<void> {
  // Hooks run in FIFO order behind the client lock, so once this marker runs,
  // every earlier hook has started and registered its promise.
  await new Promise<void>((resolve) => getDbClient().afterCommit(resolve));
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

type ShadowArgs = {
  task: Pick<AgentTask, "id" | "scheduleId" | "followUpConfig">;
  status: "completed" | "failed";
  followUpTaskId: string;
  leadAgentId: string;
};

type ShadowRecord = {
  decision: "would_skip" | "would_keep" | "error" | "ineligible";
  reason: string | null;
  verdict?: { ok: boolean | null; check: string | null; detail: string; controlsOk: boolean };
  unverified?: string[];
  verifier?: VerifierScript | null;
  latencyMs?: number | null;
  error?: string;
};

/**
 * Record a shadow gate decision for a just-created follow-up. Returns
 * synchronously: all work, including the row write, runs after commit. With
 * the gate off or the schedule not gated, nothing is registered.
 */
export function scheduleFollowUpGateShadow(args: ShadowArgs): void {
  const config = readFollowUpGateConfig();
  const verdict = classifyFollowUpGate({ task: args.task, status: args.status, config });
  if (
    !verdict.eligible &&
    (verdict.reason === "mode_off" ||
      verdict.reason === "not_scheduled" ||
      verdict.reason === "schedule_not_gated")
  ) {
    return;
  }
  const deps = depsForTests ?? defaultDeps;
  getDbClient().afterCommit(() => {
    const run = verdict.eligible
      ? runShadow(args, config, deps)
      : writeRecord(args, { decision: "ineligible", reason: verdict.reason });
    pending.add(run);
    const settle = () => {
      pending.delete(run);
    };
    void run.then(settle, settle);
  });
}

async function runShadow(
  args: ShadowArgs,
  config: FollowUpGateConfig,
  deps: FollowUpGateDeps,
): Promise<void> {
  if (inFlight >= FOLLOW_UP_GATE_MAX_IN_FLIGHT) {
    await writeRecord(args, { decision: "error", reason: "concurrency_cap" });
    return;
  }
  inFlight++;
  try {
    await writeRecord(args, await verify(args, config, deps));
  } finally {
    inFlight--;
  }
}

async function verify(
  args: ShadowArgs,
  config: FollowUpGateConfig,
  deps: FollowUpGateDeps,
): Promise<ShadowRecord> {
  if (!config.verifierScript) return { decision: "error", reason: "no_verifier" };
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  const controller = new AbortController();
  const deadlineMs = timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let script: VerifierScript | null = null;
  let timedOut = false;
  try {
    const run = (async () => {
      script = await deps.getVerifier(config.verifierScript);
      if (!script) return null;
      return {
        result: await deps.runVerifier(
          script,
          { taskId: args.task.id },
          args.leadAgentId,
          controller.signal,
        ),
      };
    })();
    // A run that settles after the deadline must not surface as an unhandled rejection.
    run.catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`verifier timed out after ${deadlineMs}ms`));
      }, deadlineMs);
    });
    const outcome = await Promise.race([run, deadline]);
    const verifier = verifierInfo(script);
    if (!outcome) {
      return { decision: "error", reason: "no_verifier", verifier, latencyMs: latency() };
    }
    const result = outcome.result;
    if (!result || typeof result !== "object") {
      return {
        decision: "error",
        reason: "verifier_error",
        verifier,
        latencyMs: latency(),
        error: "verifier result is not an object",
      };
    }
    return { ...mapVerdict(result as Record<string, unknown>), verifier, latencyMs: latency() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: "error",
      reason: timedOut ? "timeout" : "verifier_error",
      verifier: verifierInfo(script),
      latencyMs: latency(),
      error: clip(message),
    };
  } finally {
    clearTimeout(timer);
  }
}

function verifierInfo(script: VerifierScript | null): VerifierScript | null {
  return script
    ? { name: script.name, version: script.version, contentHash: script.contentHash }
    : null;
}

/** `ok:true` with passing controls is `would_skip`; anything else keeps the follow-up. */
function mapVerdict(result: Record<string, unknown>): ShadowRecord {
  const ok = typeof result.ok === "boolean" ? result.ok : null;
  const controls = result.controls as { ok?: unknown } | null | undefined;
  const controlsOk = controls?.ok === true;
  const unverified = Array.isArray(result.unverified)
    ? result.unverified
        .filter((name): name is string => typeof name === "string")
        .slice(0, MAX_UNVERIFIED)
        .map((name) => name.slice(0, 100))
    : [];
  return {
    decision: ok === true && controlsOk ? "would_skip" : "would_keep",
    reason: null,
    verdict: {
      ok,
      check: typeof result.check === "string" ? result.check.slice(0, 100) : null,
      detail: typeof result.detail === "string" ? clip(result.detail) : "",
      controlsOk,
    },
    unverified,
  };
}

function clip(text: string): string {
  return scrubSecrets(text).slice(0, TEXT_LIMIT);
}

async function writeRecord(args: ShadowArgs, record: ShadowRecord): Promise<void> {
  try {
    await createLogEntry({
      eventType: FOLLOW_UP_GATE_SHADOW_EVENT,
      taskId: args.task.id,
      agentId: args.leadAgentId,
      metadata: {
        v: 1,
        mode: "shadow",
        followUpTaskId: args.followUpTaskId,
        scheduleId: args.task.scheduleId ?? null,
        status: args.status,
        decision: record.decision,
        reason: record.reason,
        verdict: record.verdict ?? null,
        unverified: record.unverified ?? [],
        verifier: record.verifier ?? null,
        latencyMs: record.latencyMs ?? null,
        ...(record.error ? { error: record.error } : {}),
      },
    });
  } catch (err) {
    console.warn(
      `[follow-up-gate] Could not record shadow decision for task ${args.task.id.slice(0, 8)}:`,
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    );
  }
}
