import type { WorkerRealtimeClient } from "../realtime/worker-client";
import type { DeliveryMode, WorkerNudge } from "../types";
import { isLeadChannelMonitoringEnabled } from "../utils/lead-monitor-channels";
import { scrubSecrets } from "../utils/secret-scrubber";

export function resolveWorkerDeliveryMode(
  serverMode: DeliveryMode | undefined,
  isLead: boolean,
  env: NodeJS.ProcessEnv = process.env,
  pollRequired = false,
): DeliveryMode {
  const mode =
    env.SWARM_DELIVERY_MODE === "push" || env.SWARM_DELIVERY_MODE === "poll"
      ? env.SWARM_DELIVERY_MODE
      : (serverMode ?? "poll");
  if (
    (mode === "push" || pollRequired) &&
    isLead &&
    (pollRequired || isLeadChannelMonitoringEnabled(env))
  ) {
    console.warn(
      scrubSecrets("[runner] LEAD_MONITOR_CHANNELS requires poll delivery. Using poll."),
    );
    return "poll";
  }
  return mode;
}

export interface WorkerRegistration {
  serverCapabilities?: string[];
  deliveryMode?: DeliveryMode;
  pollRequired?: boolean;
}

export function updateWorkerDeliveryMode(
  previousMode: DeliveryMode | undefined,
  registration: WorkerRegistration,
  isLead: boolean,
  env: NodeJS.ProcessEnv = process.env,
): DeliveryMode {
  const mode = resolveWorkerDeliveryMode(
    registration.deliveryMode,
    isLead,
    env,
    registration.pollRequired,
  );
  if (mode !== previousMode) {
    const override = env.SWARM_DELIVERY_MODE;
    const source =
      override === "poll" || override === "push"
        ? `SWARM_DELIVERY_MODE override: ${override}`
        : registration.deliveryMode
          ? `register response: ${registration.deliveryMode}`
          : "register response omitted deliveryMode, default: poll";
    const required =
      isLead && (registration.pollRequired || isLeadChannelMonitoringEnabled(env))
        ? ", LEAD_MONITOR_CHANNELS requires poll"
        : "";
    console.log(scrubSecrets(`[runner] Delivery mode: ${mode} (${source}${required}).`));
  }
  return mode;
}

type DeliveryChecks = ReturnType<RunnerPushDelivery["checks"]>;

export function taskReconciliation(checks: DeliveryChecks) {
  return {
    cancelTaskIds: checks.push && !checks.safety ? checks.cancelTaskIds : undefined,
    checkStatus: !checks.push || checks.safety,
  };
}

export function shouldRunDeliveryLoop(mode: DeliveryMode | undefined, shuttingDown: boolean) {
  return mode !== "push" || !shuttingDown;
}

export function deliverySchedule(options: {
  mode: DeliveryMode;
  push: boolean;
  work: boolean;
  activeCount: number;
  maxConcurrent: number;
  draining?: boolean;
  lastPushPingAt: number;
  pollInterval: number;
  now?: number;
}) {
  const blocked = options.draining || options.activeCount >= options.maxConcurrent;
  return {
    poll: !blocked && (!options.push || options.work),
    singlePoll: options.mode === "push",
    waitKind: options.push ? "push" : options.mode === "push" && !blocked ? "fallback" : "sleep",
    waitMs:
      blocked || (options.push && options.activeCount > 0)
        ? 1000
        : options.push
          ? Math.max(
              0,
              Math.min(
                resolvePushSafetyPollMs(),
                30_000 - ((options.now ?? Date.now()) - options.lastPushPingAt),
              ),
            )
          : options.pollInterval,
  };
}

export function resolvePushSafetyPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.RUNNER_PUSH_SAFETY_POLL_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

/** Coalesce nudges until the runner can fetch the corresponding server state. */
export class RunnerPushDelivery {
  private lastSafetyAt = -Infinity;
  private fallback = false;
  private work = true;
  private config = false;
  private readonly cancel = new Set<string>();
  private readonly steer = new Set<string>();

  constructor(readonly client: WorkerRealtimeClient) {
    client.onNudge((nudge) => this.receive(nudge));
  }

  private receive(nudge: WorkerNudge): void {
    if (nudge.kind === "work") this.work = true;
    if (nudge.kind === "config") this.config = true;
    if (nudge.kind === "cancel" && nudge.taskId) this.cancel.add(nudge.taskId);
    if (nudge.kind === "steer" && nudge.taskId) this.steer.add(nudge.taskId);
  }

  checks(mode: DeliveryMode, now = Date.now(), safetyMs = resolvePushSafetyPollMs()) {
    if (this.client.isConnected()) {
      if (this.fallback && mode === "push")
        console.log(scrubSecrets("[runner] Delivery mode: push (push socket reconnected)."));
      this.fallback = false;
    } else {
      if (mode === "push" && now - this.client.disconnectedSince() > 60_000 && !this.fallback) {
        this.fallback = true;
        console.warn(
          scrubSecrets(
            "[runner] Delivery mode: poll (push socket unavailable for 60 seconds). Using poll until reconnect.",
          ),
        );
      }
    }
    const push = mode === "push" && !this.fallback;
    const safety = push && now - this.lastSafetyAt >= safetyMs;
    if (safety) this.lastSafetyAt = now;
    if (safety) this.work = true;
    const checks = {
      push,
      safety,
      work: !push || this.work,
      config: !push || safety || this.config,
      cancelTaskIds: new Set(this.cancel),
      steerTaskIds: new Set(this.steer),
    };
    this.config = false;
    this.cancel.clear();
    this.steer.clear();
    return checks;
  }

  beginPoll(): void {
    this.work = false;
  }

  wakeWork(): void {
    this.work = true;
  }

  schedule(options: Omit<Parameters<typeof deliverySchedule>[0], "work">) {
    return deliverySchedule({ ...options, work: this.work });
  }

  dispatchSteering(checks: DeliveryChecks, taskId: string, dispatch: () => boolean): void {
    if (checks.push && !checks.safety && !checks.steerTaskIds.has(taskId)) return;
    if (!dispatch() && checks.push) this.steer.add(taskId);
  }

  async poll<T>(
    singlePoll: boolean,
    fetch: (onFailure: () => void) => Promise<T | null>,
  ): Promise<{ trigger: T | null; failed: boolean }> {
    if (singlePoll) this.beginPoll();
    let failed = false;
    const trigger = await fetch(() => {
      failed = true;
    });
    if (singlePoll && (failed || trigger)) this.wakeWork();
    return { trigger, failed };
  }

  async waitForSchedule(
    schedule: ReturnType<typeof deliverySchedule>,
    failed = false,
    pollInterval = 2000,
  ): Promise<void> {
    if (failed) {
      await Bun.sleep(pollInterval);
      return;
    }
    if (
      schedule.poll &&
      schedule.waitKind === "push" &&
      (this.work || this.config || this.cancel.size > 0 || this.steer.size > 0)
    )
      return;
    const timeout = schedule.waitMs;
    if (schedule.waitKind === "push") await this.wait(timeout);
    else if (schedule.waitKind === "fallback")
      await this.client.waitForNudge(["work", "cancel", "steer", "config"], timeout);
    else await Bun.sleep(timeout);
  }

  async wait(timeoutMs: number): Promise<void> {
    const now = Date.now();
    const untilSafety = this.lastSafetyAt + resolvePushSafetyPollMs() - now;
    const untilFallback =
      !this.client.isConnected() && !this.fallback
        ? this.client.disconnectedSince() + 60_001 - now
        : Infinity;
    await this.client.waitForNudge(
      ["work", "cancel", "steer", "config"],
      Math.max(0, Math.min(timeoutMs, untilSafety, untilFallback)),
    );
  }
}
