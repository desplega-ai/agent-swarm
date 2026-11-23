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
 * Follow-up gate. In shadow mode, when a gated scheduled run's Lead follow-up
 * is created, a configured verifier script checks the run after commit and the
 * server records whether the follow-up could have been skipped. Shadow mode
 * never skips or delays a follow-up.
 *
 * Enforce mode keeps shadow for `FOLLOW_UP_GATE_SCHEDULE_IDS`. For a schedule
 * in `FOLLOW_UP_GATE_ENFORCE_SCHEDULE_IDS`, the follow-up waits for the
 * verifier: `would_skip` skips it, any other outcome creates it (fail open).
 */

export const FOLLOW_UP_GATE_SHADOW_EVENT = "task_follow_up_gate_shadow" as const;

export type FollowUpGateConfig = {
  mode: "off" | "shadow" | "enforce";
  scheduleIds: ReadonlySet<string>;
  /** Empty unless mode is `enforce`. */
  enforceScheduleIds: ReadonlySet<string>;
  verifierScript: string;
};

export type GateIneligibleReason =
  | "mode_off"
  | "not_scheduled"
  | "schedule_not_gated"
  | "status_failed"
  | "follow_up_instructions"
  | "chain_rejected";

function scheduleIdSet(raw: string | undefined): Set<string> {
  return new Set(
    parseFollowUpGateScheduleIds(raw)
      .filter(isFollowUpGateScheduleId)
      .map((id) => id.toLowerCase()),
  );
}

/**
 * Read the gate config on every call so a `swarm_config` reload applies. Any
 * mode other than `shadow` or `enforce` reads as `off`, and malformed ids are
 * ignored.
 */
export function readFollowUpGateConfig(env: NodeJS.ProcessEnv = process.env): FollowUpGateConfig {
  const raw = env.FOLLOW_UP_GATE_MODE?.trim().toLowerCase();
  const mode = raw === "shadow" || raw === "enforce" ? raw : "off";
  return {
    mode,
    scheduleIds: scheduleIdSet(env.FOLLOW_UP_GATE_SCHEDULE_IDS),
    enforceScheduleIds:
      mode === "enforce" ? scheduleIdSet(env.FOLLOW_UP_GATE_ENFORCE_SCHEDULE_IDS) : new Set(),
    verifierScript: env.FOLLOW_UP_GATE_VERIFIER_SCRIPT?.trim() ?? "",
  };
}

/** Pure decision on whether a follow-up's worker task may be verified. */
export function classifyFollowUpGate(input: {
  task: Pick<AgentTask, "scheduleId" | "followUpConfig">;
  status: "completed" | "failed";
  config: FollowUpGateConfig;
  /** The completion named a `chainedTaskId` that was rejected. */
  chainRejected?: boolean;
}): { eligible: true } | { eligible: false; reason: GateIneligibleReason } {
  const { task, status, config } = input;
  if (config.mode === "off") return { eligible: false, reason: "mode_off" };
  if (!task.scheduleId) return { eligible: false, reason: "not_scheduled" };
  const scheduleId = task.scheduleId.toLowerCase();
  if (!config.scheduleIds.has(scheduleId) && !config.enforceScheduleIds.has(scheduleId)) {
    return { eligible: false, reason: "schedule_not_gated" };
  }
  if (status === "failed") return { eligible: false, reason: "status_failed" };
  if (task.followUpConfig?.onCompleted?.trim() || task.followUpConfig?.onFailed?.trim()) {
    return { eligible: false, reason: "follow_up_instructions" };
  }
  // The rejected-handoff warning lives only in the follow-up, so keep it.
  if (input.chainRejected) return { eligible: false, reason: "chain_rejected" };
  return { eligible: true };
}

/** Whether this run's follow-up waits for the verifier and is skipped on `would_skip`. */
export function isFollowUpGateEnforced(input: Parameters<typeof classifyFollowUpGate>[0]): boolean {
  return (
    classifyFollowUpGate(input).eligible &&
    input.config.enforceScheduleIds.has(input.task.scheduleId?.toLowerCase() ?? "")
  );
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

/** Wait until every scheduled shadow or enforce hook has written its row. */
export async function drainFollowUpGateShadowForTest(): Promise<void> {
  // Hooks run in FIFO order behind the client lock, so once this marker runs,
  // every earlier hook has started and registered its promise.
  await new Promise<void>((resolve) => getDbClient().afterCommit(resolve));
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

type GateArgs = {
  task: Pick<AgentTask, "id" | "scheduleId" | "followUpConfig">;
  status: "completed" | "failed";
  leadAgentId: string;
  chainRejected?: boolean;
};

type ShadowArgs = GateArgs & { followUpTaskId: string };

type EnforceArgs = GateArgs & {
  config: FollowUpGateConfig;
  /** Create the Lead follow-up; called unless the verdict is `would_skip`. */
  createFollowUp: () => Promise<AgentTask | null>;
};

/** Where the follow-up stands when the row is written. */
type GateOutcome =
  | { mode: "shadow"; followUpTaskId: string }
  | { mode: "enforce"; followUpTaskId: string | null; skipped: boolean };

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
  const verdict = classifyFollowUpGate({
    task: args.task,
    status: args.status,
    config,
    chainRejected: args.chainRejected,
  });
  if (
    !verdict.eligible &&
    (verdict.reason === "mode_off" ||
      verdict.reason === "not_scheduled" ||
      verdict.reason === "schedule_not_gated")
  ) {
    return;
  }
  const deps = depsForTests ?? defaultDeps;
  // An enforced schedule reaches here only when ineligible: its follow-up was created up front.
  const outcome: GateOutcome = config.enforceScheduleIds.has(
    args.task.scheduleId?.toLowerCase() ?? "",
  )
    ? { mode: "enforce", followUpTaskId: args.followUpTaskId, skipped: false }
    : { mode: "shadow", followUpTaskId: args.followUpTaskId };
  getDbClient().afterCommit(() =>
    track(
      verdict.eligible
        ? verifyCapped(args, config, deps).then((record) => writeRecord(args, record, outcome))
        : writeRecord(args, { decision: "ineligible", reason: verdict.reason }, outcome),
    ),
  );
}

/**
 * Enforce the gate for a run that `isFollowUpGateEnforced` accepted. Returns
 * synchronously; after commit the verifier runs, and the follow-up is created
 * unless the verdict is `would_skip`. Errors, timeouts, the concurrency cap and
 * a missing verifier all create it.
 *
 * shortcut: a server restart while the verifier runs (up to 60s) drops the
 * follow-up; add a boot sweep for unrecorded enforced runs if that shows up.
 */
export function scheduleFollowUpGateEnforce(args: EnforceArgs): void {
  const deps = depsForTests ?? defaultDeps;
  getDbClient().afterCommit(() => track(runEnforce(args, deps)));
}

async function runEnforce(args: EnforceArgs, deps: FollowUpGateDeps): Promise<void> {
  const record = await verifyCapped(args, args.config, deps);
  if (record.decision === "would_skip") {
    await writeRecord(args, record, { mode: "enforce", followUpTaskId: null, skipped: true });
    try {
      await createLogEntry({
        eventType: "task_follow_up_suppressed",
        taskId: args.task.id,
        agentId: args.leadAgentId,
        metadata: { reason: "follow_up_gate", status: args.status },
      });
    } catch {}
    return;
  }
  let followUpTaskId: string | null = null;
  try {
    followUpTaskId = (await args.createFollowUp())?.id ?? null;
  } catch (err) {
    console.warn(
      `[follow-up-gate] Could not create follow-up for task ${args.task.id.slice(0, 8)}:`,
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    );
  }
  await writeRecord(args, record, { mode: "enforce", followUpTaskId, skipped: false });
}

function track(run: Promise<void>): void {
  pending.add(run);
  const settle = () => {
    pending.delete(run);
  };
  void run.then(settle, settle);
}

async function verifyCapped(
  args: GateArgs,
  config: FollowUpGateConfig,
  deps: FollowUpGateDeps,
): Promise<ShadowRecord> {
  if (inFlight >= FOLLOW_UP_GATE_MAX_IN_FLIGHT) {
    return { decision: "error", reason: "concurrency_cap" };
  }
  inFlight++;
  try {
    return await verify(args, config, deps);
  } finally {
    inFlight--;
  }
}

async function verify(
  args: GateArgs,
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

async function writeRecord(
  args: GateArgs,
  record: ShadowRecord,
  outcome: GateOutcome,
): Promise<void> {
  try {
    await createLogEntry({
      eventType: FOLLOW_UP_GATE_SHADOW_EVENT,
      taskId: args.task.id,
      agentId: args.leadAgentId,
      metadata: {
        v: 1,
        mode: outcome.mode,
        followUpTaskId: outcome.followUpTaskId,
        ...(outcome.mode === "enforce" ? { skipped: outcome.skipped } : {}),
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
      `[follow-up-gate] Could not record ${outcome.mode} decision for task ${args.task.id.slice(0, 8)}:`,
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    );
  }
}
