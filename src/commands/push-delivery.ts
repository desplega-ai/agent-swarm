import type { WorkerRealtimeClient } from "../realtime/worker-client";
import type { DeliveryMode, WorkerNudge } from "../types";
import { parseEnvFlag } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";

export function resolveWorkerDeliveryMode(
  serverMode: DeliveryMode | undefined,
  isLead: boolean,
  env: NodeJS.ProcessEnv = process.env,
): DeliveryMode {
  const mode =
    env.SWARM_DELIVERY_MODE === "push" || env.SWARM_DELIVERY_MODE === "poll"
      ? env.SWARM_DELIVERY_MODE
      : (serverMode ?? "poll");
  if (mode === "push" && isLead && parseEnvFlag(env.LEAD_MONITOR_CHANNELS, false)) {
    console.warn(
      scrubSecrets("[runner] LEAD_MONITOR_CHANNELS requires poll delivery. Using poll."),
    );
    return "poll";
  }
  return mode;
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
      this.fallback = false;
    } else {
      if (mode === "push" && now - this.client.disconnectedSince() > 60_000 && !this.fallback) {
        this.fallback = true;
        console.warn(
          scrubSecrets(
            "[runner] Push socket unavailable for 60 seconds. Using poll until reconnect.",
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
